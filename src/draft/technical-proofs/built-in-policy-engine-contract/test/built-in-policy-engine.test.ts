import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  allowRule,
  definePolicyPack,
  denyRule,
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import { canonicalJson, POLICY_IR_SCHEMA_VERSION } from "../../hobo-policy-ir-contract/src/policy-ir.js";

import {
  BUILT_IN_POLICY_ENGINE_ID,
  createBuiltInPolicyEngine,
  createGoldenDecisionRequest,
  createRuleset,
  defineTypescriptRule,
  evaluateAndRecordPolicyDecision,
  evaluatePolicy,
  requestTuple,
} from "../src/built-in-policy-engine.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

test("typed declarations compile a TypeScript rule consumer", () => {
  const result = spawnSync(
    process.execPath,
    [tscPath, "--noEmit", "--project", "tsconfig.types.json"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: false,
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("ruleset and request fixtures produce an allow decision with deterministic evidence", () => {
  const engine = createBuiltInPolicyEngine();
  const request = createGoldenDecisionRequest();
  const ruleset = createRuleset({
    id: "policy-pack:deployment",
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "allow-deployment-plan",
        when: ({ request: candidate }) => candidate.action === "hobo:deployment:apply" && candidate.phase === "plan",
        decide: () => ({ effect: "allow", reason: "deployment plan passed policy" }),
      }),
    ],
  });

  const first = evaluatePolicy(engine, request, ruleset);
  const second = evaluatePolicy(engine, structuredClone(request), ruleset);

  assert.equal(first.effect, "allow");
  assert.equal(first.schemaVersion, POLICY_IR_SCHEMA_VERSION);
  assert.equal(first.reason, "deployment plan passed policy");
  assert.equal(first.evidence.engine, BUILT_IN_POLICY_ENGINE_ID);
  assert.deepEqual(first.evidence.policyIds, ["allow-deployment-plan"]);
  assert.match(first.evidence.inputHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test("unlisted tuple and action deny by default rather than warning", () => {
  const engine = createBuiltInPolicyEngine();
  const decision = evaluatePolicy(
    engine,
    createGoldenDecisionRequest({
      action: "hobo:secret:value-read",
      resource: { kind: "secret", id: "secret:prod/api-key" },
      phase: "runtime",
    }),
    createRuleset({
      rules: [
        defineTypescriptRule({
          id: "allow-deployment-plan",
          when: ({ request }) => request.action === "hobo:deployment:apply",
          decide: () => ({ effect: "allow", reason: "deployments only" }),
        }),
      ],
    }),
  );

  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /deny-by-default/);
  assert.match(decision.violations.join("\n"), /no policy rule mapped hobo:secret:value-read/);
});

test("composed deny-ceiling denies cannot be widened by lower-scope allows", () => {
  const engine = createBuiltInPolicyEngine();
  const request = createGoldenDecisionRequest({
    action: "hobo:deployment:apply",
    resource: { kind: "deployment", id: "deployment:checkout-prod" },
    phase: "apply",
  });
  const tuple = requestTuple(request);
  const ruleset = createRuleset({
    policyPacks: [
      definePolicyPack({
        id: "junction-prod",
        scope: "junction",
        rules: [denyRule({ id: "no-prod-apply", tuple })],
      }),
      definePolicyPack({
        id: "bindle-escape",
        scope: "bindle",
        rules: [allowRule({ id: "allow-prod-apply", tuple })],
      }),
    ],
    rules: [
      defineTypescriptRule({
        id: "bindle-allow-apply",
        when: () => true,
        decide: () => ({ effect: "allow", reason: "bindle local allow" }),
      }),
    ],
  });

  const decision = evaluatePolicy(engine, request, ruleset);

  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /deny-ceiling composition failed/);
  assert.match(decision.violations.join("\n"), /attempts to allow/);
  assert.deepEqual(decision.evidence.policyIds, [
    "junction:junction-prod/no-prod-apply",
    "bindle:bindle-escape/allow-prod-apply",
  ]);
});

test("mandatory deny-ceiling overrides matching TypeScript allow rules", () => {
  const engine = createBuiltInPolicyEngine();
  const request = createGoldenDecisionRequest({ phase: "runtime" });
  const tuple = requestTuple(request);
  const ruleset = createRuleset({
    policyPacks: [
      definePolicyPack({
        id: "junction-runtime",
        scope: "junction",
        rules: [denyRule({ id: "no-runtime-deploy", tuple })],
      }),
    ],
    rules: [
      defineTypescriptRule({
        id: "allow-runtime-deploy",
        when: () => true,
        decide: () => ({ effect: "allow", reason: "lower scope attempted allow" }),
      }),
    ],
  });

  const decision = evaluatePolicy(engine, request, ruleset);

  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /deny-ceiling matched/);
  assert.deepEqual(decision.evidence.policyIds, ["junction:junction-runtime/no-runtime-deploy"]);
});

test("default denies from composition apply when no lower-scope pack overrides them", () => {
  const engine = createBuiltInPolicyEngine();
  const request = createGoldenDecisionRequest({ phase: "apply" });
  const tuple = requestTuple(request);
  const decision = evaluatePolicy(
    engine,
    request,
    createRuleset({
      policyPacks: [
        definePolicyPack({
          id: "junction-recommendation",
          scope: "junction",
          rules: [denyRule({ id: "prefer-no-prod-apply", mode: "default", tuple })],
        }),
      ],
      rules: [
        defineTypescriptRule({
          id: "allow-apply",
          when: () => true,
          decide: () => ({ effect: "allow", reason: "typed rule would allow apply" }),
        }),
      ],
    }),
  );

  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /policy composition denied/);
  assert.deepEqual(decision.evidence.policyIds, ["junction:junction-recommendation/prefer-no-prod-apply"]);
});

test("rule exceptions fail closed deny with evidence from the throwing rule", () => {
  const decision = evaluatePolicy(
    createBuiltInPolicyEngine(),
    createGoldenDecisionRequest(),
    createRuleset({
      rules: [
        defineTypescriptRule({
          id: "buggy-allow",
          when: () => true,
          decide: () => {
            throw new Error("side effect unavailable");
          },
        }),
      ],
    }),
  );

  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /rule evaluation failed/);
  assert.match(decision.violations.join("\n"), /buggy-allow.*side effect unavailable/);
  assert.deepEqual(decision.evidence.policyIds, ["buggy-allow"]);
});

test("evaluation does not depend on rule registration order", () => {
  const engine = createBuiltInPolicyEngine();
  const request = createGoldenDecisionRequest();
  const allow = defineTypescriptRule({
    id: "b-allow",
    when: () => true,
    decide: () => ({ effect: "allow", reason: "allow candidate" }),
  });
  const warn = defineTypescriptRule({
    id: "a-warn",
    when: () => true,
    decide: () => ({ effect: "warn", reason: "warn candidate" }),
  });

  const first = evaluatePolicy(engine, request, createRuleset({ rules: [allow, warn] }));
  const second = evaluatePolicy(engine, request, createRuleset({ rules: [warn, allow] }));

  assert.equal(first.effect, "warn");
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first.evidence.policyIds, ["a-warn", "b-allow"]);
});

test("decisions are asynchronously shipped as policy.Decided audit events", async () => {
  const events = [];
  const request = createGoldenDecisionRequest();
  const decision = await evaluateAndRecordPolicyDecision({
    engine: createBuiltInPolicyEngine(),
    request,
    ruleset: createRuleset({
      rules: [
        defineTypescriptRule({
          id: "allow-deployment-plan",
          when: () => true,
          decide: () => ({ effect: "allow", reason: "deployment plan passed policy" }),
        }),
      ],
    }),
    auditSink: async (event) => events.push(event),
  });

  assert.equal(decision.effect, "allow");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "policy.Decided");
  assert.equal(events[0].data.evidence.inputHash, decision.evidence.inputHash);
  assert.equal(events[0].data.evidence.engine, BUILT_IN_POLICY_ENGINE_ID);
});
