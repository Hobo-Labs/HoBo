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
import {
  BUILT_IN_POLICY_ENGINE_ID,
  createBuiltInPolicyEngine,
  createGoldenDecisionRequest,
  defineTypescriptRule,
  evaluatePolicy,
  requestTuple,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import { createDecision } from "../../hobo-policy-ir-contract/src/policy-ir.js";

import {
  CEDAR_POLICY_ENGINE_ID,
  OPA_REGO_POLICY_ENGINE_ID,
  assertPolicyEngineAdapterConformance,
  createAdapterConformanceFixture,
  createCedarPolicyEngineAdapter,
  createOpaRegoPolicyEngineAdapter,
  createPolicyEngineAdapterRuleset,
  defineCedarPolicy,
  defineOpaRegoPolicy,
  mapDecisionRequestToCedarRequest,
  mapDecisionRequestToOpaInput,
  runPolicyEngineAdapterConformance,
} from "../src/policy-engine-provider-adapters.js";

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

test("typed declarations publish the OPA/Rego and Cedar adapter surface", () => {
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

test("maps one DecisionRequest into OPA input and Cedar ABAC request records", () => {
  const request = createGoldenDecisionRequest();

  assert.deepEqual(mapDecisionRequestToOpaInput(request), {
    schemaVersion: "hobo.policy-ir/v1",
    tuple: "deployment:hobo:deployment:apply:plan",
    subject: {
      kind: "agent",
      id: "spiffe://tenant-a/yard/prod/agent/deployer",
      roles: ["deployer"],
      scopes: ["hobo:deployment:apply"],
      delegatedBy: "user:platform-admin",
    },
    action: "hobo:deployment:apply",
    resource: {
      kind: "deployment",
      id: "deployment:checkout-prod",
    },
    phase: "plan",
    context: {
      yard: "yard-prod",
      provider: "local",
    },
  });

  assert.deepEqual(mapDecisionRequestToCedarRequest(request), {
    principal: {
      type: "agent",
      id: "spiffe://tenant-a/yard/prod/agent/deployer",
      roles: ["deployer"],
      scopes: ["hobo:deployment:apply"],
      delegatedBy: "user:platform-admin",
    },
    action: {
      id: "hobo:deployment:apply",
    },
    resource: {
      type: "deployment",
      id: "deployment:checkout-prod",
    },
    context: {
      phase: "plan",
      tuple: "deployment:hobo:deployment:apply:plan",
      yard: "yard-prod",
      provider: "local",
    },
  });
});

test("OPA/Rego and Cedar adapters pass the same conformance suite as the built-in engine", () => {
  const report = runPolicyEngineAdapterConformance();

  assertPolicyEngineAdapterConformance(report);
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.deepEqual(
    report.engines.map((engine) => engine.engineId),
    [BUILT_IN_POLICY_ENGINE_ID, OPA_REGO_POLICY_ENGINE_ID, CEDAR_POLICY_ENGINE_ID],
  );
  assert.deepEqual(
    report.vectors.map((vector) => vector.name),
    [
      "allow mapped deployment plan",
      "deny-by-default unmapped action",
      "mandatory deny-ceiling overrides adapter allow",
      "lower-scope allow cannot widen a mandatory deny-ceiling",
      "policy evaluation errors fail closed",
    ],
  );
});

test("deny-by-default and evidence.engine hold for both provider adapters", () => {
  const request = createGoldenDecisionRequest({
    action: "hobo:secret:value-read",
    resource: { kind: "secret", id: "secret:prod/api-key" },
    phase: "runtime",
  });
  const ruleset = createPolicyEngineAdapterRuleset();

  for (const engine of [createOpaRegoPolicyEngineAdapter(), createCedarPolicyEngineAdapter()]) {
    const decision = evaluatePolicy(engine, request, ruleset);

    assert.equal(decision.effect, "deny", engine.engineId);
    assert.equal(decision.evidence.engine, engine.engineId);
    assert.match(decision.reason, /deny-by-default/);
  }
});

test("deny-ceiling composition produces the same effective deny as built-in", () => {
  const request = createGoldenDecisionRequest({ phase: "runtime" });
  const tuple = requestTuple(request);
  const ruleset = createPolicyEngineAdapterRuleset({
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
    opaPolicies: [
      defineOpaRegoPolicy({
        id: "opa.allow-runtime-deploy",
        match: () => true,
        decide: () => ({ effect: "allow", reason: "rego policy attempted allow" }),
      }),
    ],
    cedarPolicies: [
      defineCedarPolicy({
        id: "cedar.allow-runtime-deploy",
        when: () => true,
        decide: () => ({ effect: "allow", reason: "cedar policy attempted allow" }),
      }),
    ],
  });
  const builtIn = evaluatePolicy(createBuiltInPolicyEngine(), request, ruleset);
  const opa = evaluatePolicy(createOpaRegoPolicyEngineAdapter(), request, ruleset);
  const cedar = evaluatePolicy(createCedarPolicyEngineAdapter(), request, ruleset);

  assert.equal(builtIn.effect, "deny");
  assert.equal(opa.effect, builtIn.effect);
  assert.equal(cedar.effect, builtIn.effect);
  assert.deepEqual(opa.evidence.policyIds, builtIn.evidence.policyIds);
  assert.deepEqual(cedar.evidence.policyIds, builtIn.evidence.policyIds);
});

test("lower-scope adapter allow cannot un-deny a mandatory deny-ceiling", () => {
  const request = createGoldenDecisionRequest({ phase: "apply" });
  const tuple = requestTuple(request);
  const ruleset = createPolicyEngineAdapterRuleset({
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
        id: "typed-allow-apply",
        when: () => true,
        decide: () => ({ effect: "allow", reason: "typed allow should not widen" }),
      }),
    ],
    opaPolicies: [
      defineOpaRegoPolicy({
        id: "opa.allow-prod-apply",
        match: () => true,
        decide: () => ({ effect: "allow", reason: "rego allow should not widen" }),
      }),
    ],
    cedarPolicies: [
      defineCedarPolicy({
        id: "cedar.allow-prod-apply",
        when: () => true,
        decide: () => ({ effect: "allow", reason: "cedar allow should not widen" }),
      }),
    ],
  });

  for (const engine of [
    createBuiltInPolicyEngine(),
    createOpaRegoPolicyEngineAdapter(),
    createCedarPolicyEngineAdapter(),
  ]) {
    const decision = evaluatePolicy(engine, request, ruleset);

    assert.equal(decision.effect, "deny", engine.engineId);
    assert.match(decision.reason, /deny-ceiling composition failed/, engine.engineId);
    assert.match(decision.violations.join("\n"), /attempts to allow/, engine.engineId);
  }
});

test("Rego and Cedar policy errors fail closed", () => {
  const request = createGoldenDecisionRequest();
  const ruleset = createPolicyEngineAdapterRuleset({
    opaPolicies: [
      defineOpaRegoPolicy({
        id: "opa.buggy-policy",
        match: () => true,
        decide: () => {
          throw new Error("rego bundle unavailable");
        },
      }),
    ],
    cedarPolicies: [
      defineCedarPolicy({
        id: "cedar.buggy-policy",
        when: () => true,
        decide: () => {
          throw new Error("cedar entity graph unavailable");
        },
      }),
    ],
  });

  const opa = evaluatePolicy(createOpaRegoPolicyEngineAdapter(), request, ruleset);
  const cedar = evaluatePolicy(createCedarPolicyEngineAdapter(), request, ruleset);

  assert.equal(opa.effect, "deny");
  assert.equal(opa.evidence.engine, OPA_REGO_POLICY_ENGINE_ID);
  assert.match(opa.violations.join("\n"), /opa\.buggy-policy.*rego bundle unavailable/);

  assert.equal(cedar.effect, "deny");
  assert.equal(cedar.evidence.engine, CEDAR_POLICY_ENGINE_ID);
  assert.match(cedar.violations.join("\n"), /cedar\.buggy-policy.*cedar entity graph unavailable/);
});

test("adapter returning allow for an unmapped action fails conformance", () => {
  const fixture = createAdapterConformanceFixture();
  const report = runPolicyEngineAdapterConformance({
    engines: [
      {
        engineId: "example.bad-opa@0.1.0",
        evaluate(request) {
          return createDecision(request, {
            effect: "allow",
            reason: "unmapped action was allowed",
            evidence: {
              engine: "example.bad-opa@0.1.0",
              policyIds: ["bad.allow-all"],
            },
          });
        },
      },
    ],
    vectors: [fixture.vectors.find((vector) => vector.name === "deny-by-default unmapped action")],
  });

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /deny-by-default unmapped action.*expected deny/);
});

test("non-deterministic adapter result fails conformance", () => {
  let count = 0;
  const report = runPolicyEngineAdapterConformance({
    engines: [
      {
        engineId: "example.nondeterministic-cedar@0.1.0",
        evaluate(request) {
          count += 1;
          return createDecision(request, {
            effect: "deny",
            reason: `ambient decision ${count}`,
            evidence: {
              engine: "example.nondeterministic-cedar@0.1.0",
              policyIds: [`ambient-${count}`],
            },
          });
        },
      },
    ],
    vectors: [
      {
        name: "ambient adapter determinism check",
        request: createGoldenDecisionRequest({
          action: "hobo:secret:value-read",
          resource: { kind: "secret", id: "secret:prod/api-key" },
          phase: "runtime",
        }),
        ruleset: createPolicyEngineAdapterRuleset(),
        expectedEffect: "deny",
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /ambient adapter determinism check.*must be deterministic/);
});
