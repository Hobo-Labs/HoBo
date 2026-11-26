import assert from "node:assert/strict";
import { test } from "vitest";

import { realizeGateway } from "../../gateway-realization-contract/src/gateway-realization.js";
import { gatewayPort, service } from "../../hobo-gateway-port/src/gateway-contract.js";
import { createInMemoryDnsAdapter } from "../../hobo-dns-port-contract/src/dns-port.js";
import {
  createAcmeDns01Authority,
  createGatewayHealthProbe,
  createStaticResolver,
  domain,
  validateYardDomain,
} from "../../yard-domain-validation-contract/src/yard-domain-validation.js";
import {
  createCutoverDnsAdapter,
  runHealthCheckedCutover,
} from "../src/domain-cutover-saga.js";

test("clean cutover lowers TTL, waits out old TTL, shifts canary, then widens to 100%", async () => {
  const validation = await validatedDomainChange();
  const lastKnownGood = liveRecord({ target: "198.51.100.10", ttl: 300 });
  const candidate = liveRecord({ target: "203.0.113.10", ttl: 30 });
  const adapter = createCutoverDnsAdapter({
    domain: "shop.com",
    liveRecords: [lastKnownGood],
  });

  const result = await runHealthCheckedCutover({
    validation,
    adapter,
    domain: "shop.com",
    camp: "prod-us",
    recordName: "api.shop.com",
    candidateRecord: candidate,
    lastKnownGood,
    ttlPrecondition: {
      previousTtlSeconds: 300,
      loweredTtlSeconds: 30,
      waitedSeconds: 300,
    },
    healthSamples: [
      { healthy: true, sloOk: true },
      { healthy: true, sloOk: true },
    ],
  });

  assert.equal(result.status, "routed");
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "domain.TtlLowered",
      "domain.CutoverStarted",
      "domain.RoutingChanged",
      "domain.RoutingChanged",
    ],
  );
  assert.equal(result.events[0].data.effectiveRtoSeconds, 300);
  assert.equal(result.events[2].data.stage, "canary");
  assert.equal(result.events[2].data.record.policy.targets[0].weight, 90);
  assert.equal(result.events[2].data.record.policy.targets[1].weight, 10);
  assert.equal(result.events[3].data.stage, "complete");
  assert.equal(result.events[3].data.record.policy.targets[0].weight, 100);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), [finalRecord(candidate)]);
  assert.deepEqual(
    adapter.writes.map((write) => write.record),
    [loweredTtlRecord(lastKnownGood, 30), canaryRecord(lastKnownGood, candidate), finalRecord(candidate)],
  );
});

test("post-cutover health regression rolls back to the exact last-known-good record", async () => {
  const validation = await validatedDomainChange();
  const lastKnownGood = liveRecord({
    target: "198.51.100.10",
    ttl: 300,
    extra: {
      campOverrides: [
        {
          camp: "prod-eu",
          targets: [{ camp: "prod-eu", value: "198.51.100.20" }],
        },
      ],
    },
  });
  const candidate = liveRecord({ target: "203.0.113.10", ttl: 30 });
  const adapter = createCutoverDnsAdapter({
    domain: "shop.com",
    liveRecords: [lastKnownGood],
  });

  const result = await runHealthCheckedCutover({
    validation,
    adapter,
    domain: "shop.com",
    camp: "prod-us",
    recordName: "api.shop.com",
    candidateRecord: candidate,
    lastKnownGood,
    ttlPrecondition: {
      previousTtlSeconds: 300,
      loweredTtlSeconds: 30,
      waitedSeconds: 300,
    },
    healthSamples: [
      { healthy: false, sloOk: true, reason: "checkout 5xx above baseline" },
      { healthy: false, sloOk: true, reason: "checkout 5xx above baseline" },
    ],
    hysteresis: { consecutiveFailuresToRollback: 2 },
  });

  assert.equal(result.status, "rolled-back");
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "domain.TtlLowered",
      "domain.CutoverStarted",
      "domain.RoutingChanged",
      "domain.RolledBack",
    ],
  );
  assert.match(result.events.at(-1).data.reason, /checkout 5xx/);
  assert.equal(result.events.at(-1).data.effectiveRtoSeconds, 300);
  assert.deepEqual(result.events.at(-1).data.record, lastKnownGood);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), [lastKnownGood]);
});

test("cutover is refused when TTL lowering was not propagated before shifting traffic", async () => {
  const validation = await validatedDomainChange();
  const lastKnownGood = liveRecord({ target: "198.51.100.10", ttl: 300 });
  const adapter = createCutoverDnsAdapter({
    domain: "shop.com",
    liveRecords: [lastKnownGood],
  });

  const result = await runHealthCheckedCutover({
    validation,
    adapter,
    domain: "shop.com",
    camp: "prod-us",
    recordName: "api.shop.com",
    candidateRecord: liveRecord({ target: "203.0.113.10", ttl: 30 }),
    lastKnownGood,
    ttlPrecondition: {
      previousTtlSeconds: 300,
      loweredTtlSeconds: 30,
      waitedSeconds: 60,
    },
    healthSamples: [{ healthy: true, sloOk: true }],
  });

  assert.equal(result.status, "refused");
  assert.match(result.reason, /waited 60s.*previous TTL 300s/i);
  assert.deepEqual(result.events.map((event) => event.type), ["domain.CutoverRefused"]);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), [lastKnownGood]);
  assert.deepEqual(adapter.writes, []);
});

test("cutover is refused before the domain validation gate passes", async () => {
  const lastKnownGood = liveRecord({ target: "198.51.100.10", ttl: 300 });
  const adapter = createCutoverDnsAdapter({
    domain: "shop.com",
    liveRecords: [lastKnownGood],
  });

  const result = await runHealthCheckedCutover({
    validation: { status: "failed", changeId: "domain-change-1" },
    adapter,
    domain: "shop.com",
    camp: "prod-us",
    recordName: "api.shop.com",
    candidateRecord: liveRecord({ target: "203.0.113.10", ttl: 30 }),
    lastKnownGood,
    ttlPrecondition: {
      previousTtlSeconds: 300,
      loweredTtlSeconds: 30,
      waitedSeconds: 300,
    },
    healthSamples: [{ healthy: true, sloOk: true }],
  });

  assert.equal(result.status, "refused");
  assert.match(result.reason, /validated domain change/i);
  assert.deepEqual(result.events.map((event) => event.type), ["domain.CutoverRefused"]);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), [lastKnownGood]);
  assert.deepEqual(adapter.writes, []);
});

test("rollback cannot use a guessed last-known-good record", async () => {
  const validation = await validatedDomainChange();
  const actualLive = liveRecord({ target: "198.51.100.10", ttl: 300 });
  const guessedLastKnownGood = liveRecord({ target: "198.51.100.99", ttl: 300 });
  const adapter = createCutoverDnsAdapter({
    domain: "shop.com",
    liveRecords: [actualLive],
  });

  const result = await runHealthCheckedCutover({
    validation,
    adapter,
    domain: "shop.com",
    camp: "prod-us",
    recordName: "api.shop.com",
    candidateRecord: liveRecord({ target: "203.0.113.10", ttl: 30 }),
    lastKnownGood: guessedLastKnownGood,
    ttlPrecondition: {
      previousTtlSeconds: 300,
      loweredTtlSeconds: 30,
      waitedSeconds: 300,
    },
    healthSamples: [
      { healthy: false, sloOk: true },
      { healthy: false, sloOk: true },
    ],
  });

  assert.equal(result.status, "refused");
  assert.match(result.reason, /last-known-good.*current live zone/i);
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), [actualLive]);
  assert.deepEqual(adapter.writes, []);
});

test("flapping health stays in canary watch instead of thrashing rollback", async () => {
  const validation = await validatedDomainChange();
  const lastKnownGood = liveRecord({ target: "198.51.100.10", ttl: 300 });
  const candidate = liveRecord({ target: "203.0.113.10", ttl: 30 });
  const adapter = createCutoverDnsAdapter({
    domain: "shop.com",
    liveRecords: [lastKnownGood],
  });

  const result = await runHealthCheckedCutover({
    validation,
    adapter,
    domain: "shop.com",
    camp: "prod-us",
    recordName: "api.shop.com",
    candidateRecord: candidate,
    lastKnownGood,
    ttlPrecondition: {
      previousTtlSeconds: 300,
      loweredTtlSeconds: 30,
      waitedSeconds: 300,
    },
    healthSamples: [
      { healthy: false, sloOk: true },
      { healthy: true, sloOk: true },
      { healthy: false, sloOk: true },
      { healthy: true, sloOk: true },
    ],
    hysteresis: { consecutiveFailuresToRollback: 2 },
  });

  assert.equal(result.status, "watching");
  assert(!result.events.some((event) => event.type === "domain.RolledBack"));
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), [canaryRecord(lastKnownGood, candidate)]);
});

async function validatedDomainChange() {
  const adapter = createInMemoryDnsAdapter({ id: "shadow-dns" });
  return validateYardDomain(validDomain(), {
    adapter,
    resolvers: [
      createStaticResolver("cloudflare", { "api.shop.com": ["203.0.113.10"] }),
      createStaticResolver("google", { "api.shop.com": ["203.0.113.10"] }),
    ],
    propagation: { waitedSeconds: 30 },
    acme: createAcmeDns01Authority({
      "_acme-challenge.shop.com": "ready",
    }),
    gateway: createGatewayHealthProbe(validGateway()),
  });
}

function validDomain() {
  return domain("shop.com")
    .ownedByYard("yard-aws", { provider: "aws", defaultCamp: "prod-us" })
    .routes(service("checkout-api"), {
      path: "/api",
      recordName: "api.shop.com",
      recordType: "A",
      ttl: 30,
      target: "203.0.113.10",
    })
    .build();
}

function validGateway() {
  return realizeGateway(
    gatewayPort("shop-edge").terminateTls().route("shop.com", "/api", service("checkout-api")).build(),
    { health: { "checkout-api": "healthy" } },
  );
}

function liveRecord({ target, ttl, extra = {} }) {
  return {
    name: "api.shop.com",
    type: "A",
    ttl,
    targets: [{ camp: "prod-us", value: target }],
    policy: {
      kind: "weighted",
      targets: [{ camp: "prod-us", weight: 100 }],
    },
    ...extra,
  };
}

function loweredTtlRecord(record, ttl) {
  return {
    ...structuredClone(record),
    ttl,
  };
}

function canaryRecord(lastKnownGood, candidate) {
  return {
    ...structuredClone(candidate),
    targets: [...lastKnownGood.targets, ...candidate.targets],
    policy: {
      kind: "weighted",
      targets: [
        { camp: lastKnownGood.targets[0].camp, weight: 90 },
        { camp: candidate.targets[0].camp, weight: 10 },
      ],
    },
  };
}

function finalRecord(candidate) {
  return {
    ...structuredClone(candidate),
    policy: {
      kind: "weighted",
      targets: [{ camp: candidate.targets[0].camp, weight: 100 }],
    },
  };
}
