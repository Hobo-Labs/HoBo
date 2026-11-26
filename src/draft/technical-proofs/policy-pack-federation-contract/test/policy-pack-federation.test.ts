import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";

import {
  allowRule,
  canonicalJson,
  composePolicyPacks,
  denyRule
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import {
  createBuiltInPolicyEngine,
  createGoldenDecisionRequest,
  createRuleset,
  defineTypescriptRule,
  evaluatePolicy,
  requestTuple
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";

import {
  createPolicyPack,
  federatePolicyPackToYards,
  loadSignedPolicyPacks,
  signPolicyPack,
  verifySignedPolicyPack
} from "../src/policy-pack-federation.js";

test("a signed policy pack verifies, loads, and records pack version in decision evidence", () => {
  const key = createSigningKey("org-root");
  const request = createGoldenDecisionRequest({ phase: "apply" });
  const pack = createPolicyPack({
    id: "org-prod-baseline",
    version: "1.2.0",
    scope: "junction",
    targets: [{ kind: "junction", id: "junction:global-prod", environment: "prod" }],
    rules: [denyRule({ id: "no-prod-apply", tuple: requestTuple(request) })]
  });
  const envelope = signPolicyPack(pack, key);

  const loaded = loadSignedPolicyPacks([envelope], key.trustStore);
  const decision = evaluatePolicy(
    createBuiltInPolicyEngine(),
    request,
    createRuleset({
      policyPacks: loaded.policyPacks,
      rules: [
        defineTypescriptRule({
          id: "local-allow-prod-apply",
          when: () => true,
          decide: () => ({ effect: "allow", reason: "local rule would allow" })
        })
      ]
    })
  );

  assert.equal(loaded.ok, true, loaded.errors.join("\n"));
  assert.equal(decision.effect, "deny");
  assert.deepEqual(decision.evidence.policyIds, ["junction:org-prod-baseline@1.2.0/no-prod-apply"]);
});

test("unsigned, wrong-key, and tampered packs fail closed and are not loaded", () => {
  const key = createSigningKey("org-root");
  const wrongKey = createSigningKey("attacker");
  const pack = createPolicyPack({
    id: "org-prod-baseline",
    version: "1.2.0",
    scope: "junction",
    targets: [{ kind: "yard", id: "yard:aws-prod", environment: "prod" }],
    rules: [denyRule({ id: "no-unapproved-provider", tuple: "provider:unapproved:prod" })]
  });
  const signed = signPolicyPack(pack, key);
  const unsigned = { schemaVersion: signed.schemaVersion, pack: signed.pack };
  const tampered = structuredClone(signed);
  tampered.pack.rules[0].mode = "default";

  const unsignedResult = loadSignedPolicyPacks([unsigned], key.trustStore);
  const wrongKeyResult = loadSignedPolicyPacks([signed], wrongKey.trustStore);
  const tamperedResult = loadSignedPolicyPacks([tampered], key.trustStore);

  assert.equal(unsignedResult.ok, false);
  assert.deepEqual(unsignedResult.policyPacks, []);
  assert.match(unsignedResult.errors.join("\n"), /signature/);
  assert.equal(wrongKeyResult.ok, false);
  assert.deepEqual(wrongKeyResult.policyPacks, []);
  assert.match(wrongKeyResult.errors.join("\n"), /trusted key/);
  assert.equal(tamperedResult.ok, false);
  assert.deepEqual(tamperedResult.policyPacks, []);
  assert.match(tamperedResult.errors.join("\n"), /signature verification failed/);
});

test("extra unsigned pack fields fail closed", () => {
  const key = createSigningKey("org-root");
  const signed = signPolicyPack(
    createPolicyPack({
      id: "org-prod-baseline",
      version: "1.2.0",
      scope: "junction",
      targets: [{ kind: "yard", id: "yard:aws-prod", environment: "prod" }],
      rules: [denyRule({ id: "no-unapproved-provider", tuple: "provider:unapproved:prod" })]
    }),
    key
  );
  const smuggled = structuredClone(signed);
  smuggled.pack.expiresAt = "2026-12-31T00:00:00Z";

  const result = loadSignedPolicyPacks([smuggled], key.trustStore);

  assert.equal(result.ok, false);
  assert.deepEqual(result.policyPacks, []);
  assert.match(result.errors.join("\n"), /unexpected field expiresAt/);
});

test("a signed pack federated to two Yards composes to the same effective deny-set", () => {
  const key = createSigningKey("org-root");
  const envelope = signPolicyPack(
    createPolicyPack({
      id: "junction-policy",
      version: "2.0.0",
      scope: "junction",
      targets: [{ kind: "junction", id: "junction:global-prod", environment: "prod" }],
      rules: [denyRule({ id: "no-static-keys", tuple: "secret:static-key:runtime" })]
    }),
    key
  );

  const federation = federatePolicyPackToYards({
    envelope,
    junctionId: "junction:global-prod",
    yardIds: ["yard:aws-prod", "yard:azure-prod"]
  });
  const yardA = loadSignedPolicyPacks([federation.deliveries[0].envelope], key.trustStore);
  const yardB = loadSignedPolicyPacks([federation.deliveries[1].envelope], key.trustStore);
  const compositionA = composePolicyPacks(yardA.policyPacks);
  const compositionB = composePolicyPacks(yardB.policyPacks);

  assert.equal(federation.event.type, "junction.PolicyPropagated");
  assert.equal(federation.deliveries[0].envelopeDigest, federation.deliveries[1].envelopeDigest);
  assert.equal(yardA.ok, true, yardA.errors.join("\n"));
  assert.equal(yardB.ok, true, yardB.errors.join("\n"));
  assert.equal(canonicalJson(compositionA.effectiveDenySet), canonicalJson(compositionB.effectiveDenySet));
});

test("mandatory rules cannot be widened while default rules remain overridable", () => {
  const key = createSigningKey("org-root");
  const tuple = "deployment:hobo:deployment:apply:apply";
  const defaultDeny = signPolicyPack(
    createPolicyPack({
      id: "org-recommendation",
      version: "1.0.0",
      scope: "junction",
      targets: [{ kind: "junction", id: "junction:global-prod", environment: "staging" }],
      rules: [denyRule({ id: "prefer-no-apply", mode: "default", tuple })]
    }),
    key
  );
  const mandatoryDeny = signPolicyPack(
    createPolicyPack({
      id: "org-ceiling",
      version: "1.0.0",
      scope: "junction",
      targets: [{ kind: "junction", id: "junction:global-prod", environment: "prod" }],
      rules: [denyRule({ id: "no-apply", tuple })]
    }),
    key
  );
  const lowerAllow = signPolicyPack(
    createPolicyPack({
      id: "camp-exception",
      version: "1.0.0",
      scope: "camp",
      targets: [{ kind: "camp", id: "camp:checkout-prod", environment: "prod" }],
      rules: [allowRule({ id: "allow-apply", tuple })]
    }),
    key
  );

  const defaultComposition = composePolicyPacks(
    loadSignedPolicyPacks([defaultDeny, lowerAllow], key.trustStore).policyPacks
  );
  const mandatoryComposition = composePolicyPacks(
    loadSignedPolicyPacks([mandatoryDeny, lowerAllow], key.trustStore).policyPacks
  );

  assert.equal(defaultComposition.ok, true, defaultComposition.violations.join("\n"));
  assert.deepEqual(defaultComposition.effectiveDenySet, []);
  assert.equal(mandatoryComposition.ok, false);
  assert.match(mandatoryComposition.violations.join("\n"), /attempts to allow/);
  assert.deepEqual(
    mandatoryComposition.effectiveDenySet.map((entry) => entry.tuple),
    [tuple]
  );
});

test("mandatory flags are covered by the signature and conflicting federated packs union denies", () => {
  const key = createSigningKey("org-root");
  const eu = signPolicyPack(
    createPolicyPack({
      id: "eu-sovereign",
      version: "1.0.0",
      scope: "junction",
      targets: [{ kind: "junction", id: "junction:global-prod", environment: "prod" }],
      rules: [denyRule({ id: "eu-only", tuple: "region:non-eu:prod" })]
    }),
    key
  );
  const provider = signPolicyPack(
    createPolicyPack({
      id: "approved-provider",
      version: "1.0.0",
      scope: "junction",
      targets: [{ kind: "junction", id: "junction:global-prod", environment: "prod" }],
      rules: [denyRule({ id: "approved-only", tuple: "provider:unapproved:prod" })]
    }),
    key
  );
  const downgraded = structuredClone(eu);
  downgraded.pack.rules[0].mode = "default";

  const downgradedResult = verifySignedPolicyPack(downgraded, key.trustStore);
  const composed = composePolicyPacks(loadSignedPolicyPacks([provider, eu], key.trustStore).policyPacks);

  assert.equal(downgradedResult.ok, false);
  assert.match(downgradedResult.error, /signature verification failed/);
  assert.equal(composed.ok, true, composed.violations.join("\n"));
  assert.deepEqual(
    composed.effectiveDenySet.map((entry) => entry.tuple),
    ["provider:unapproved:prod", "region:non-eu:prod"]
  );
});

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
