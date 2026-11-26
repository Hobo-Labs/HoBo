import { isJsonString, isJsonObject } from "./json.js";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import { canonicalJson } from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import { verifySignedPolicyPack } from "../../policy-pack-federation-contract/src/policy-pack-federation.js";

export const POLICY_PACKAGE_SCHEMA = "hobo.signed-policy-package/v1";
export const REGISTRY_BUNDLE_SCHEMA = "hobo.registry-bundle/v1";
export const SIGNED_REGISTRY_BUNDLE_SCHEMA = "hobo.signed-registry-bundle/v1";
export const POLICY_ENGINE_SCHEMA = "hobo.signed-policy-engine/v1";
export const SIGNATURE_ALGORITHM = "ed25519";
export const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

export function createFixtureTrustBoundary() {
  const policySigner = createSigningKey("hobo-policy-root");
  const packageSigner = createSigningKey("hobo-policy-package-root");
  const bundleSigner = createSigningKey("hobo-registry-root");
  const engineSigner = createSigningKey("hobo-engine-root");

  return {
    policySigner,
    packageSigner,
    bundleSigner,
    engineSigner,
    policyPackKeys: policySigner.trustStore,
    packageKeys: packageSigner.trustStore,
    bundleKeys: bundleSigner.trustStore,
    engineKeys: engineSigner.trustStore,
    trustedAttestationIssuers: ["spiffe://hobo.example/identity"],
    trustedBuilders: ["builder:hobo-release"],
    requiredSbomFormat: "CycloneDX",
    requiredProvenancePredicateType: SLSA_PROVENANCE_PREDICATE
  };
}

export function createPolicyPackage({
  packageName,
  packageVersion,
  envelope,
  signer,
  sbom,
  provenance
}) {
  const packDigest = digestObject(envelope);
  const payload = {
    schema: "hobo.policy-package/v1",
    packageName: requiredString(packageName, "packageName"),
    packageVersion: requiredString(packageVersion, "packageVersion"),
    packDigest,
    envelope: clone(envelope),
    sbom: sbom ?? createSbom({ packageName, packageVersion }),
    provenance: provenance ?? createProvenance({ packageName, packageVersion, digest: packDigest })
  };

  return {
    schemaVersion: POLICY_PACKAGE_SCHEMA,
    payload,
    signature: signPayload(payload, signer)
  };
}

export function verifyPolicyPackage(policyPackage, trust) {
  try {
    if (!isPlainObject(policyPackage)) {
      throw new TypeError("policy package must be an object");
    }
    if (policyPackage.schemaVersion !== POLICY_PACKAGE_SCHEMA) {
      throw new TypeError(`schemaVersion must be ${POLICY_PACKAGE_SCHEMA}`);
    }
    const payload = requiredObject(policyPackage.payload, "payload");
    verifyEnvelopeSignature({
      payload,
      signature: policyPackage.signature,
      keys: trust?.packageKeys,
      missingSignatureMessage: "policy package signature missing",
      failedMessage: "policy package signature verification failed"
    });

    if (payload.packDigest !== digestObject(payload.envelope)) {
      throw new TypeError("packDigest must match the signed pack envelope");
    }

    assertSbom(payload.sbom, {
      path: "payload.sbom",
      expectedFormat: trust?.requiredSbomFormat ?? "CycloneDX"
    });
    assertProvenance(payload.provenance, {
      path: "payload.provenance",
      expectedPredicate: trust?.requiredProvenancePredicateType ?? SLSA_PROVENANCE_PREDICATE,
      expectedSubject: {
        name: payload.packageName,
        digest: payload.packDigest
      },
      trustedBuilders: trust?.trustedBuilders
    });

    const packResult = verifySignedPolicyPack(payload.envelope, trust?.policyPackKeys);
    if (!packResult.ok) {
      throw new TypeError(packResult.error);
    }

    return {
      ok: true,
      errors: [],
      policyPackage: clone(payload),
      policyPack: packResult.policyPack,
      signer: policyPackage.signature.keyId
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error.message]
    };
  }
}

export function createRegistryBundle({ bundleId, version, artifacts, provenance }) {
  const parsedArtifacts = parseArtifactList(artifacts);
  const parsedBundleId = requiredString(bundleId, "bundleId");
  const parsedVersion = requiredString(version, "version");
  return {
    schemaVersion: REGISTRY_BUNDLE_SCHEMA,
    bundleId: parsedBundleId,
    version: parsedVersion,
    artifacts: parsedArtifacts,
    provenance: provenance ?? {
      predicateType: SLSA_PROVENANCE_PREDICATE,
      builder: { id: "builder:hobo-release" },
      subject: {
        name: parsedBundleId,
        digest: digestObject({
          bundleId: parsedBundleId,
          version: parsedVersion,
          artifacts: parsedArtifacts
        })
      }
    }
  };
}

export function createSignedRegistryBundle(bundle, signer) {
  const payload = clone(bundle);
  return {
    schemaVersion: SIGNED_REGISTRY_BUNDLE_SCHEMA,
    payload,
    signature: signPayload(payload, signer)
  };
}

export function evaluateRegistryBundleImport({ bundle, actor, trust }) {
  const result = verifyRegistryBundle(bundle, trust);
  const effect = result.ok ? "allow" : "deny";
  const reason = result.ok ? "bundle signature and provenance verified" : result.errors.join("; ");

  return {
    effect,
    reason,
    auditEvent: {
      type: "registry.BundleImported",
      action: "hobo:registry:import",
      actor: requiredString(actor, "actor"),
      bundleId: result.bundle?.bundleId ?? bundle?.bundleId ?? bundle?.payload?.bundleId ?? "unknown",
      result: effect,
      reason,
      verification: result.ok
        ? {
            signature: "passed",
            provenance: "passed",
            denyByDefault: "passed"
          }
        : {
            signature: "failed",
            provenance: "not-trusted"
          }
    }
  };
}

export function createValidEnginePayload(overrides = {}) {
  const base = {
    schema: "hobo.policy-engine/v1",
    seam: "policy-engine",
    name: "builtin-policy-engine",
    version: "1.1.0",
    behavior: "fail-closed",
    conformance: {
      suite: "@hobo/conformance/policy-engine",
      status: "passed",
      seamVersion: "1.0.0"
    },
    attestation: {
      issuer: "spiffe://hobo.example/identity",
      builderId: "builder:hobo-release",
      buildType: "trusted-release",
      predicateType: SLSA_PROVENANCE_PREDICATE
    }
  };
  const payload = deepMerge(base, overrides);
  const engineDigest = engineDigestFor(payload);

  return {
    ...payload,
    digest: engineDigest,
    attestation: {
      ...payload.attestation,
      subjectDigest: payload.attestation?.subjectDigest ?? engineDigest
    }
  };
}

export function createSignedEngineArtifact(enginePayload, signer) {
  const payload = clone(enginePayload);
  return {
    schemaVersion: POLICY_ENGINE_SCHEMA,
    payload,
    signature: signPayload(payload, signer)
  };
}

export function evaluateDerivativeUpgrade({ from, to, actor, trust }) {
  const result = verifyPolicyEngineArtifact(to, trust);
  if (!result.ok) {
    return {
      effect: "deny",
      reason: result.errors.join("; "),
      runtimeInvoked: false,
      auditEvent: {
        type: "policy.Decided",
        action: "hobo:derivative:upgrade",
        actor: requiredString(actor, "actor"),
        from,
        result: "deny",
        reason: result.errors.join("; ")
      }
    };
  }

  return {
    effect: "require-approval",
    reason: "policy-engine swap is signed, attested, and ready for governed derivative upgrade approval",
    obligations: ["security-review", "seam-conformance"],
    runtimeInvoked: false,
    auditEvent: {
      type: "policy.Decided",
      action: "hobo:derivative:upgrade",
      actor: requiredString(actor, "actor"),
      from,
      targetEngine: `${result.engine.name}@${result.engine.version}`,
      result: "require-approval",
      obligations: ["security-review", "seam-conformance"]
    }
  };
}

function verifyRegistryBundle(bundle, trust) {
  try {
    if (!isPlainObject(bundle)) {
      throw new TypeError("bundle must be an object");
    }
    if (bundle.schemaVersion !== SIGNED_REGISTRY_BUNDLE_SCHEMA) {
      if (bundle.signature === undefined) {
        throw new TypeError("bundle signature missing");
      }
      throw new TypeError(`schemaVersion must be ${SIGNED_REGISTRY_BUNDLE_SCHEMA}`);
    }
    const payload = requiredObject(bundle.payload, "payload");
    verifyEnvelopeSignature({
      payload,
      signature: bundle.signature,
      keys: trust?.bundleKeys,
      missingSignatureMessage: "bundle signature missing",
      failedMessage: "bundle signature verification failed"
    });
    if (payload.schemaVersion !== REGISTRY_BUNDLE_SCHEMA) {
      throw new TypeError(`bundle payload schemaVersion must be ${REGISTRY_BUNDLE_SCHEMA}`);
    }
    const artifacts = parseArtifactList(payload.artifacts);
    assertProvenance(payload.provenance, {
      path: "payload.provenance",
      expectedPredicate: trust?.requiredProvenancePredicateType ?? SLSA_PROVENANCE_PREDICATE,
      expectedSubject: {
        name: payload.bundleId,
        digest: digestObject({
          bundleId: payload.bundleId,
          version: payload.version,
          artifacts
        })
      },
      trustedBuilders: trust?.trustedBuilders
    });

    return {
      ok: true,
      errors: [],
      bundle: clone(payload)
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error.message]
    };
  }
}

function verifyPolicyEngineArtifact(artifact, trust) {
  try {
    if (!isPlainObject(artifact)) {
      throw new TypeError("policy engine artifact must be an object");
    }
    if (artifact.schemaVersion !== POLICY_ENGINE_SCHEMA) {
      throw new TypeError(`schemaVersion must be ${POLICY_ENGINE_SCHEMA}`);
    }
    const payload = requiredObject(artifact.payload, "payload");
    verifyEnvelopeSignature({
      payload,
      signature: artifact.signature,
      keys: trust?.engineKeys,
      missingSignatureMessage: "policy engine signature missing",
      failedMessage: "policy engine signature verification failed"
    });
    if (payload.schema !== "hobo.policy-engine/v1") {
      throw new TypeError("policy engine schema is unsupported");
    }
    if (payload.seam !== "policy-engine") {
      throw new TypeError("artifact is not a policy-engine seam implementation");
    }
    if (payload.digest !== engineDigestFor(payload)) {
      throw new TypeError("policy engine digest does not match engine payload");
    }

    const attestation = requiredObject(payload.attestation, "payload.attestation");
    if (!trust?.trustedAttestationIssuers?.includes(attestation.issuer)) {
      throw new TypeError("attestation issuer is not trusted");
    }
    if (!trust?.trustedBuilders?.includes(attestation.builderId)) {
      throw new TypeError("attestation builder is not trusted");
    }
    if (attestation.buildType !== "trusted-release") {
      throw new TypeError("policy engine build type is not trusted-release");
    }
    if (attestation.predicateType !== (trust?.requiredProvenancePredicateType ?? SLSA_PROVENANCE_PREDICATE)) {
      throw new TypeError("policy engine attestation predicate is unsupported");
    }
    if (payload.digest !== attestation.subjectDigest) {
      throw new TypeError("policy engine attestation subject digest mismatch");
    }
    if (payload.conformance?.status !== "passed") {
      throw new TypeError("policy engine seam conformance did not pass");
    }
    if (payload.behavior === "fail-open") {
      throw new TypeError("policy engine declares fail-open behavior");
    }

    return {
      ok: true,
      errors: [],
      engine: clone(payload)
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error.message]
    };
  }
}

function verifyEnvelopeSignature({ payload, signature, keys, missingSignatureMessage, failedMessage }) {
  if (!isPlainObject(signature)) {
    throw new TypeError(missingSignatureMessage);
  }
  if (signature.alg !== SIGNATURE_ALGORITHM) {
    throw new TypeError(`signature.alg must be ${SIGNATURE_ALGORITHM}`);
  }
  const keyId = requiredString(signature.keyId, "signature.keyId");
  const trustedKey = keys?.[keyId];
  if (!trustedKey) {
    throw new TypeError(`no trusted key for ${keyId}`);
  }
  const signatureOk = verify(
    null,
    Buffer.from(canonicalJson(payload)),
    trustedKey,
    Buffer.from(requiredString(signature.value, "signature.value"), "base64url")
  );
  if (!signatureOk) {
    throw new TypeError(failedMessage);
  }
}

function signPayload(payload, signer) {
  const { keyId, privateKey } = signer ;
  return {
    alg: SIGNATURE_ALGORITHM,
    keyId: requiredString(keyId, "signer.keyId"),
    value: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url")
  };
}

function assertSbom(sbom, { path, expectedFormat }) {
  if (!isPlainObject(sbom)) {
    throw new TypeError(`${path} must be an object`);
  }
  if (sbom.bomFormat !== expectedFormat) {
    throw new TypeError(`${path}.bomFormat must be ${expectedFormat}`);
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new TypeError(`${path}.components must be a non-empty array`);
  }
}

function assertProvenance(provenance, { path, expectedPredicate, expectedSubject, trustedBuilders }) {
  if (!isPlainObject(provenance)) {
    throw new TypeError(`${path} must be an object`);
  }
  if (provenance.predicateType !== expectedPredicate) {
    throw new TypeError(`${path}.predicateType must be ${expectedPredicate}`);
  }
  const builderId = provenance.builder?.id;
  if (!trustedBuilders?.includes(builderId)) {
    throw new TypeError(`${path}.builder.id is not trusted`);
  }
  if (provenance.subject?.name !== expectedSubject.name) {
    throw new TypeError(`${path}.subject.name must be ${expectedSubject.name}`);
  }
  if (provenance.subject?.digest !== expectedSubject.digest) {
    throw new TypeError(`${path}.subject.digest must match verified digest`);
  }
}

function createSbom({ packageName, packageVersion }) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: {
      component: {
        type: "library",
        name: packageName,
        version: packageVersion
      }
    },
    components: [
      {
        type: "library",
        name: packageName,
        version: packageVersion
      }
    ]
  };
}

function createProvenance({ packageName, digest }) {
  return {
    predicateType: SLSA_PROVENANCE_PREDICATE,
    builder: { id: "builder:hobo-release" },
    subject: {
      name: packageName,
      digest
    },
    buildType: "https://hobo.dev/build/policy-package"
  };
}

function engineDigestFor(payload) {
  return digestObject({
    schema: payload.schema,
    seam: payload.seam,
    name: payload.name,
    version: payload.version,
    behavior: payload.behavior,
    conformance: payload.conformance
  });
}

function createSigningKey(keyId) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    publicKey,
    trustStore: {
      [keyId]: publicKey
    }
  };
}

function digestObject(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function parseArtifactList(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new TypeError("artifacts must be a non-empty array");
  }
  return artifacts.map((artifact, index) => requiredString(artifact, `artifacts[${index}]`));
}

function requiredObject(value, path) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function requiredString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function deepMerge(left, right) {
  const result = clone(left);
  for (const [key, value] of Object.entries(right)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
