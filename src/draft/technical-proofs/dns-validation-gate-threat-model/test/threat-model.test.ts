import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DNS_VALIDATION_THREAT_MODEL_SCHEMA,
  REQUIRED_ATTACKS,
  createDnsValidationThreatModel,
  evaluateDnsAttack,
  validateDnsValidationThreatModel,
} from "../src/threat-model.js";

test("recommended threat model covers every HOBO-189 attack with minimum defeating parameters", () => {
  const model = createDnsValidationThreatModel();
  const parsed = validateDnsValidationThreatModel(model);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(parsed.model.schema, DNS_VALIDATION_THREAT_MODEL_SCHEMA);
  assert.equal(parsed.model.invariants.liveZoneUntouchedUntilValidated, true);
  assert.equal(parsed.model.invariants.failedOrUnfinishedCheckBlocksPromotion, true);
  assert.equal(parsed.model.controls["multi-vantage-resolve"].minimumVantagePoints, 3);
  assert.equal(parsed.model.controls["multi-vantage-resolve"].disagreementPolicy, "fail-closed");
  assert.deepEqual(
    parsed.model.attacks.map((attack) => attack.slug).sort(),
    [...REQUIRED_ATTACKS].sort(),
  );
  assert.ok(parsed.model.residualRisks.some((risk) => /TTL/i.test(risk)));
});

test("single honest-looking vantage point is not sufficient", () => {
  const model = createDnsValidationThreatModel();

  const singleVantage = evaluateDnsAttack(model, "lying-resolver", {
    "multi-vantage-resolve": {
      independent: true,
      answersByVantage: [{ vantage: "resolver-a", targets: ["203.0.113.10"] }],
    },
  });

  assert.equal(singleVantage.outcome, "promotion-blocked");
  assert.match(singleVantage.failures.join("\n"), /at least 3 independent vantage/);

  const disagreement = evaluateDnsAttack(model, "lying-resolver", {
    "multi-vantage-resolve": {
      independent: true,
      answersByVantage: [
        { vantage: "resolver-a", targets: ["203.0.113.10"] },
        { vantage: "resolver-b", targets: ["198.51.100.99"] },
        { vantage: "resolver-c", targets: ["203.0.113.10"] },
      ],
    },
  });

  assert.equal(disagreement.outcome, "promotion-blocked");
  assert.match(disagreement.failures.join("\n"), /answers disagree/);
});

test("poisoned propagation cache is caught by TTL and stable-serial requirements", () => {
  const model = createDnsValidationThreatModel();
  const poisoned = evaluateDnsAttack(model, "propagation-cache-poisoning", {
    "multi-vantage-resolve": {
      independent: true,
      answersByVantage: [
        { vantage: "resolver-a", targets: ["203.0.113.10"] },
        { vantage: "resolver-b", targets: ["203.0.113.10"] },
        { vantage: "resolver-c", targets: ["203.0.113.10"] },
      ],
    },
    "ttl-aware-propagation": {
      waitedSeconds: 30,
      previousTtlSeconds: 60,
      candidateTtlSeconds: 60,
      stableSerialAcrossVantages: false,
    },
  });

  assert.equal(poisoned.outcome, "promotion-blocked");
  assert.match(poisonedText(poisoned), /previous TTL has not elapsed/);
  assert.match(poisonedText(poisoned), /stable serial/);
});

test("ACME challenge evidence must bind to the exact FQDN key and CSR", () => {
  const model = createDnsValidationThreatModel();
  const siblingChallenge = evaluateDnsAttack(model, "acme-challenge-misbinding", {
    "acme-challenge": {
      fqdn: "api.shop.com",
      challengeName: "_acme-challenge.shop.com",
      keyThumbprint: "thumb-a",
      expectedKeyThumbprint: "thumb-a",
      csrIdentifier: "csr-api-shop",
      expectedCsrIdentifier: "csr-api-shop",
    },
  });

  assert.equal(siblingChallenge.outcome, "promotion-blocked");
  assert.match(siblingChallenge.failures.join("\n"), /exactly match fqdn/);

  const exactChallenge = evaluateDnsAttack(model, "acme-challenge-misbinding", {
    "acme-challenge": {
      fqdn: "api.shop.com",
      challengeName: "_acme-challenge.api.shop.com",
      keyThumbprint: "thumb-a",
      expectedKeyThumbprint: "thumb-a",
      csrIdentifier: "csr-api-shop",
      expectedCsrIdentifier: "csr-api-shop",
    },
  });

  assert.equal(exactChallenge.outcome, "defeated-by-gate");
  assert.deepEqual(exactChallenge.failures, []);
});

test("validate-to-promote TOCTOU requires pinned evidence recheck before live write", () => {
  const model = createDnsValidationThreatModel();

  const rebindingRace = evaluateDnsAttack(model, "validate-promote-toc", {
    "promote-recheck": {
      pinnedDigest: "sha256:validated",
      currentDigest: "sha256:attacker",
      liveZoneMutatedBeforePromote: false,
      windowSeconds: 10,
    },
  });

  assert.equal(rebindingRace.outcome, "promotion-blocked");
  assert.match(rebindingRace.failures.join("\n"), /evidence changed/);

  const stillPinned = evaluateDnsAttack(model, "validate-promote-toc", {
    "promote-recheck": {
      pinnedDigest: "sha256:validated",
      currentDigest: "sha256:validated",
      liveZoneMutatedBeforePromote: false,
      windowSeconds: 10,
    },
  });

  assert.equal(stillPinned.outcome, "defeated-by-gate");
  assert.deepEqual(stillPinned.failures, []);
});

test("model fails if the live-zone invariant or attack coverage is weakened", () => {
  const weakened = validateDnsValidationThreatModel(
    createDnsValidationThreatModel({
      invariants: {
        liveZoneUntouchedUntilValidated: false,
      },
      attacks: [],
    }),
  );

  assert.equal(weakened.ok, false);
  assert.match(weakened.errors.join("\n"), /liveZoneUntouchedUntilValidated/);
  assert.match(weakened.errors.join("\n"), /missing attack: lying-resolver/);
});

function poisonedText(result) {
  return result.failures.join("\n");
}
