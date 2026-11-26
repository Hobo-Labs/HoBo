import assert from "node:assert/strict";
import { test } from "vitest";

import { createInMemoryDnsAdapter } from "../../hobo-dns-port-contract/src/dns-port.js";
import {
  federateJunctionDomain,
  validateJunctionDomainPlan
} from "../src/junction-federated-domain.js";

test("federates a cross-cloud domain into per-Yard DNS and certificate halves", async () => {
  const adapters = fixtureAdapters();
  const result = await federateJunctionDomain(fixtureDomain({ adapters }));

  assert.equal(result.status, "ready");
  assert.equal(result.plan.event.type, "junction.DomainFederated");
  assert.deepEqual(Object.keys(result.plan.deliveriesByYard), ["yard-aws-prod", "yard-azure-prod"]);
  assert.deepEqual(
    result.plan.deliveriesByYard["yard-aws-prod"].map((delivery) => delivery.body.yardId),
    ["yard-aws-prod"]
  );
  assert.deepEqual(
    result.plan.deliveriesByYard["yard-azure-prod"].map((delivery) => delivery.body.yardId),
    ["yard-azure-prod"]
  );
  assert.equal(result.plan.validationByYard["yard-aws-prod"].status, "validated");
  assert.equal(result.plan.validationByYard["yard-azure-prod"].status, "validated");
  assert.equal(adapters.aws.inspectLiveZone("shop.com").length, 0);
  assert.equal(adapters.azure.inspectLiveZone("shop.com").length, 0);
  assert.equal(adapters.aws.inspectShadowZone("shop.com")[0].targets[0].value, "198.51.100.10");
  assert.equal(adapters.azure.inspectShadowZone("shop.com")[0].targets[0].value, "203.0.113.20");
  assert.deepEqual(validateJunctionDomainPlan(result.plan), { ok: true });
});

test("routes cross-Yard failover only to a validation-cleared target", async () => {
  const result = await federateJunctionDomain(fixtureDomain({
    activeCamp: "prod-aws",
    healthSamples: [
      { camp: "prod-aws", healthy: false, sloOk: false },
      { camp: "prod-aws", healthy: false, sloOk: false }
    ]
  }));

  assert.equal(result.status, "ready");
  assert.equal(result.plan.routing.status, "routed");
  assert.equal(result.plan.routing.record.targets[0].camp, "prod-azure");
  assert.equal(result.plan.routing.events[0].type, "domain.RoutingChanged");
});

test("blocks live promotion when any Yard half fails its validation gate", async () => {
  const adapters = fixtureAdapters();
  const result = await federateJunctionDomain(fixtureDomain({
    adapters,
    yardOverrides: {
      "yard-azure-prod": {
        validationFixtures: {
          "endpoint-health": { status: 503 }
        }
      }
    }
  }));

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "junction.domain.validation-failed");
  assert.equal(result.failedYardId, "yard-azure-prod");
  assert.equal(result.validationByYard["yard-azure-prod"].failedCheck, "endpoint-health");
  assert.equal(adapters.aws.inspectLiveZone("shop.com").length, 0);
  assert.equal(adapters.azure.inspectLiveZone("shop.com").length, 0);
});

test("rejects a plan that places one Yard's DNS or cert half in another Yard", async () => {
  const result = await federateJunctionDomain(fixtureDomain());
  assert.equal(result.status, "ready");

  const leaked = {
    ...result.plan,
    deliveriesByYard: {
      ...result.plan.deliveriesByYard,
      "yard-aws-prod": [
        result.plan.deliveriesByYard["yard-azure-prod"][0]
      ]
    }
  };

  assert.deepEqual(validateJunctionDomainPlan(leaked), {
    ok: false,
    code: "junction.domain.yard-leak",
    reason: "delivery for yard-azure-prod cannot be placed in yard-aws-prod domain log"
  });
});

test("rejects a plan that omits one Yard's domain half", async () => {
  const result = await federateJunctionDomain(fixtureDomain());
  assert.equal(result.status, "ready");

  const incomplete = {
    ...result.plan,
    deliveriesByYard: {
      "yard-aws-prod": result.plan.deliveriesByYard["yard-aws-prod"]
    }
  };

  assert.deepEqual(validateJunctionDomainPlan(incomplete), {
    ok: false,
    code: "junction.domain.delivery-incomplete",
    reason: "delivery projection must contain exactly one domain half for every member Yard"
  });
});

test("refuses to front a residency-pinned Camp from a forbidden region", async () => {
  const result = await federateJunctionDomain(fixtureDomain({
    yardOverrides: {
      "yard-azure-prod": {
        residency: {
          tag: "eu-only",
          allowedRegions: ["westeurope"]
        }
      }
    }
  }));

  assert.deepEqual(result, {
    status: "refused",
    code: "junction.domain.residency-forbidden",
    reason: "yard yard-azure-prod in eastus cannot front residency eu-only domain shop.com"
  });
});

function fixtureDomain(options = {}) {
  const adapters = options.adapters ?? fixtureAdapters();
  const yardOverrides = options.yardOverrides ?? {};

  return {
    junctionId: "junction-shop-prod",
    domain: "shop.com",
    recordName: "shop.com",
    activeCamp: options.activeCamp ?? "prod-aws",
    healthSamples: options.healthSamples ?? [],
    yards: [
      yard({
        yardId: "yard-aws-prod",
        provider: "aws",
        region: "us-east-1",
        camp: "prod-aws",
        target: "198.51.100.10",
        dnsAdapter: adapters.aws,
        ...yardOverrides["yard-aws-prod"]
      }),
      yard({
        yardId: "yard-azure-prod",
        provider: "azure",
        region: "eastus",
        camp: "prod-azure",
        target: "203.0.113.20",
        dnsAdapter: adapters.azure,
        ...yardOverrides["yard-azure-prod"]
      })
    ]
  };
}

function yard(input) {
  const validationFixtures = {
    "multi-vantage-resolve": {
      vantagePoints: [`${input.provider}-resolver-a`, `${input.provider}-resolver-b`],
      expected: input.target
    },
    "ttl-aware-propagation": {
      ttlSeconds: 60,
      waitedSeconds: 60
    },
    "acme-challenge": {
      challengeName: "_acme-challenge.shop.com"
    },
    "endpoint-health": {
      status: 200
    },
    ...input.validationFixtures
  };

  return {
    residency: {
      tag: "us-only",
      allowedRegions: ["us-east-1", "eastus"]
    },
    ...input,
    validationFixtures
  };
}

function fixtureAdapters() {
  return {
    aws: createInMemoryDnsAdapter({ id: "aws-route53" }),
    azure: createInMemoryDnsAdapter({ id: "azure-dns" })
  };
}
