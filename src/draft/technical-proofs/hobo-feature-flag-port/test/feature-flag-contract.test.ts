import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import { createEvaluator, toJsonValue } from "../src/evaluator.js";

const generatedProviderPath = join(
  import.meta.dirname,
  "..",
  "generated",
  "interfaces",
  "hobo-feature-flag-provider.d.ts"
);

test("jco generates typed OpenFeature-style provider bindings", async () => {
  const bindings = await readFile(generatedProviderPath, "utf8");

  assert.match(bindings, /getBooleanDetails\(/);
  assert.match(bindings, /getStringDetails\(/);
  assert.match(bindings, /getNumberDetails\(/);
  assert.match(bindings, /getObjectDetails\(/);
  assert.match(bindings, /BooleanEvaluationDetails/);
  assert.match(bindings, /StringEvaluationDetails/);
  assert.match(bindings, /NumberEvaluationDetails/);
  assert.match(bindings, /ObjectEvaluationDetails/);

  const types = await readFile(
    join(
      import.meta.dirname,
      "..",
      "generated",
      "interfaces",
      "hobo-feature-flag-types.d.ts"
    ),
    "utf8"
  );
  assert.match(types, /variant\?: string/);
  assert.match(types, /error\?: EvaluationError/);
  assert.match(types, /'boolean' \| 'string' \| 'number' \| 'object'/);
});

test("detailed evaluation returns value, reason, variant, and no error", async () => {
  const evaluator = createEvaluator({
    async getBooleanDetails(flagKey) {
      return {
        flagKey,
        value: true,
        reason: "targeting-match",
        variant: "beta-users"
      };
    }
  });

  const details = await evaluator.getBooleanDetails("checkout", false, {
    user: {
      kind: "user",
      id: "user_123",
      tenant: "tenant_a",
      claims: [{ key: "segment", value: { tag: "string", val: "beta" } }]
    },
    identity: {
      kind: "service",
      id: "spiffe://tenant-a/camp/prod/bindle/checkout",
      tenant: "tenant_a",
      claims: []
    },
    attributes: []
  });

  assert.deepEqual(details, {
    flagKey: "checkout",
    value: true,
    reason: "targeting-match",
    variant: "beta-users",
    error: undefined
  });
});

test("provider errors fail safe to caller default for every value type", async () => {
  const cases = [
    ["getBooleanDetails", true],
    ["getStringDetails", "control"],
    ["getNumberDetails", 42],
    ["getObjectDetails", toJsonValue({ columns: 2 })]
  ];

  for (const [method, defaultValue] of cases) {
    const evaluator = createEvaluator({
      async [method]() {
        throw new Error("provider offline");
      }
    });

    const details = await evaluator[method]("flag-key", defaultValue);

    assert.deepEqual(details.value, defaultValue);
    assert.equal(details.reason, "error");
    assert.deepEqual(details.error, {
      code: "provider-error",
      message: "provider offline"
    });
  }
});

test("object flag rejects non-json values by returning the default with an error", async () => {
  const evaluator = createEvaluator({
    async getObjectDetails(flagKey) {
      return {
        flagKey,
        value: { encodedJson: "{\"amount\": NaN}" },
        reason: "static",
        variant: "bad-json"
      };
    }
  });

  const defaultValue = toJsonValue({ columns: 2 });
  const details = await evaluator.getObjectDetails("checkout-layout", defaultValue);

  assert.deepEqual(details.value, defaultValue);
  assert.equal(details.reason, "error");
  assert.match(details.error.message, /invalid object flag value/);
});

test("missing evaluation context is normalized and hooks see finally", async () => {
  const seen = [];
  const evaluator = createEvaluator(
    {
      async getNumberDetails(flagKey, defaultValue, context) {
        assert.deepEqual(context, { attributes: [] });
        return {
          flagKey,
          value: defaultValue + 1,
          reason: "static"
        };
      }
    },
    [
      {
        before(invocation) {
          seen.push(["before", invocation.flagKey, invocation.valueType]);
        },
        after(invocation, details) {
          seen.push(["after", invocation.flagKey, details.tag, details.val.value]);
        },
        finally(invocation) {
          seen.push(["finally", invocation.flagKey]);
        }
      }
    ]
  );

  const details = await evaluator.getNumberDetails("rollout-percent", 9);

  assert.equal(details.value, 10);
  assert.deepEqual(seen, [
    ["before", "rollout-percent", "number"],
    ["after", "rollout-percent", "number", 10],
    ["finally", "rollout-percent"]
  ]);
});
