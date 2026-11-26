import assert from "node:assert/strict";
import { test } from "vitest";

import { createDomainValidationGate } from "../../domain-validation-gate-contract/src/domain-validation-gate.js";
import { realizeGateway } from "../../gateway-realization-contract/src/gateway-realization.js";
import { gatewayPort, service } from "../../hobo-gateway-port/src/gateway-contract.js";
import { createInMemoryDnsAdapter } from "../../hobo-dns-port-contract/src/dns-port.js";
import {
  createAcmeDns01Authority,
  createGatewayHealthProbe,
  createStaticResolver,
  createYardDomainValidationChecks,
  domain,
  validateYardDomain,
} from "../src/yard-domain-validation.js";

test("Yard-level domain declaration runs all four checks through the shadow validation gate", async () => {
  const adapter = createInMemoryDnsAdapter({ id: "dns-local" });
  const declaration = validDomain();
  const healthProbes = [];

  const result = await validateYardDomain(
    declaration,
    validValidationInputs({
      adapter,
      gateway: {
        probe(request) {
          healthProbes.push(request);
          return createGatewayHealthProbe(validGateway()).probe(request);
        },
      },
    }),
  );

  assert.equal(declaration.kind, "yard-domain");
  assert.equal(declaration.scope, "yard");
  assert.equal(declaration.yard.id, "yard-aws");
  assert.equal(declaration.yard.provider, "aws");
  assert.deepEqual(declaration.campOverrides, [
    {
      camp: "prod-eu",
      recordName: "api.shop.com",
      targets: [{ camp: "prod-eu", value: "203.0.113.20" }],
    },
  ]);
  assert.equal(result.status, "validated");
  assert.deepEqual(result.events.map((event) => event.type), [
    "domain.ValidationStarted",
    "domain.Validated",
  ]);
  assert.deepEqual(
    result.events[1].data.checks.map((check) => check.kind),
    ["multi-vantage-resolve", "ttl-aware-propagation", "acme-challenge", "endpoint-health"],
  );
  assert.equal(result.shadowChange.zone, "shadow");
  assert.deepEqual(adapter.inspectLiveZone("shop.com"), []);
  assert.deepEqual(adapter.inspectShadowZone("shop.com"), [
    {
      name: "api.shop.com",
      type: "A",
      ttl: 60,
      targets: [{ camp: "prod-us", value: "203.0.113.10" }],
      policy: {
        kind: "failover",
        targets: [{ camp: "prod-us", priority: 1 }],
      },
      campOverrides: [
        {
          camp: "prod-eu",
          targets: [{ camp: "prod-eu", value: "203.0.113.20" }],
        },
      ],
    },
  ]);
  assert.deepEqual([...new Set(healthProbes.map((request) => request.camp))].sort(), [
    "prod-eu",
    "prod-us",
  ]);
});

for (const scenario of [
  {
    name: "split-horizon resolver disagreement",
    failedCheck: "multi-vantage-resolve",
    inputs: ({ adapter }) =>
      validValidationInputs({
        adapter,
        resolvers: [
          createStaticResolver("vantage-a", { "api.shop.com": ["203.0.113.10"] }),
          createStaticResolver("vantage-b", { "api.shop.com": ["198.51.100.10"] }),
        ],
      }),
    reason: /split-horizon|disagreed|expected 203\.0\.113\.10/i,
  },
  {
    name: "premature TTL propagation",
    failedCheck: "ttl-aware-propagation",
    inputs: ({ adapter }) =>
      validValidationInputs({
        adapter,
        propagation: { waitedSeconds: 30 },
    }),
    reason: /TTL.*30s.*60s|waited/i,
  },
  {
    name: "post-TTL resolver invisibility",
    failedCheck: "ttl-aware-propagation",
    inputs: ({ adapter }) =>
      validValidationInputs({
        adapter,
        resolvers: [
          createStaticResolver("vantage-a", { "api.shop.com": ["203.0.113.10"] }, {
            afterTtlRecords: { "api.shop.com": [] },
          }),
          createStaticResolver("vantage-b", { "api.shop.com": ["203.0.113.10"] }, {
            afterTtlRecords: { "api.shop.com": [] },
          }),
        ],
      }),
    reason: /not visible after TTL/i,
  },
  {
    name: "missing DNS-01 challenge",
    failedCheck: "acme-challenge",
    inputs: ({ adapter }) =>
      validValidationInputs({
        adapter,
        acme: createAcmeDns01Authority({}),
      }),
    reason: /ACME|challenge/i,
  },
  {
    name: "unhealthy gateway endpoint",
    failedCheck: "endpoint-health",
    inputs: ({ adapter }) =>
      validValidationInputs({
        adapter,
        gateway: createGatewayHealthProbe(validGateway({ health: { "checkout-api": "unhealthy" } })),
      }),
    reason: /unhealthy|503/i,
  },
]) {
  test(`forced ${scenario.name} emits domain.ValidationFailed naming ${scenario.failedCheck}`, async () => {
    const adapter = createInMemoryDnsAdapter({ id: `dns-${scenario.failedCheck}` });

    const result = await validateYardDomain(validDomain(), scenario.inputs({ adapter }));

    assert.equal(result.status, "failed");
    assert.equal(result.failedCheck, scenario.failedCheck);
    assert.match(result.reason, scenario.reason);
    assert.deepEqual(result.events.map((event) => event.type), [
      "domain.ValidationStarted",
      "domain.ValidationFailed",
    ]);
    assert.equal(result.events[1].data.failedCheck, scenario.failedCheck);
    assert.deepEqual(adapter.inspectLiveZone("shop.com"), []);
    assert(!result.events.some((event) => event.type === "domain.CutoverStarted"));
    assert(!result.events.some((event) => event.type === "domain.RoutingChanged"));
  });
}

test("validator is explicitly plugged into the HOBO-113 gate orchestrator", async () => {
  const adapter = createInMemoryDnsAdapter({ id: "dns-gate-composition" });
  const declaration = validDomain();
  const inputs = validValidationInputs({ adapter });
  const gate = createDomainValidationGate({
    checks: createYardDomainValidationChecks(declaration, inputs),
  });

  const result = await validateYardDomain(declaration, {
    ...inputs,
    gate,
  });

  assert.equal(result.status, "validated");
  assert.equal(result.events[0].type, "domain.ValidationStarted");
  assert.equal(result.events[1].type, "domain.Validated");
});

function validDomain() {
  return domain("shop.com")
    .ownedByYard("yard-aws", { provider: "aws", defaultCamp: "prod-us" })
    .routes(service("checkout-api"), {
      path: "/api",
      recordName: "api.shop.com",
      recordType: "A",
      ttl: 60,
      target: "203.0.113.10",
    })
    .routing("failover", [{ camp: "prod-us", priority: 1 }])
    .campOverride("prod-eu", {
      recordName: "api.shop.com",
      target: "203.0.113.20",
    })
    .build();
}

function validValidationInputs(overrides = {}) {
  const adapter = overrides.adapter ?? createInMemoryDnsAdapter({ id: "dns-default" });
  return {
    adapter,
    resolvers:
      overrides.resolvers ??
      [
        createStaticResolver("cloudflare", { "api.shop.com": ["203.0.113.10"] }),
        createStaticResolver("google", { "api.shop.com": ["203.0.113.10"] }),
      ],
    propagation: overrides.propagation ?? { waitedSeconds: 60 },
    acme:
      overrides.acme ??
      createAcmeDns01Authority({
        "_acme-challenge.shop.com": "ready",
      }),
    gateway: overrides.gateway ?? createGatewayHealthProbe(validGateway()),
    checks: overrides.checks,
    gate: overrides.gate,
  };
}

function validGateway(options = {}) {
  return realizeGateway(
    gatewayPort("shop-edge").terminateTls().route("shop.com", "/api", service("checkout-api")).build(),
    { health: { "checkout-api": "healthy", ...options.health } },
  );
}
