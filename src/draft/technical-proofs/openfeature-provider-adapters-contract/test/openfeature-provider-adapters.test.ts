import assert from "node:assert/strict";
import { test } from "vitest";

import { createBuiltInFlagProvider } from "../../built-in-flag-store-contract/src/built-in-flag-store.js";
import {
  createCampFeatureFlagEvaluator,
  createFixtureVendorProvider,
  createOpenFeatureAdapter,
  createProviderRegistry,
  mapPrincipalRefToProviderContext
} from "../src/openfeature-provider-adapters.js";

const betaContext = Object.freeze({
  user: {
    kind: "user",
    id: "user_123",
    tenant: "tenant_a",
    claims: [
      { key: "segment", value: "beta" },
      { key: "email", value: "buyer@example.com" }
    ]
  },
  identity: {
    kind: "service",
    id: "spiffe://tenant-a/camp/prod/bindle/checkout",
    tenant: "tenant_a",
    claims: [{ key: "service", value: "checkout" }]
  },
  attributes: [{ key: "region", value: "us-east-1" }]
});

const controlContext = Object.freeze({
  user: {
    kind: "user",
    id: "user_456",
    tenant: "tenant_a",
    claims: [{ key: "segment", value: "control" }]
  },
  attributes: [{ key: "region", value: "us-east-1" }]
});

test("flagd, LaunchDarkly, and Unleash adapters pass the shared flag provider conformance suite", async () => {
  for (const [providerName, provider] of Object.entries(createConformanceProviders())) {
    await assertProviderConformance(provider, providerName);
  }
});

test("Matching switches a Camp from built-in to flagd without app code changing", async () => {
  const builtIn = createBuiltInFlagProvider({
    seq: 1,
    flags: {
      "new-checkout": {
        key: "new-checkout",
        valueType: "boolean",
        currentValue: false,
        targeting: []
      }
    }
  });
  const flagd = createOpenFeatureAdapter({
    providerKind: "flagd",
    client: createFixtureVendorProvider("flagd", {
      "new-checkout": { valueType: "boolean", value: true, variant: "enabled" }
    })
  });
  const registry = createProviderRegistry({ builtIn, flagd });

  async function checkoutRouteUsesFeatureFlag(flagClient) {
    return (await flagClient.getBooleanDetails("new-checkout", false, betaContext)).value;
  }

  const builtInClient = createCampFeatureFlagEvaluator({
    camp: "prod",
    matching: { camps: { prod: { featureFlagProvider: "builtIn" } } },
    registry
  });
  const flagdClient = createCampFeatureFlagEvaluator({
    camp: "prod",
    matching: { camps: { prod: { featureFlagProvider: "flagd" } } },
    registry
  });

  assert.equal(await checkoutRouteUsesFeatureFlag(builtInClient), false);
  assert.equal(await checkoutRouteUsesFeatureFlag(flagdClient), true);
  assert.equal(checkoutRouteUsesFeatureFlag.toString().includes("flagd"), false);
});

test("PrincipalRef evaluation context maps into each provider context", () => {
  assert.deepEqual(mapPrincipalRefToProviderContext("flagd", betaContext), {
    targetingKey: "user_123",
    kind: "user",
    attributes: {
      tenant: "tenant_a",
      identityKey: "spiffe://tenant-a/camp/prod/bindle/checkout",
      identityKind: "service",
      segment: "beta",
      email: "buyer@example.com",
      service: "checkout",
      region: "us-east-1"
    }
  });

  assert.deepEqual(mapPrincipalRefToProviderContext("launchdarkly", betaContext), {
    kind: "multi",
    user: {
      key: "user_123",
      kind: "user",
      tenant: "tenant_a",
      segment: "beta",
      email: "buyer@example.com"
    },
    service: {
      key: "spiffe://tenant-a/camp/prod/bindle/checkout",
      kind: "service",
      tenant: "tenant_a",
      service: "checkout"
    },
    custom: {
      region: "us-east-1"
    }
  });

  assert.deepEqual(mapPrincipalRefToProviderContext("unleash", betaContext), {
    userId: "user_123",
    sessionId: "spiffe://tenant-a/camp/prod/bindle/checkout",
    properties: {
      tenant: "tenant_a",
      userKind: "user",
      identityKind: "service",
      segment: "beta",
      email: "buyer@example.com",
      service: "checkout",
      region: "us-east-1"
    }
  });
});

test("provider outage falls back to the flag default instead of throwing", async () => {
  const provider = createOpenFeatureAdapter({
    providerKind: "launchdarkly",
    client: {
      async resolve() {
        throw new Error("LaunchDarkly stream unavailable");
      }
    }
  });

  const details = await provider.getBooleanDetails("kill-switch", true, betaContext);

  assert.equal(details.value, true);
  assert.equal(details.reason, "error");
  assert.deepEqual(details.error, {
    code: "provider-error",
    message: "LaunchDarkly stream unavailable"
  });
});

test("type-mismatched provider values default safely instead of propagating", async () => {
  const provider = createOpenFeatureAdapter({
    providerKind: "unleash",
    client: {
      async resolve() {
        return {
          value: "yes",
          variant: "bad-vendor-value",
          reason: "static"
        };
      }
    }
  });

  const details = await provider.getBooleanDetails("checkout-enabled", false, betaContext);

  assert.equal(details.value, false);
  assert.equal(details.reason, "error");
  assert.deepEqual(details.error, {
    code: "provider-type-mismatch",
    message: "unleash returned non-boolean value for checkout-enabled"
  });
});

test("hung providers are bounded by timeout and return the default", async () => {
  const provider = createOpenFeatureAdapter({
    providerKind: "flagd",
    timeoutMs: 10,
    client: {
      async resolve() {
        return new Promise(() => {});
      }
    }
  });

  const result = await Promise.race([
    provider.getStringDetails("checkout-theme", "safe", betaContext),
    new Promise((resolve) => setTimeout(() => resolve("hung-provider-timeout"), 1_000))
  ]);

  assert.notEqual(result, "hung-provider-timeout");
  const details = result;
  assert.equal(details.value, "safe");
  assert.equal(details.reason, "error");
  assert.equal(details.error.code, "provider-timeout");
});

test("vendor flag key collisions with HoBo-defined flags are rejected", () => {
  assert.throws(
    () =>
      createOpenFeatureAdapter({
        providerKind: "flagd",
        client: createFixtureVendorProvider("flagd", {
          "vendor-only": { valueType: "boolean", value: true },
          "checkout-theme": { valueType: "string", value: "shadowed" }
        }),
        hoboDefinedFlagKeys: ["checkout-enabled", "checkout-theme"]
      }),
    /flagd flag key collision: checkout-theme/
  );
});

function createConformanceProviders() {
  const ruleset = {
    "checkout-enabled": {
      valueType: "boolean",
      value: true,
      variant: "beta-on",
      targeting: [{ attribute: "segment", op: "equals", value: "beta" }]
    },
    "checkout-theme": {
      valueType: "string",
      value: "compact",
      variant: "compact"
    },
    "checkout-weight": {
      valueType: "number",
      value: 0.25,
      variant: "quarter"
    },
    "checkout-layout": {
      valueType: "object",
      value: { columns: 2, density: "tight" },
      variant: "tight"
    }
  };
  const builtInRuleset = {
    seq: 7,
    flags: Object.fromEntries(
      Object.entries(ruleset).map(([key, flag]) => [
        key,
        {
          key,
          valueType: flag.valueType,
          currentValue: flag.value,
          targeting: (flag.targeting ?? []).map((rule) => ({
            attribute: `user.${rule.attribute}`,
            op: rule.op,
            value: rule.value
          }))
        }
      ])
    )
  };

  return {
    builtIn: createBuiltInFlagProvider(builtInRuleset),
    flagd: createOpenFeatureAdapter({
      providerKind: "flagd",
      client: createFixtureVendorProvider("flagd", ruleset)
    }),
    launchdarkly: createOpenFeatureAdapter({
      providerKind: "launchdarkly",
      client: createFixtureVendorProvider("launchdarkly", ruleset)
    }),
    unleash: createOpenFeatureAdapter({
      providerKind: "unleash",
      client: createFixtureVendorProvider("unleash", ruleset)
    })
  };
}

async function assertProviderConformance(provider, providerName) {
  const enabled = await provider.getBooleanDetails("checkout-enabled", false, betaContext);
  assert.equal(enabled.value, true, providerName);
  assert.equal(enabled.reason, "targeting-match", providerName);

  const control = await provider.getBooleanDetails("checkout-enabled", false, controlContext);
  assert.equal(control.value, false, providerName);
  assert.equal(control.reason, "default", providerName);

  assert.equal(
    (await provider.getStringDetails("checkout-theme", "wide", betaContext)).value,
    "compact",
    providerName
  );
  assert.equal(
    (await provider.getNumberDetails("checkout-weight", 0, betaContext)).value,
    0.25,
    providerName
  );
  assert.deepEqual(
    (await provider.getObjectDetails("checkout-layout", {}, betaContext)).value,
    { columns: 2, density: "tight" },
    providerName
  );
  assert.equal(
    (await provider.getStringDetails("missing-flag", "fallback", betaContext)).value,
    "fallback",
    providerName
  );
}
