import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const CAPABILITY_SPEC_SCHEMA = "hobo.capability-spec/v1";

const SEMVER_PATTERN_SOURCE = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`;
const SEMVER_RE = new RegExp(`^${SEMVER_PATTERN_SOURCE}$`);
const INTERFACE_NAME_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USED_INTERFACE_RE = new RegExp(`^([a-z][a-z0-9-]*:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@(${SEMVER_PATTERN_SOURCE})$`);
const OCI_DIGEST_URI_RE = /^oci:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/;

export const STABILITY_TIERS = Object.freeze([
  "stable",
  "preview",
  "experimental",
  "deprecated"
]);

const STABILITY_RANK = Object.freeze({
  stable: 4,
  preview: 3,
  experimental: 2,
  deprecated: 1
});

export function createFixtureCapabilitySpec({
  providerId = "acme-provider",
  providerName = "@acme/provider",
  providerVersion = "1.0.0",
  interfaces = [
    {
      interface: "wasi:keyvalue/store",
      semver: "1.0.0",
      stability: "stable",
      suite: "@hobo/conformance/keyvalue",
      suiteVersion: "1.0.0"
    }
  ]
} = {}) {
  const reports = interfaces.map((capability) => conformanceReportRef(
    `${providerId}-${capability.interface}-${capability.semver}-${capability.suiteVersion}`,
    { suite: capability.suite, suiteVersion: capability.suiteVersion }
  ));

  return {
    schema: CAPABILITY_SPEC_SCHEMA,
    provider: {
      id: providerId,
      name: providerName,
      version: providerVersion
    },
    costFactsRef: artifactRef(`${providerId}-cost-facts`, {
      mediaType: "application/vnd.hobo.cost-facts.v1+json"
    }),
    capabilityHints: {
      availabilitySla: "unrated"
    },
    reports,
    interfaces: interfaces.map((capability, index) => ({
      interface: capability.interface,
      semver: capability.semver,
      stability: capability.stability,
      conformanceSuite: capability.suite,
      conformanceSuiteVersion: capability.suiteVersion,
      conformanceReportRef: reports[index].ref
    }))
  };
}

export function parseCapabilitySpec(candidate) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["capability spec must be an object"], spec: null };
  }

  if (candidate.schema !== CAPABILITY_SPEC_SCHEMA) {
    errors.push(`schema must be ${CAPABILITY_SPEC_SCHEMA}`);
  }

  if (!candidate.provider || !isJsonObject(candidate.provider) || Array.isArray(candidate.provider)) {
    errors.push("provider must be an object");
  } else {
    if (!isNonEmptyString(candidate.provider.id)) {
      errors.push("provider.id must be a non-empty string");
    }
    if (!isNonEmptyString(candidate.provider.name)) {
      errors.push("provider.name must be a non-empty string");
    }
    if (!isSemver(candidate.provider.version)) {
      errors.push(`provider.version must be semver: ${String(candidate.provider.version)}`);
    }
  }

  if (candidate.costFactsRef !== undefined) {
    validateArtifactRef(candidate.costFactsRef, "costFactsRef", errors);
  }

  const reports = new Map();
  if (!Array.isArray(candidate.reports)) {
    errors.push("reports must be an array");
  } else {
    candidate.reports.forEach((report, index) => {
      validateConformanceReportRef(report, `reports.${index}`, errors);
      if (report?.ref?.digest) {
        reports.set(report.ref.digest, report);
      }
    });
  }

  if (!Array.isArray(candidate.interfaces)) {
    errors.push("interfaces must be an array");
  } else {
    candidate.interfaces.forEach((capability, index) => {
      const path = `interfaces.${index}`;
      validateCapabilityDeclaration(capability, path, errors);
      const report = capability?.conformanceReportRef;
      const recorded = report?.digest ? reports.get(report.digest) : undefined;

      if (report?.digest && !recorded) {
        errors.push(`${path}.conformanceReportRef must be listed in reports`);
      }
      if (recorded?.suite && recorded.suite !== capability?.conformanceSuite) {
        errors.push(`${path}.conformanceReportRef suite must match conformanceSuite`);
      }
      if (recorded?.suiteVersion && recorded.suiteVersion !== capability?.conformanceSuiteVersion) {
        errors.push(`${path}.conformanceReportRef suiteVersion must match conformanceSuiteVersion`);
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    spec: errors.length === 0 ? sortKeys(candidate) : null
  };
}

export function resolveAvailability(usedInterfaces, registeredSpecs) {
  const parsedUses = usedInterfaces.map(parseUsedInterfaceRef);
  const validSpecs = [];
  const invalidSpecs = [];

  for (const registeredSpec of registeredSpecs) {
    const parsed = parseCapabilitySpec(registeredSpec);
    if (parsed.ok) {
      validSpecs.push(parsed.spec);
    } else {
      invalidSpecs.push({ raw: registeredSpec, errors: parsed.errors });
    }
  }

  const results = parsedUses.map((used, index) => {
    if (!used) {
      return {
        requested: String(usedInterfaces[index]),
        status: "error",
        message: "invalid interface request",
        remediation: "Use interface@semver, for example wasi:blobstore/blobstore@1.0.0."
      };
    }

    const exact = validSpecs.flatMap((spec) => spec.interfaces
      .filter((capability) => capability.interface === used.interface && capability.semver === used.semver)
      .map((capability) => ({
        providerId: spec.provider.id,
        providerName: spec.provider.name,
        capability
      })));

    if (exact.length > 0) {
      const selected = exact.sort(compareCandidates)[0];
      return availabilityForCandidate(used, selected);
    }

    const invalidExact = invalidSpecs.find(({ raw }) =>
      Array.isArray(raw?.interfaces) && raw.interfaces.some((capability) =>
        capability?.interface === used.interface && capability?.semver === used.semver
      )
    );
    if (invalidExact) {
      return {
        requested: used.ref,
        status: "error",
        message: `${used.ref} unavailable because a matching Capability Spec failed validation.`,
        remediation: `Publish a valid conformance report matching the declared suite/version. First error: ${invalidExact.errors[0]}`
      };
    }

    const incompatible = validSpecs.flatMap((spec) => spec.interfaces
      .filter((capability) => capability.interface === used.interface && capability.semver !== used.semver)
      .map((capability) => `${spec.provider.id}:${capability.semver}@${capability.stability}`));

    if (incompatible.length > 0) {
      return {
        requested: used.ref,
        status: "error",
        message: `${used.ref} unavailable: incompatible semver declared (${incompatible.sort().join(", ")}).`,
        remediation: "Register a provider with the exact requested interface semver or migrate the Bindle pin through an explicit upcaster."
      };
    }

    return {
      requested: used.ref,
      status: "error",
      message: `${used.ref} unavailable in the registered Capability Specs.`,
      remediation: "register a provider that implements this interface or generate a conformance-certified adapter."
    };
  });

  return {
    status: summarize(results),
    results
  };
}

export function parseUsedInterfaceRef(ref) {
  if (!isNonEmptyString(ref)) {
    return null;
  }
  const match = USED_INTERFACE_RE.exec(ref);
  if (!match) {
    return null;
  }
  return {
    ref,
    interface: match[1],
    semver: match[2]
  };
}

function availabilityForCandidate(used, selected) {
  const { capability, providerId, providerName } = selected;
  const base = {
    requested: used.ref,
    providerId,
    providerName,
    interface: capability.interface,
    semver: capability.semver,
    stability: capability.stability,
    conformanceSuiteVersion: capability.conformanceSuiteVersion
  };

  if (capability.stability === "stable") {
    return {
      ...base,
      status: "ok",
      message: `${used.ref} available as stable on ${providerId}.`
    };
  }

  return {
    ...base,
    status: "warn",
    message: `${used.ref} available as ${capability.stability}; pinned, may change, and policy may deny it in production.`
  };
}

function compareCandidates(left, right) {
  const byStability = STABILITY_RANK[right.capability.stability] - STABILITY_RANK[left.capability.stability];
  if (byStability !== 0) {
    return byStability;
  }
  return left.providerId.localeCompare(right.providerId);
}

function summarize(results) {
  if (results.some((result) => result.status === "error")) {
    return "error";
  }
  if (results.some((result) => result.status === "warn")) {
    return "warn";
  }
  return "ok";
}

function validateCapabilityDeclaration(capability, path, errors) {
  if (!capability || !isJsonObject(capability) || Array.isArray(capability)) {
    errors.push(`${path} must be a capability declaration object`);
    return;
  }

  const allowed = new Set([
    "interface",
    "semver",
    "stability",
    "conformanceSuite",
    "conformanceSuiteVersion",
    "conformanceReportRef"
  ]);
  for (const key of Object.keys(capability)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not allowed`);
    }
  }
  if (!isNonEmptyString(capability.interface) || !INTERFACE_NAME_RE.test(capability.interface)) {
    errors.push(`${path}.interface must be namespace:package/interface`);
  }
  if (!isSemver(capability.semver)) {
    errors.push(`${path}.semver must be semver: ${String(capability.semver)}`);
  }
  if (!STABILITY_TIERS.includes(capability.stability)) {
    errors.push(`${path}.stability must be one of ${STABILITY_TIERS.join(", ")}`);
  }
  if (!isNonEmptyString(capability.conformanceSuite)) {
    errors.push(`${path}.conformanceSuite must be a non-empty string`);
  }
  if (!isSemver(capability.conformanceSuiteVersion)) {
    errors.push(`${path}.conformanceSuiteVersion must be semver: ${String(capability.conformanceSuiteVersion)}`);
  }
  validateArtifactRef(capability.conformanceReportRef, `${path}.conformanceReportRef`, errors);
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

function validateArtifactRef(ref, path, errors) {
  if (!ref || !isJsonObject(ref) || Array.isArray(ref)) {
    errors.push(`${path} must be an artifact reference object`);
    return;
  }
  const allowed = new Set(["mediaType", "uri", "digest"]);
  for (const key of Object.keys(ref)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not allowed`);
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
}

function artifactRef(seed, { mediaType = "application/vnd.hobo.artifact.v1+json" } = {}) {
  const digest = `sha256:${createHash("sha256").update(seed).digest("hex")}`;
  return {
    mediaType,
    uri: `oci://registry.example/hobo/${sanitizeSeed(seed)}@${digest}`,
    digest
  };
}

function conformanceReportRef(seed, {
  suite,
  suiteVersion
}) {
  return {
    suite,
    suiteVersion,
    ref: artifactRef(seed, {
      mediaType: "application/vnd.hobo.conformance.report.v1+json"
    })
  };
}

function sanitizeSeed(seed) {
  return seed.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
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
