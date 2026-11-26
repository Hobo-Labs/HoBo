import { isJsonString, isJsonObject } from "./json.js";
import {
  createGenerationCertifyStage,
  createInMemoryCertificationRegistry,
} from "../../generation-certify-stage-contract/src/certify-stage.js";
import {
  createHoboAddCatalog,
  hoboAdd,
} from "../../hobo-add-install-verification-contract/src/hobo-add-install-verification.js";
import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";
import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
  verifyInstallCandidate,
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";

export const FORGE_REGISTRY_RECORD_SCHEMA = "hobo.forge.registry-record/v1";

export class ForgeSigningRegistryError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "ForgeSigningRegistryError";
    this.code = code;
    this.path = path;
  }
}

export function createForgeSigningRegistry({
  signingKey,
  trustBoundary,
  registry,
  catalog,
} = {}) {
  const key = signingKey ?? createFixtureSigningKey({
    keyId: "hobo-forge-certifier",
    builderId: "spiffe://hobo.example/forge/certifier",
  });
  const boundary = trustBoundary ?? createTrustBoundary({
    trustedKeyIds: [key.keyId],
    trustedBuilderIds: [key.builderId],
    requiredConformanceSuites: ["@hobo/conformance/postgres-provider"],
    allowedCoordinateScopes: ["oci://registry.example/hobo/"],
    minimumProvenanceTier: "slsa-build-l3",
  });
  const targetRegistry = registry ?? createInMemoryCertificationRegistry({
    trustedKeys: { [key.keyId]: key.publicKeyPem },
  });
  const certifyStage = createGenerationCertifyStage({
    registry: targetRegistry,
    signingKey: {
      keyId: key.keyId,
      publicKeyPem: key.publicKeyPem,
      privateKeyPem: key.privateKeyPem,
    },
  });
  const targetCatalog = catalog ?? createHoboAddCatalog();

  return Object.freeze({
    certifyAndPublish(pass) {
      const parsed = parseForgeCertificationPass(pass);
      const certifyResult = certifyStage.certify(toCertifyInput(parsed, key));
      if (!certifyResult.ok) {
        throw new ForgeSigningRegistryError(
          "forge.certification_publish_rejected",
          "$",
          certifyResult.reasons.join("; "),
        );
      }

      const signedInstallCandidate = publishSignedArtifact({
        artifact: createArtifactPayload({
          coordinate: `oci://registry.example/hobo/${parsed.candidate.name.replace("@", "")}`,
          version: parsed.candidate.version,
          mediaType: "application/vnd.hobo.provider.layer.v1+json",
          bytes: parsed.candidate.bytes,
        }),
        signingKey: key,
        conformanceReport: parsed.conformanceReport,
        issuedAt: parsed.certifiedAt,
        provenanceTier: "slsa-build-l3",
      });

      return Object.freeze({
        ok: true,
        record: certifyResult.record,
        installCandidate: signedInstallCandidate,
        registryCoordinate: certifyResult.record.payload.registryCoordinate,
        events: targetRegistry.events(),
      });
    },

    install({ listing, installCandidate, registryRecord }) {
      const candidate = installCandidate ?? listing?.installCandidate;
      if (!candidate) {
        throw new ForgeSigningRegistryError("forge.install_candidate_required", "$.installCandidate");
      }

      const verification = verifyInstallCandidate({ candidate, trustBoundary: boundary });
      if (!verification.ok) {
        const code = installRejectionCode(verification.reasons);
        throw new ForgeSigningRegistryError(code, "$", verification.reasons.join("; "));
      }

      const descriptor = listing ?? buildRegistryDescriptor({
        candidate,
        registryRecord,
      });

      const result = hoboAdd({
        catalog: targetCatalog,
        listing: descriptor,
        candidate,
        trustBoundary: boundary,
      });

      if (!result.ok) {
        throw new ForgeSigningRegistryError(
          "forge.install_rejected",
          "$",
          result.reasons.join("; "),
        );
      }

      return Object.freeze({
        ok: true,
        entry: result.entry,
        availableToMatching: result.availableToMatching,
        selectedByMatching: result.selectedByMatching,
      });
    },

    installFromRegistry({ registryCoordinate, installCandidate }) {
      const certified = targetRegistry.certified().find(
        (record) => record.payload.registryCoordinate === registryCoordinate,
      );
      if (!certified) {
        throw new ForgeSigningRegistryError(
          "forge.uncertified_not_listed",
          "$.registryCoordinate",
        );
      }
      return this.install({ installCandidate, registryRecord: certified });
    },

    registry: targetRegistry,
    catalog: targetCatalog,
    signingKey: key,
    trustBoundary: boundary,
  });
}

function parseForgeCertificationPass(pass) {
  const parsed = expectObject(pass, "$");
  const requestId = nonEmptyString(parsed.requestId, "$.requestId");
  const candidate = parseCandidate(parsed.candidate);
  const validationReport = expectObject(parsed.validationReport, "$.validationReport");
  const conformanceReport = expectObject(parsed.conformanceReport, "$.conformanceReport");
  const certifiedAt = isoTimestamp(parsed.certifiedAt, "$.certifiedAt");

  if (validationReport.passed !== true) {
    throw new ForgeSigningRegistryError("forge.validation_not_green", "$.validationReport.passed");
  }
  if (conformanceReport.passed !== true) {
    throw new ForgeSigningRegistryError("forge.conformance_not_green", "$.conformanceReport.passed");
  }

  return Object.freeze({
    requestId,
    candidate,
    validationReport,
    conformanceReport,
    model: parsed.model,
    prompt: parsed.prompt,
    seed: parsed.seed,
    gateDecision: parsed.gateDecision,
    certifiedAt,
  });
}

function parseCandidate(input) {
  const candidate = expectObject(input, "$.candidate");
  return Object.freeze({
    artifactKind: nonEmptyString(candidate.artifactKind, "$.candidate.artifactKind"),
    name: nonEmptyString(candidate.name, "$.candidate.name"),
    version: nonEmptyString(candidate.version, "$.candidate.version"),
    bytes: nonEmptyString(candidate.bytes, "$.candidate.bytes"),
    artifactRef: Object.freeze({
      mediaType: nonEmptyString(candidate.artifactRef?.mediaType, "$.candidate.artifactRef.mediaType"),
      uri: nonEmptyString(candidate.artifactRef?.uri, "$.candidate.artifactRef.uri"),
      digest: digest(candidate.artifactRef?.digest, "$.candidate.artifactRef.digest"),
    }),
    claimedPorts: stringArray(candidate.claimedPorts, "$.candidate.claimedPorts"),
  });
}

function toCertifyInput(parsed, signingKey) {
  return {
    requestId: parsed.requestId,
    candidate: {
      artifactKind: parsed.candidate.artifactKind,
      name: parsed.candidate.name,
      version: parsed.candidate.version,
      artifactRef: parsed.candidate.artifactRef,
      claimedPorts: parsed.candidate.claimedPorts,
    },
    validationReport: parsed.validationReport,
    conformanceReport: parsed.conformanceReport,
    evalReports: [
      {
        kind: "eval-report",
        name: "forge-sandbox-no-egress",
        digest: contentDigest({ passed: true, egressAttempts: 0 }),
      },
    ],
    model: parsed.model ?? {
      provider: "self-hosted",
      id: "self-hosted/qwen3-coder",
      digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    prompt: parsed.prompt ?? {
      id: "forge-provider-postgres-v1",
      frozenPromptDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
    seed: parsed.seed ?? `seed-${parsed.requestId}`,
    gateDecision: parsed.gateDecision ?? {
      effect: "certify",
      reason: "forge sandbox certification passed",
      policyRef: "policy:allow-forge-certify",
      policyInputHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
    certifiedAt: parsed.certifiedAt,
    signingKey,
  };
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;

function digest(value, path) {
  if (!digestPattern.test(String(value ?? ""))) {
    throw new ForgeSigningRegistryError("forge.digest_invalid", path);
  }
  return value;
}

function expectObject(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ForgeSigningRegistryError("forge.object_required", path);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new ForgeSigningRegistryError("forge.string_required", path);
  }
  return value;
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ForgeSigningRegistryError("forge.array_required", path);
  }
  return value.map((item, index) => nonEmptyString(item, `${path}[${index}]`));
}

function isoTimestamp(value, path) {
  nonEmptyString(value, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new ForgeSigningRegistryError("forge.timestamp_invalid", path);
  }
  return value;
}

function installRejectionCode(reasons) {
  if (reasons.includes("signature.invalid")) {
    return "forge.signature_verification_failed";
  }
  if (reasons.includes("signature.required")) {
    return "forge.unsigned_refused_at_install";
  }
  return "forge.install_verification_failed";
}

function buildRegistryDescriptor({ candidate, registryRecord }) {
  const payload = registryRecord?.payload;
  const suiteId = payload?.conformanceReport?.suiteId
    ?? candidate.conformance?.report?.suiteId
    ?? "@hobo/conformance/postgres-provider";
  const listingName = payload?.name ?? "@acme/forge-provider";
  const conformanceRef = artifactRef({
    digest: candidate.conformance.digest,
    mediaType: "application/vnd.hobo.conformance.report.v1+json",
    name: `${listingName.replace("@", "")}-conformance`,
  });

  return {
    schema: "registry.descriptor/v1",
    kind: "provider",
    name: listingName,
    version: candidate.artifact.version,
    artifact: artifactRef({
      digest: candidate.artifact.digest,
      mediaType: candidate.artifact.mediaType,
      name: listingName.replace("@", ""),
    }),
    publisher: {
      type: "organization",
      id: "hobo-forge",
      trustDomain: "spiffe://hobo.example",
    },
    evidence: {
      slsaProvenanceRef: artifactRef({
        digest: contentDigest(candidate.provenance),
        mediaType: "application/vnd.in-toto+json",
        name: `${listingName.replace("@", "")}-provenance`,
      }),
      conformanceReportRefs: [{
        suite: suiteId,
        suiteVersion: "1.0.0",
        ref: conformanceRef,
      }],
    },
    interfaces: {
      exports: [{
        ref: "hobo:provider/contract@1.0.0@stable",
        conformanceSuite: suiteId,
        conformanceSuiteVersion: "1.0.0",
        conformanceReportRef: conformanceRef,
      }],
      imports: [],
    },
  };
}

function artifactRef({ digest, mediaType, name }) {
  return {
    mediaType,
    uri: `oci://registry.example/hobo/${name}@${digest}`,
    digest,
  };
}
