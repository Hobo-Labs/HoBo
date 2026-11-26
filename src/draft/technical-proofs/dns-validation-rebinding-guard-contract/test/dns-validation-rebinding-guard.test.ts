import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createRecordingLiveZone,
  promotePinnedDnsChange,
  validateAndPinDnsEvidence,
} from "../src/dns-validation-rebinding-guard.js";

test("DNS rebinding after domain.Validated is caught before live-zone mutation", () => {
  const liveZone = createRecordingLiveZone();
  const validated = validateAndPinDnsEvidence(domainChange(), goodEvidence(), {
    liveZone,
    nowMs: 1_000,
  });

  const promotion = promotePinnedDnsChange(validated, {
    currentEvidence: goodEvidence({
      resolutions: [
        answer("resolver-a", "203.0.113.10", "serial-b"),
        answer("resolver-b", "198.51.100.66", "serial-b"),
        answer("resolver-c", "203.0.113.10", "serial-b"),
      ],
    }),
    liveZone,
    nowMs: 2_000,
  });

  assert.equal(validated.status, "validated");
  assert.equal(promotion.status, "blocked");
  assert.equal(promotion.failedCheck, "promote-recheck");
  assert.match(promotion.reason, /pinned validation evidence changed/i);
  assert.deepEqual(liveZone.inspect("shop.com"), []);
  assert.equal(JSON.stringify(liveZone.writes()).includes("198.51.100.66"), false);
  assert.equal(promotion.events.at(-1).type, "domain.ValidationFailed");
});

test("one spoofed resolver cannot satisfy the multi-vantage validation gate", () => {
  const result = validateAndPinDnsEvidence(
    domainChange(),
    goodEvidence({
      resolutions: [
        answer("resolver-a", "203.0.113.10"),
        answer("resolver-b", "198.51.100.66"),
        answer("resolver-c", "203.0.113.10"),
      ],
    }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failedCheck, "multi-vantage-resolve");
  assert.match(result.reason, /resolver-b/i);
  assert.match(result.reason, /198\.51\.100\.66/);
  assert.equal(result.evidenceDigest, undefined);
  assert.equal(result.events.at(-1).type, "domain.ValidationFailed");
});

test("sibling-name ACME challenge evidence cannot satisfy the exact FQDN gate", () => {
  const result = validateAndPinDnsEvidence(
    domainChange(),
    goodEvidence({
      acme: {
        fqdn: "api.shop.com",
        challengeName: "_acme-challenge.shop.com",
        keyThumbprint: "thumb-api",
        expectedKeyThumbprint: "thumb-api",
        csrIdentifier: "csr-api-shop",
        expectedCsrIdentifier: "csr-api-shop",
      },
    }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failedCheck, "acme-challenge");
  assert.match(result.reason, /_acme-challenge\.api\.shop\.com/);
});

test("validate-to-promote window is bounded and rechecked before write", () => {
  const liveZone = createRecordingLiveZone();
  const validated = validateAndPinDnsEvidence(domainChange(), goodEvidence(), {
    liveZone,
    nowMs: 10_000,
    maxValidateToPromoteMs: 60_000,
  });

  const promotion = promotePinnedDnsChange(validated, {
    currentEvidence: goodEvidence(),
    liveZone,
    nowMs: 70_001,
    maxValidateToPromoteMs: 60_000,
  });

  assert.equal(promotion.status, "blocked");
  assert.equal(promotion.failedCheck, "promote-recheck");
  assert.match(promotion.reason, /validate-to-promote window/i);
  assert.deepEqual(liveZone.inspect("shop.com"), []);
});

test("live-zone races between validate and promote fail closed", () => {
  const liveZone = createRecordingLiveZone();
  const validated = validateAndPinDnsEvidence(domainChange(), goodEvidence(), {
    liveZone,
    nowMs: 1_000,
  });

  liveZone.write("shop.com", {
    name: "api.shop.com",
    type: "A",
    ttl: 60,
    targets: [{ camp: "prod-us", value: "198.51.100.66" }],
  });

  const promotion = promotePinnedDnsChange(validated, {
    currentEvidence: goodEvidence(),
    liveZone,
    nowMs: 2_000,
  });

  assert.equal(promotion.status, "blocked");
  assert.equal(promotion.failedCheck, "live-zone-invariant");
  assert.match(promotion.reason, /live zone changed before promote/i);
  assert.deepEqual(liveZone.inspect("shop.com")[0].targets, [
    { camp: "prod-us", value: "198.51.100.66" },
  ]);
});

test("fresh pinned evidence promotes only the intended record", () => {
  const liveZone = createRecordingLiveZone();
  const validated = validateAndPinDnsEvidence(domainChange(), goodEvidence(), {
    liveZone,
    nowMs: 1_000,
  });

  const promotion = promotePinnedDnsChange(validated, {
    currentEvidence: goodEvidence(),
    liveZone,
    nowMs: 2_000,
  });

  assert.equal(promotion.status, "promoted");
  assert.equal(promotion.events.at(-1).type, "domain.RoutingChanged");
  assert.deepEqual(liveZone.inspect("shop.com"), [
    {
      name: "api.shop.com",
      type: "A",
      ttl: 60,
      targets: [{ camp: "prod-us", value: "203.0.113.10" }],
    },
  ]);
});

function domainChange() {
  return {
    changeId: "change-api-shop",
    domain: "shop.com",
    fqdn: "api.shop.com",
    record: {
      name: "api.shop.com",
      type: "A",
      ttl: 60,
      targets: [{ camp: "prod-us", value: "203.0.113.10" }],
    },
    expectedTargets: ["203.0.113.10"],
    expectedGatewayIdentity: "gateway/prod-us",
    expectedAcmeKeyThumbprint: "thumb-api",
    expectedCsrIdentifier: "csr-api-shop",
  };
}

function goodEvidence(overrides = {}) {
  return {
    resolutions: [
      answer("resolver-a", "203.0.113.10"),
      answer("resolver-b", "203.0.113.10"),
      answer("resolver-c", "203.0.113.10"),
    ],
    ttl: {
      waitedMs: 120_000,
      previousTtlMs: 60_000,
      candidateTtlMs: 60_000,
      stableSerialAcrossVantages: true,
    },
    acme: {
      fqdn: "api.shop.com",
      challengeName: "_acme-challenge.api.shop.com",
      keyThumbprint: "thumb-api",
      expectedKeyThumbprint: "thumb-api",
      csrIdentifier: "csr-api-shop",
      expectedCsrIdentifier: "csr-api-shop",
    },
    health: {
      probedHost: "api.shop.com",
      candidateHost: "api.shop.com",
      gatewayIdentity: "gateway/prod-us",
      expectedGatewayIdentity: "gateway/prod-us",
      status: 200,
    },
    ...overrides,
  };
}

function answer(vantage, target, serial = "serial-a") {
  return { vantage, targets: [target], serial };
}
