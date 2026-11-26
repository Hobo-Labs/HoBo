import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  POLICY_ENGINE_PORT,
  canonicalJson,
  compileRulesetContract,
  createBuiltInPolicyEngine,
  createGoldenDecisionRequest,
  createNoopDenyAdapter,
  createPermissiveAdapter,
  createRuleset,
  defineTypescriptRule,
  evaluatePolicy,
  runPolicyEngineConformance
} from "../src/policy-engine-port.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("publishes the WIT port, schema, and typed TypeScript authoring surface", async () => {
  const wit = await readFile(path.join(packageRoot, "wit", "world.wit"), "utf8");
  const declarations = await readFile(path.join(packageRoot, "src", "policy-engine-port.d.mts"), "utf8");
  const schema = JSON.parse(await readFile(path.join(packageRoot, "schema", "policy-engine.v1.schema.json"), "utf8"));

  assert.equal(POLICY_ENGINE_PORT, "hobo:policy-engine/policy-engine@0.1.0");
  assert.match(wit, /evaluate: func\(request: decision-request, ruleset: ruleset\) -> decision/);
  assert.match(wit, /compile-ruleset: func\(ruleset: ruleset\) -> result<compiled-ruleset, policy-error>/);
  assert.match(declarations, /export interface PolicyEngineAdapter/);
  assert.match(declarations, /export interface TypescriptRule/);
  assert.equal(schema.$id, "https://schemas.hobo.dev/policy-engine.v1.schema.json");
});

test("built-in engine evaluates golden vectors deterministically and records evidence.engine", () => {
  const engine = createBuiltInPolicyEngine();
  const request = createGoldenDecisionRequest();
  const ruleset = createRuleset({
    rules: [
      defineTypescriptRule({
        id: "allow-deploy-plan",
        when: ({ request: candidate }) => candidate.action === "deployment.apply" && candidate.phase === "plan",
        decide: () => ({ effect: "allow", reason: "deployment plan passed policy" })
      })
    ]
  });

  const first = evaluatePolicy(engine, request, ruleset);
  const second = evaluatePolicy(engine, structuredClone(request), ruleset);

  assert.equal(first.effect, "allow");
  assert.equal(first.evidence.engine, "hobo.policy-engine/built-in-typescript@0.1.0");
  assert.deepEqual(first.evidence.policyIds, ["allow-deploy-plan"]);
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test("ruleset load and compile surface returns a stable compiled descriptor", () => {
  const ruleset = createRuleset({
    id: "policy-pack:prod",
    version: "1.2.3",
    rules: [
      defineTypescriptRule({
        id: "deny-runtime-secret-read",
        when: ({ request }) => request.action === "secret.read" && request.phase === "runtime",
        decide: () => ({ effect: "deny", reason: "secret values are not grantable reads" })
      })
    ]
  });

  const compiled = compileRulesetContract(ruleset);

  assert.equal(compiled.ok, true, compiled.errors.join("\n"));
  assert.deepEqual(compiled.compiled, {
    rulesetId: "policy-pack:prod",
    version: "1.2.3",
    ruleIds: ["deny-runtime-secret-read"]
  });
});

test("conformance suite runs against built-in engine and a no-op deny adapter", () => {
  const builtIn = runPolicyEngineConformance(createBuiltInPolicyEngine());
  const noOp = runPolicyEngineConformance(createNoopDenyAdapter());

  assert.equal(builtIn.ok, true, builtIn.errors.join("\n"));
  assert.equal(noOp.ok, true, noOp.errors.join("\n"));
});

test("non-deterministic TypeScript rules are rejected before they can decide", () => {
  const engine = createBuiltInPolicyEngine();
  const ruleset = createRuleset({
    rules: [
      defineTypescriptRule({
        id: "ambient-clock-rule",
        when: () => Date.now() > 0,
        decide: () => ({ effect: "allow", reason: "ambient clock should not be allowed" })
      }),
      defineTypescriptRule({
        id: "ambient-random-rule",
        when: () => Math.random() > -1,
        decide: () => ({ effect: "allow", reason: "ambient random should not be allowed" })
      })
    ]
  });

  const decision = evaluatePolicy(engine, createGoldenDecisionRequest(), ruleset);

  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /ruleset compile failed/);
  assert.match(decision.violations.join("\n"), /ambient-clock-rule.*Date\.now/);
  assert.match(decision.violations.join("\n"), /ambient-random-rule.*Math\.random/);
});

test("permissive adapters fail conformance when they allow an unmapped action", () => {
  const report = runPolicyEngineConformance(createPermissiveAdapter());

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /deny-by-default/);
});

test("ruleset compile failure returns a fail-closed deny decision", () => {
  const engine = createBuiltInPolicyEngine();
  const invalidRuleset = createRuleset({
    version: "",
    rules: [
      defineTypescriptRule({
        id: "valid-deny",
        when: () => true,
        decide: () => ({ effect: "deny", reason: "valid rule cannot save invalid ruleset metadata" })
      })
    ]
  });

  const decision = evaluatePolicy(engine, createGoldenDecisionRequest(), invalidRuleset);

  assert.equal(decision.effect, "deny");
  assert.equal(decision.evidence.engine, "hobo.policy-engine/built-in-typescript@0.1.0");
  assert.match(decision.reason, /ruleset compile failed/);
  assert.match(decision.violations.join("\n"), /ruleset.version must be semver/);
});

test("rules returning invalid effects fail closed at evaluation time", () => {
  const engine = createBuiltInPolicyEngine();
  const invalidRuleset = createRuleset({
    rules: [
      defineTypescriptRule({
        id: "bad-effect",
        when: () => true,
        decide: () => ({ effect: "permit", reason: "not a valid HoBo decision effect" })
      })
    ]
  });

  const decision = evaluatePolicy(engine, createGoldenDecisionRequest(), invalidRuleset);

  assert.equal(decision.effect, "deny");
  assert.equal(decision.evidence.engine, "hobo.policy-engine/built-in-typescript@0.1.0");
  assert.match(decision.reason, /ruleset compile failed/);
  assert.match(decision.violations.join("\n"), /bad-effect.*effect must be/);
});
