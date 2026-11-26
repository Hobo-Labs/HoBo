import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";

import { denyRule } from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import {
  createPolicyPack,
  signPolicyPack
} from "../../policy-pack-federation-contract/src/policy-pack-federation.js";

import {
  createFixtureTrustBoundary,
  createPolicyPackage,
  createRegistryBundle,
  createSignedEngineArtifact,
  createSignedRegistryBundle,
  createValidEnginePayload,
  evaluateDerivativeUpgrade,
  evaluateRegistryBundleImport,
  verifyPolicyPackage
} from "../src/policy-supply-chain-trust.js";

test("acceptance: signed policy package verifies pack signature, SBOM, and SLSA provenance", () => {
  const trust = createFixtureTrustBoundary();
  const envelope = signPolicyPack(
    createFixturePack({ ruleId: "require-signed-providers", tuple: "provider:unsigned:prod" }),
    trust.policySigner
  );
  const policyPackage = createPolicyPackage({
    packageName: "@hobo/policy/org-prod",
    packageVersion: "2.0.0",
    envelope,
    signer: trust.packageSigner
  });

  const result = verifyPolicyPackage(policyPackage, trust);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.policyPackage.provenance.subject, {
    name: "@hobo/policy/org-prod",
    digest: result.policyPackage.packDigest
  });
  assert.equal(result.policyPackage.sbom.bomFormat, "CycloneDX");
  assert.equal(result.policyPackage.provenance.predicateType, "https://slsa.dev/provenance/v1");
});

test("adversarial: unsigned and tampered policy packs fail closed before load", () => {
  const trust = createFixtureTrustBoundary();
  const signed = signPolicyPack(
    createFixturePack({ ruleId: "deny-untrusted-runner", tuple: "runner:untrusted:apply" }),
    trust.policySigner
  );
  const unsignedPackage = createPolicyPackage({
    packageName: "@hobo/policy/org-prod",
    packageVersion: "2.0.0",
    envelope: { schemaVersion: signed.schemaVersion, pack: signed.pack },
    signer: trust.packageSigner
  });
  const tamperedPackage = createPolicyPackage({
    packageName: "@hobo/policy/org-prod",
    packageVersion: "2.0.0",
    envelope: signed,
    signer: trust.packageSigner
  });
  tamperedPackage.payload.envelope.pack.rules[0].denies = ["runner:any:apply"];

  const unsignedResult = verifyPolicyPackage(unsignedPackage, trust);
  const tamperedResult = verifyPolicyPackage(tamperedPackage, trust);

  assert.equal(unsignedResult.ok, false);
  assert.match(unsignedResult.errors.join("\n"), /signature must be present/);
  assert.equal(tamperedResult.ok, false);
  assert.match(tamperedResult.errors.join("\n"), /policy package signature verification failed/);
});

test("adversarial: wrong-key pack and federated mandatory flag tampering never load", () => {
  const trust = createFixtureTrustBoundary();
  const rogue = createSigningKey("rogue-policy-root");
  const forgedEnvelope = signPolicyPack(
    createFixturePack({ ruleId: "deny-unsafe-import", tuple: "registry:bundle-import:unsafe" }),
    rogue
  );
  const forgedPackage = createPolicyPackage({
    packageName: "@hobo/policy/org-prod",
    packageVersion: "2.0.0",
    envelope: forgedEnvelope,
    signer: trust.packageSigner
  });
  const federatedEnvelope = signPolicyPack(
    createFixturePack({ ruleId: "mandatory-eu-deny", tuple: "region:non-eu:prod" }),
    trust.policySigner
  );
  const federatedPackage = createPolicyPackage({
    packageName: "@hobo/policy/junction-prod",
    packageVersion: "2.1.0",
    envelope: federatedEnvelope,
    signer: trust.packageSigner
  });
  federatedPackage.payload.envelope.pack.rules[0].mode = "default";

  const forgedResult = verifyPolicyPackage(forgedPackage, trust);
  const federatedResult = verifyPolicyPackage(federatedPackage, trust);

  assert.equal(forgedResult.ok, false);
  assert.match(forgedResult.errors.join("\n"), /no trusted key for rogue-policy-root/);
  assert.equal(federatedResult.ok, false);
  assert.match(federatedResult.errors.join("\n"), /policy package signature verification failed/);
});

test("acceptance: registry bundle import denies unsigned offline bundles and records audit evidence", () => {
  const trust = createFixtureTrustBoundary();
  const unsignedBundle = createRegistryBundle({
    bundleId: "airgap-prod-2026-06",
    version: "2026.06.0",
    artifacts: ["@hobo/policy/org-prod@2.0.0"]
  });

  const decision = evaluateRegistryBundleImport({
    bundle: unsignedBundle,
    actor: "user:security-admin",
    trust
  });

  assert.equal(decision.effect, "deny");
  assert.equal(decision.auditEvent.type, "registry.BundleImported");
  assert.equal(decision.auditEvent.action, "hobo:registry:import");
  assert.equal(decision.auditEvent.result, "deny");
  assert.match(decision.reason, /bundle signature missing/);
});

test("acceptance: signed registry bundle and derivative engine swap are gated and audited", () => {
  const trust = createFixtureTrustBoundary();
  const signedBundle = createSignedRegistryBundle(
    createRegistryBundle({
      bundleId: "airgap-prod-2026-06",
      version: "2026.06.0",
      artifacts: ["@hobo/policy/org-prod@2.0.0"]
    }),
    trust.bundleSigner
  );
  const engine = createSignedEngineArtifact(createValidEnginePayload(), trust.engineSigner);

  const importDecision = evaluateRegistryBundleImport({
    bundle: signedBundle,
    actor: "user:security-admin",
    trust
  });
  const upgradeDecision = evaluateDerivativeUpgrade({
    from: { coreVersion: "1.0.0", policyEngine: "builtin-policy-engine@1.0.0" },
    to: engine,
    actor: "user:platform-admin",
    trust
  });

  assert.equal(importDecision.effect, "allow", importDecision.reason);
  assert.equal(importDecision.auditEvent.result, "allow");
  assert.equal(upgradeDecision.effect, "require-approval", upgradeDecision.reason);
  assert.equal(upgradeDecision.auditEvent.type, "policy.Decided");
  assert.equal(upgradeDecision.auditEvent.action, "hobo:derivative:upgrade");
  assert.deepEqual(upgradeDecision.obligations, ["security-review", "seam-conformance"]);
});

test("adversarial: fail-open swapped policy engine is rejected at the trust boundary before runtime", () => {
  const trust = createFixtureTrustBoundary();
  const maliciousEngine = createSignedEngineArtifact(
    createValidEnginePayload({
      name: "fail-open-policy-engine",
      behavior: "fail-open",
      attestation: {
        issuer: "spiffe://attacker.example",
        builderId: "builder:unknown",
        buildType: "debug-local"
      }
    }),
    trust.engineSigner
  );

  const decision = evaluateDerivativeUpgrade({
    from: { coreVersion: "1.0.0", policyEngine: "builtin-policy-engine@1.0.0" },
    to: maliciousEngine,
    actor: "user:platform-admin",
    trust
  });

  assert.equal(decision.effect, "deny");
  assert.equal(decision.runtimeInvoked, false);
  assert.match(decision.reason, /attestation issuer is not trusted/);
  assert.equal(decision.auditEvent.result, "deny");
});

function createFixturePack({ ruleId, tuple }) {
  return createPolicyPack({
    id: "org-prod-baseline",
    version: "2.0.0",
    scope: "junction",
    targets: [{ kind: "junction", id: "junction:global-prod", environment: "prod" }],
    rules: [denyRule({ id: ruleId, tuple })]
  });
}

function createSigningKey(keyId) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    trustStore: {
      [keyId]: publicKey
    }
  };
}
