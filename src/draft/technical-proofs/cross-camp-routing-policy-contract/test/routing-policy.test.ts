import assert from "node:assert/strict";
import { test } from "vitest";

import { routeCrossCampTraffic } from "../src/cross-camp-routing-policy.js";

test("weighted policy programs the expected record set and RoutingChanged event", () => {
  const result = routeCrossCampTraffic({
    domain: "shop.com",
    recordName: "api.shop.com",
    recordType: "A",
    ttl: 60,
    policy: {
      kind: "weighted",
      targets: [
        { camp: "prod-us", weight: 80 },
        { camp: "prod-eu", weight: 20 },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10", region: "us-east", geo: "NA" }),
      camp("prod-eu", { value: "203.0.113.20", region: "eu-west", geo: "EU" }),
    ],
  });

  assert.equal(result.status, "routed");
  assert.deepEqual(result.record, {
    name: "api.shop.com",
    type: "A",
    ttl: 60,
    targets: [
      { camp: "prod-us", value: "198.51.100.10" },
      { camp: "prod-eu", value: "203.0.113.20" },
    ],
    policy: {
      kind: "weighted",
      targets: [
        { camp: "prod-us", weight: 80 },
        { camp: "prod-eu", weight: 20 },
      ],
    },
  });
  assert.deepEqual(result.events, [
    {
      type: "domain.RoutingChanged",
      domain: "shop.com",
      recordName: "api.shop.com",
      data: {
        policy: "weighted",
        targetCamps: ["prod-us", "prod-eu"],
        reason: "weighted split prod-us=80, prod-eu=20",
      },
    },
  ]);
});

test("weighted policy refuses an unvalidated split target", () => {
  const result = routeCrossCampTraffic({
    domain: "shop.com",
    recordName: "api.shop.com",
    policy: {
      kind: "weighted",
      targets: [
        { camp: "prod-us", weight: 80 },
        { camp: "prod-eu", weight: 20 },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10" }),
      camp("prod-eu", { value: "203.0.113.20", validated: false }),
    ],
  });

  assert.equal(result.status, "refused");
  assert.match(result.reason, /weighted target prod-eu is not validation-cleared and healthy/i);
  assert.equal("record" in result, false);
  assert.deepEqual(result.events, []);
});

test("failover flips only after sustained active-target failure to a validated healthy target", () => {
  const result = routeCrossCampTraffic({
    domain: "shop.com",
    recordName: "api.shop.com",
    activeCamp: "prod-us",
    sustainedFailureThreshold: 2,
    policy: {
      kind: "failover",
      targets: [
        { camp: "prod-us", priority: 1 },
        { camp: "prod-eu", priority: 2 },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10", healthy: false }),
      camp("prod-eu", { value: "203.0.113.20" }),
    ],
    healthSamples: [
      { camp: "prod-us", healthy: false, reason: "5xx above baseline" },
      { camp: "prod-us", healthy: false, reason: "5xx above baseline" },
    ],
  });

  assert.equal(result.status, "routed");
  assert.deepEqual(result.record, {
    name: "api.shop.com",
    type: "A",
    ttl: 60,
    targets: [{ camp: "prod-eu", value: "203.0.113.20" }],
    policy: {
      kind: "failover",
      targets: [{ camp: "prod-eu", priority: 1 }],
    },
  });
  assert.deepEqual(result.events, [
    {
      type: "domain.RoutingChanged",
      domain: "shop.com",
      recordName: "api.shop.com",
      data: {
        policy: "failover",
        targetCamp: "prod-eu",
        targetCamps: ["prod-eu"],
        reason: "active Camp prod-us failed 2 consecutive health checks; failed over to prod-eu",
      },
    },
  ]);
});

test("failover refuses a target that has not passed the validation gate", () => {
  const result = routeCrossCampTraffic({
    domain: "shop.com",
    recordName: "api.shop.com",
    activeCamp: "prod-us",
    sustainedFailureThreshold: 2,
    policy: {
      kind: "failover",
      targets: [
        { camp: "prod-us", priority: 1 },
        { camp: "prod-eu", priority: 2 },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10", healthy: false }),
      camp("prod-eu", { value: "203.0.113.20", validated: false }),
    ],
    healthSamples: [
      { camp: "prod-us", healthy: false },
      { camp: "prod-us", healthy: false },
    ],
  });

  assert.equal(result.status, "refused");
  assert.match(result.reason, /no validation-cleared failover target/i);
  assert.equal("record" in result, false);
  assert.deepEqual(result.events, []);
});

test("failover does not flip on a transient single-probe blip", () => {
  const result = routeCrossCampTraffic({
    domain: "shop.com",
    recordName: "api.shop.com",
    activeCamp: "prod-us",
    sustainedFailureThreshold: 2,
    policy: {
      kind: "failover",
      targets: [
        { camp: "prod-us", priority: 1 },
        { camp: "prod-eu", priority: 2 },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10" }),
      camp("prod-eu", { value: "203.0.113.20" }),
    ],
    healthSamples: [
      { camp: "prod-us", healthy: false, reason: "single probe timeout" },
      { camp: "prod-us", healthy: true },
    ],
  });

  assert.equal(result.status, "held");
  assert.equal("record" in result, false);
  assert.deepEqual(result.events, []);
});

test("latency policy picks the nearest healthy validated Camp", () => {
  const result = routeCrossCampTraffic({
    domain: "shop.com",
    recordName: "api.shop.com",
    policy: {
      kind: "latency",
      targets: [
        { camp: "prod-us", region: "us-east" },
        { camp: "prod-eu", region: "eu-west" },
        { camp: "prod-apac", region: "ap-south" },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10", region: "us-east", latencyMs: 22, healthy: false }),
      camp("prod-eu", { value: "203.0.113.20", region: "eu-west", latencyMs: 41 }),
      camp("prod-apac", { value: "192.0.2.30", region: "ap-south", latencyMs: 88 }),
    ],
  });

  assert.equal(result.status, "routed");
  assert.deepEqual(result.record, {
    name: "api.shop.com",
    type: "A",
    ttl: 60,
    targets: [{ camp: "prod-eu", value: "203.0.113.20" }],
    policy: {
      kind: "latency",
      targets: [{ camp: "prod-eu", region: "eu-west" }],
    },
  });
  assert.deepEqual(result.events, [
    {
      type: "domain.RoutingChanged",
      domain: "shop.com",
      recordName: "api.shop.com",
      data: {
        policy: "latency",
        targetCamp: "prod-eu",
        targetCamps: ["prod-eu"],
        reason: "lowest healthy latency target is prod-eu at 41ms",
      },
    },
  ]);
});

test("geo policy falls back to the nearest healthy validated Camp", () => {
  const result = routeCrossCampTraffic({
    domain: "shop.com",
    recordName: "api.shop.com",
    clientGeo: "NA",
    policy: {
      kind: "geo",
      targets: [
        { camp: "prod-us", geo: "NA" },
        { camp: "prod-eu", geo: "EU" },
        { camp: "prod-apac", geo: "APAC" },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10", geo: "NA", geoDistance: 0, healthy: false }),
      camp("prod-eu", { value: "203.0.113.20", geo: "EU", geoDistance: 70 }),
      camp("prod-apac", { value: "192.0.2.30", geo: "APAC", geoDistance: 150 }),
    ],
  });

  assert.equal(result.status, "routed");
  assert.deepEqual(result.record, {
    name: "api.shop.com",
    type: "A",
    ttl: 60,
    targets: [{ camp: "prod-eu", value: "203.0.113.20" }],
    policy: {
      kind: "geo",
      targets: [{ camp: "prod-eu", geo: "EU" }],
    },
  });
  assert.deepEqual(result.events, [
    {
      type: "domain.RoutingChanged",
      domain: "shop.com",
      recordName: "api.shop.com",
      data: {
        policy: "geo",
        targetCamp: "prod-eu",
        targetCamps: ["prod-eu"],
        reason: "nearest healthy geography for NA is prod-eu (EU)",
      },
    },
  ]);
});

function camp(campName, extra = {}) {
  return {
    camp: campName,
    validated: true,
    healthy: true,
    ...extra,
  };
}
