import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const REGISTRY_DESCRIPTOR_SCHEMA = "registry.descriptor/v1";
const SEMVER_PATTERN_SOURCE = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`;
const SEMVER_RE = new RegExp(`^${SEMVER_PATTERN_SOURCE}$`);
const INTERFACE_REF_RE = new RegExp(
  `^([a-z][a-z0-9-]*:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@(${SEMVER_PATTERN_SOURCE})@(stable|preview|experimental|deprecated)$`
);
const OCI_DIGEST_URI_RE = /^oci:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/;

export const LISTING_KINDS = Object.freeze([
  "provider",
  "resource-pack",
  "policy-pack",
  "agent-skill",
  "runbook",
  "hobo-code-module",
  "bindle",
  "camp",
  "yard",
  "junction"
]);

export const STABILITY_TIERS = Object.freeze([
  "stable",
  "preview",
  "experimental",
  "deprecated"
]);

export function createFixtureDescriptor({ kind = "provider" } = {}) {
  if (!LISTING_KINDS.includes(kind)) {
    throw new Error(`unknown fixture listing kind ${kind}`);
  }

  const safeKind = kind.replace(/-/g, ".");
  const interfaceRef = `hobo:${safeKind}/contract@1.0.0@stable`;
  const reportEvidence = conformanceReportRef(`${kind}-conformance-report`);

  return {
    schema: REGISTRY_DESCRIPTOR_SCHEMA,
    kind,
    name: `@acme/${kind}`,
    version: "1.2.3",
    artifact: artifactRef(`${kind}-artifact`, {
      mediaType: "application/vnd.hobo.registry.listing.layer.v1+json"
    }),
    publisher: {
      type: "organization",
      id: "acme",
      trustDomain: "spiffe://acme.example"
    },
    evidence: {
      slsaProvenanceRef: artifactRef(`${kind}-slsa-provenance`, {
        mediaType: "application/vnd.in-toto+json"
      }),
      conformanceReportRefs: [reportEvidence]
    },
    interfaces: {
      exports: [
        {
          ref: interfaceRef,
          conformanceSuite: "@hobo/conformance/registry-listing",
          conformanceSuiteVersion: "1.0.0",
          conformanceReportRef: reportEvidence.ref
        }
      ],
      imports: []
    }
  };
}

export function parseDescriptor(candidate) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["descriptor must be an object"], descriptor: null };
  }

  if (candidate.schema !== REGISTRY_DESCRIPTOR_SCHEMA) {
    errors.push(`schema must be ${REGISTRY_DESCRIPTOR_SCHEMA}`);
  }
  if (!LISTING_KINDS.includes(candidate.kind)) {
    errors.push(`unknown listing kind ${String(candidate.kind)}`);
  }
  if (!isNonEmptyString(candidate.name)) {
    errors.push("name must be a non-empty string");
  }
  if (!isSemver(candidate.version)) {
    errors.push(`version must be semver: ${String(candidate.version)}`);
  }

  validateArtifactRef(candidate.artifact, "artifact", errors);
  validateArtifactRef(candidate.evidence?.slsaProvenanceRef, "evidence.slsaProvenanceRef", errors);

  const conformanceReports = new Map();
  for (const [index, report] of Object.entries(candidate.evidence?.conformanceReportRefs ?? [])) {
    validateConformanceReportRef(report, `evidence.conformanceReportRefs.${index}`, errors);
    if (report?.ref?.digest) {
      conformanceReports.set(report.ref.digest, report);
    }
  }

  const parsedInterfaces = {
    exports: parseInterfaceDeclarations(candidate.interfaces?.exports, "interfaces.exports", errors),
    imports: parseInterfaceDeclarations(candidate.interfaces?.imports, "interfaces.imports", errors)
  };

  for (const [section, declarations] of Object.entries(candidate.interfaces ?? {})) {
    if (!Array.isArray(declarations)) continue;
    declarations.forEach((declaration, index) => {
      const path = `interfaces.${section}.${index}`;
      const interfaceTriple = parseInterfaceRef(declaration?.ref);
      const report = declaration?.conformanceReportRef;
      validateArtifactRef(report, `${path}.conformanceReportRef`, errors);

      const recorded = report?.digest ? conformanceReports.get(report.digest) : undefined;
      if (report?.digest && !recorded) {
        errors.push(`${path}.conformanceReportRef must be listed in evidence.conformanceReportRefs`);
      }

      if (recorded?.suite && recorded.suite !== declaration?.conformanceSuite) {
        errors.push(`${path}.conformanceReportRef suite must match conformanceSuite`);
      }
      if (
        interfaceTriple?.stability === "stable" &&
        recorded?.suiteVersion &&
        recorded.suiteVersion !== declaration?.conformanceSuiteVersion
      ) {
        errors.push(`${path}.conformanceReportRef suiteVersion must match conformanceSuiteVersion`);
      }
    });
  }

  if (!candidate.publisher || !isJsonObject(candidate.publisher)) {
    errors.push("publisher must be an object");
  } else {
    if (!isNonEmptyString(candidate.publisher.type)) {
      errors.push("publisher.type must be a non-empty string");
    }
    if (!isNonEmptyString(candidate.publisher.id)) {
      errors.push("publisher.id must be a non-empty string");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    descriptor: errors.length === 0 ? sortKeys(candidate) : null,
    parsedInterfaces
  };
}

export function serializeDescriptor(descriptor) {
  const parsed = parseDescriptor(descriptor);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return canonicalJson(parsed.descriptor);
}

export function deserializeDescriptor(text) {
  return parseDescriptor(JSON.parse(text));
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function parseInterfaceRef(ref) {
  if (!isNonEmptyString(ref)) {
    return null;
  }

  const match = INTERFACE_REF_RE.exec(ref);
  if (!match) {
    return null;
  }

  return {
    interface: match[1],
    semver: match[2],
    stability: match[match.length - 1]
  };
}

function parseInterfaceDeclarations(declarations, path, errors) {
  if (!Array.isArray(declarations)) {
    errors.push(`${path} must be an array`);
    return [];
  }

  return declarations.map((declaration, index) => {
    const parsed = parseInterfaceRef(declaration?.ref);
    if (!parsed) {
      errors.push(`${path}.${index}.ref must be interface@semver@stability`);
      return null;
    }

    return parsed;
  }).filter(Boolean);
}

function validateArtifactRef(ref, path, errors) {
  if (!ref || !isJsonObject(ref) || Array.isArray(ref)) {
    errors.push(`${path} must be an artifact reference object`);
    return;
  }
  const allowed = new Set(["mediaType", "uri", "digest"]);
  for (const key of Object.keys(ref)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not allowed; artifact references point to external artifacts by digest`);
    }
  }
  if (!isNonEmptyString(ref.mediaType)) {
    errors.push(`${path}.mediaType must be a non-empty string`);
  }
  if (!isNonEmptyString(ref.uri) || !OCI_DIGEST_URI_RE.test(ref.uri)) {
    errors.push(`${path}.uri must be an OCI digest reference`);
  }
  if (!isSha256Digest(ref.digest)) {
    errors.push(`${path}.digest must be sha256:<64 hex chars>`);
  }
  if (isSha256Digest(ref.digest) && isNonEmptyString(ref.uri) && OCI_DIGEST_URI_RE.test(ref.uri)) {
    const uriDigest = ref.uri.slice(ref.uri.lastIndexOf("@") + 1);
    if (uriDigest !== ref.digest) {
      errors.push(`${path}.uri digest must match ${path}.digest`);
    }
  }
  if ("tag" in ref) {
    errors.push(`${path}.tag is not allowed; artifact references must be digest-only`);
  }
}

function artifactRef(seed, { mediaType = "application/vnd.hobo.artifact.v1+json" } = {}) {
  const digest = `sha256:${createHash("sha256").update(seed).digest("hex")}`;

  return {
    mediaType,
    uri: `oci://registry.example/hobo/${seed}@${digest}`,
    digest
  };
}

function conformanceReportRef(seed, {
  suite = "@hobo/conformance/registry-listing",
  suiteVersion = "1.0.0"
} = {}) {
  return {
    suite,
    suiteVersion,
    ref: artifactRef(seed, {
      mediaType: "application/vnd.hobo.conformance.report.v1+json"
    })
  };
}

function validateConformanceReportRef(report, path, errors) {
  if (!report || !isJsonObject(report) || Array.isArray(report)) {
    errors.push(`${path} must be a conformance report reference object`);
    return;
  }

  const allowed = new Set(["suite", "suiteVersion", "ref"]);
  for (const key of Object.keys(report)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not allowed`);
    }
  }
  if (!isNonEmptyString(report.suite)) {
    errors.push(`${path}.suite must be a non-empty string`);
  }
  if (!isSemver(report.suiteVersion)) {
    errors.push(`${path}.suiteVersion must be semver: ${String(report.suiteVersion)}`);
  }
  validateArtifactRef(report.ref, `${path}.ref`, errors);
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isSemver(value) {
  return isJsonString(value) && SEMVER_RE.test(value);
}

function isSha256Digest(value) {
  return isJsonString(value) && /^sha256:[a-f0-9]{64}$/.test(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
