import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONTROL_PLANE_ACTIONS,
} from "../../control-plane-action-taxonomy-contract/src/control-plane-action-taxonomy.js";
import {
  createBuiltInPolicyEngine,
  createRuleset,
  defineTypescriptRule,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";

import {
  assertHighPrivilegeActionsEnumerated,
  checkControlPlaneBuildGate,
  guardControlPlaneSideEffect,
} from "../src/control-plane-policy-bypass-guard.js";

const subject = {
  kind: "user",
  id: "user:platform-admin",
  roles: ["Platform-Engineer"],
};

test("un-enumerated or smuggled control-plane paths fail the build gate", () => {
  const result = checkControlPlaneBuildGate({
    taxonomy: CONTROL_PLANE_ACTIONS,
    routes: [
      {
        surface: "cli",
        command: "hobo registry import",
        resource: "registry",
        verb: "import",
        actionId: "hobo:registry:import",
      },
      {
        surface: "mcp",
        command: "provider.bless",
        resource: "provider",
        verb: "bless",
        actionId: "hobo:provider:bless",
      },
      {
        surface: "cli",
        command: "hobo relay attach --raw",
        resource: "relay",
        verb: "attach",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.mappedActionIds, ["hobo:registry:import"]);
  assert.deepEqual(result.missingMappings, [
    {
      surface: "mcp",
      command: "provider.bless",
      resource: "provider",
      verb: "bless",
      reason: "unknown action id hobo:provider:bless",
    },
    {
      surface: "cli",
      command: "hobo relay attach --raw",
      resource: "relay",
      verb: "attach",
      reason: "missing action id",
    },
  ]);
});

test("an enumerated but unbound control-plane tuple denies before side effects", async () => {
  const events = [];
  const sideEffects = [];

  const result = await guardControlPlaneSideEffect({
    operation: {
      surface: "cli",
      command: "hobo registry import",
      subject,
      resource: "registry",
      resourceId: "bundle:prod",
      verb: "import",
      actionId: "hobo:registry:import",
      phase: "author",
    },
    engine: createBuiltInPolicyEngine(),
    ruleset: createRuleset({
      rules: [
        defineTypescriptRule({
          id: "allow-relay-read-only",
          when: ({ request }) => request.resource.kind === "hobo:relay" && request.action === "read",
          decide: () => ({ effect: "allow", reason: "relay reads only" }),
        }),
      ],
    }),
    auditSink: (event) => events.push(event),
    sideEffect: () => sideEffects.push("imported"),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.sideEffectRan, false);
  assert.equal(sideEffects.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "policy.Decided");
  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /deny-by-default/);
  assert.match(result.decision.violations.join("\n"), /no policy rule mapped import/);
});

test("fuzzed action and resource strings never reach side effects without an allow decision", async () => {
  const events = [];
  const sideEffects = [];
  const attempts = [
    {
      resource: "registry",
      resourceId: "bundle:prod",
      verb: "imporT",
      actionId: "hobo:registry:imporT",
    },
    {
      resource: "registri",
      resourceId: "bundle:prod",
      verb: "import",
      actionId: "hobo:registri:import",
    },
    {
      resource: "derivative",
      resourceId: "derivative:engine-swap",
      verb: "upgrade-now",
      actionId: "hobo:derivative:upgrade-now",
    },
    {
      resource: "relay",
      resourceId: "relay:corp-vpn",
      verb: "attach",
      actionId: "hobo:relay:attach",
    },
  ];

  const results = [];
  for (const attempt of attempts) {
    results.push(
      await guardControlPlaneSideEffect({
        operation: {
          surface: "mcp",
          command: `${attempt.resource}.${attempt.verb}`,
          subject,
          phase: "apply",
          ...attempt,
        },
        engine: createBuiltInPolicyEngine(),
        ruleset: createRuleset({
          rules: [
            defineTypescriptRule({
              id: "allow-nothing-in-fuzz-corpus",
              when: () => false,
              decide: () => ({ effect: "allow", reason: "unreachable" }),
            }),
          ],
        }),
        auditSink: (event) => events.push(event),
        sideEffect: () => sideEffects.push(attempt.actionId),
      }),
    );
  }

  assert.equal(sideEffects.length, 0);
  assert.equal(results.every((result) => result.sideEffectRan === false), true);
  assert.equal(results.filter((result) => result.decision?.effect === "deny").length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "policy.Decided");
  assert.equal(results.slice(0, 3).every((result) => result.completeness.ok === false), true);
});

test("high-privilege derivative, registry, and relay actions stay enumerated", () => {
  const result = assertHighPrivilegeActionsEnumerated({
    taxonomy: CONTROL_PLANE_ACTIONS,
  });

  assert.deepEqual(result.actionIds, [
    "hobo:derivative:upgrade",
    "hobo:registry:import",
    "hobo:relay:attach",
    "hobo:relay:register",
  ]);
});

test("allowed operations run side effects only after policy.Decided is recorded", async () => {
  const events = [];
  const sideEffects = [];

  const result = await guardControlPlaneSideEffect({
    operation: {
      surface: "cli",
      command: "hobo registry import",
      subject,
      resource: "registry",
      resourceId: "bundle:prod",
      verb: "import",
      actionId: "hobo:registry:import",
      phase: "author",
    },
    engine: createBuiltInPolicyEngine(),
    ruleset: createRuleset({
      rules: [
        defineTypescriptRule({
          id: "allow-registry-import",
          when: ({ request }) => request.resource.kind === "hobo:registry" && request.action === "import",
          decide: () => ({ effect: "allow", reason: "registry import approved" }),
        }),
      ],
    }),
    auditSink: (event) => events.push(event),
    sideEffect: () => {
      assert.equal(events.length, 1);
      sideEffects.push("imported");
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.sideEffectRan, true);
  assert.equal(result.decision.effect, "allow");
  assert.equal(events[0].type, "policy.Decided");
  assert.deepEqual(sideEffects, ["imported"]);
});
