import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  REMEDIATION_ACTION_EVENT_TYPE,
  classifyRemediationEffect,
  makeRemediationActionEvent,
  remediationActionKinds,
  validateRemediationAction,
} from "../src/remediation-action-contract.js";
import { isJsonBoolean, isJsonString } from "../src/json.js";

const goldenActions = JSON.parse(
  readFileSync(new URL("../fixtures/golden-actions.json", import.meta.url), "utf8"),
);
const jsonSchema = JSON.parse(
  readFileSync(new URL("../schema/remediation-action.v1.schema.json", import.meta.url), "utf8"),
);
const zodSchemaSource = readFileSync(
  new URL("../schema/remediation-action.zod.ts", import.meta.url),
  "utf8",
);
const witSource = readFileSync(new URL("../wit/remediation-action.wit", import.meta.url), "utf8");

describe("remediation action blast-radius contract", () => {
  it("validates golden remediation actions and preserves the blast-radius envelope", () => {
    const action = validateRemediationAction(goldenActions.lowRiskFailover);

    assert.equal(action.kind, remediationActionKinds.failover);
    assert.equal(action.blastRadius.scope, "camp");
    assert.equal(action.blastRadius.reversible, true);
    assert.equal(action.idempotencyKey, "incident-42/failover/prod-aws");
  });

  it("validates every golden example against the JSON schema artifact and runtime schema", () => {
    for (const [name, action] of Object.entries(goldenActions)) {
      assertMatchesRemediationActionJsonSchema(action, jsonSchema, name);
      assert.doesNotThrow(() => validateRemediationAction(action), name);
    }
  });

  it("ships WIT and Zod contract artifacts for the same public surface", () => {
    for (const actionKind of Object.values(remediationActionKinds)) {
      assert.match(zodSchemaSource, new RegExp(`"${escapeRegExp(actionKind)}"`));
    }

    assert.match(witSource, /record remediation-action/);
    assert.match(witSource, /record blast-radius/);
    assert.match(witSource, /enum policy-effect-class/);
    assert.match(zodSchemaSource, /RemediationActionSchema/);
    assert.match(zodSchemaSource, /BlastRadiusSchema/);
  });

  it("maps blast radius and environment to the policy effect class", () => {
    const lowRiskStaging = validateRemediationAction({
      kind: "retry",
      target: { kind: "resource", id: "api" },
      blastRadius: {
        scope: "resource",
        reversible: true,
        compensationPath: "stop-retry",
        estimatedImpact: "low",
      },
      environment: "staging",
      idempotencyKey: "incident-7/retry/api",
      conformanceState: "green",
    });
    const prodScale = validateRemediationAction({
      kind: "scale",
      target: { kind: "resource", id: "api" },
      blastRadius: {
        scope: "resource",
        reversible: true,
        compensationPath: "scale-back",
        estimatedImpact: "low",
      },
      environment: "prod",
      idempotencyKey: "incident-8/scale/api",
      conformanceState: "green",
    });
    const canaryCandidate = validateRemediationAction({
      kind: "circuit-break",
      target: { kind: "resource", id: "payments" },
      blastRadius: {
        scope: "camp",
        reversible: true,
        compensationPath: "close-breaker",
        estimatedImpact: "medium",
      },
      environment: "staging",
      idempotencyKey: "incident-9/circuit-break/payments",
      conformanceState: "green",
    });
    const irreversibleStaging = validateRemediationAction({
      kind: "halt-spend",
      target: { kind: "region", id: "us-east-1" },
      blastRadius: {
        scope: "region",
        reversible: false,
        estimatedImpact: "low",
      },
      environment: "staging",
      idempotencyKey: "incident-15/halt-spend/us-east-1",
      conformanceState: "green",
    });

    assert.equal(classifyRemediationEffect(lowRiskStaging).effectClass, "auto");
    assert.equal(classifyRemediationEffect(prodScale).effectClass, "require-approval");
    assert.equal(classifyRemediationEffect(canaryCandidate).effectClass, "canary-with-auto-rollback");
    assert.equal(classifyRemediationEffect(irreversibleStaging).effectClass, "require-approval");
  });

  it("rejects unbounded writes when blast radius is missing", () => {
    assert.throws(
      () =>
        validateRemediationAction({
          kind: "resync",
          target: { kind: "resource", id: "db" },
          environment: "staging",
          idempotencyKey: "incident-10/resync/db",
          conformanceState: "green",
        }),
      /blastRadius is required/,
    );
  });

  it("rejects reversible actions without a compensation path", () => {
    assert.throws(
      () =>
        validateRemediationAction({
          kind: "compensate",
          target: { kind: "resource", id: "queue" },
          blastRadius: {
            scope: "resource",
            reversible: true,
            estimatedImpact: "low",
          },
          environment: "staging",
          idempotencyKey: "incident-11/compensate/queue",
          conformanceState: "green",
        }),
      /compensationPath is required/,
    );
  });

  it("maps unknown or unclassified actions to require-approval instead of auto", () => {
    const action = validateRemediationAction({
      kind: "new-provider-write",
      target: { kind: "resource", id: "unknown" },
      blastRadius: {
        scope: "resource",
        reversible: true,
        compensationPath: "manual-rollback",
        estimatedImpact: "low",
      },
      environment: "staging",
      idempotencyKey: "incident-12/new-provider-write",
      conformanceState: "green",
    });

    assert.equal(classifyRemediationEffect(action).effectClass, "require-approval");
    assert.equal(classifyRemediationEffect(action).reason, "unknown-kind-fail-closed");
  });

  it("defaults missing environment to the most restrictive effect class", () => {
    const action = validateRemediationAction({
      kind: "degrade",
      target: { kind: "resource", id: "batch" },
      blastRadius: {
        scope: "resource",
        reversible: true,
        compensationPath: "restore-tier",
        estimatedImpact: "low",
      },
      idempotencyKey: "incident-13/degrade/batch",
      conformanceState: "green",
    });

    assert.equal(action.environment, "unknown");
    assert.equal(classifyRemediationEffect(action).effectClass, "require-approval");
    assert.equal(classifyRemediationEffect(action).reason, "unknown-environment-fail-closed");
  });

  it("normalizes production environments and fails unrecognized environments closed", () => {
    const prodWithWhitespace = validateRemediationAction({
      kind: "retry",
      target: { kind: "resource", id: "api" },
      blastRadius: {
        scope: "resource",
        reversible: true,
        compensationPath: "stop-retry",
        estimatedImpact: "low",
      },
      environment: " prod ",
      idempotencyKey: "incident-16/retry/api",
      conformanceState: "green",
    });
    const unrecognizedEnvironment = validateRemediationAction({
      kind: "retry",
      target: { kind: "resource", id: "api" },
      blastRadius: {
        scope: "resource",
        reversible: true,
        compensationPath: "stop-retry",
        estimatedImpact: "low",
      },
      environment: "partner-demo",
      idempotencyKey: "incident-17/retry/api",
      conformanceState: "green",
    });

    assert.equal(prodWithWhitespace.environment, "prod");
    assert.equal(classifyRemediationEffect(prodWithWhitespace).effectClass, "require-approval");
    assert.equal(
      classifyRemediationEffect(unrecognizedEnvironment).reason,
      "unrecognized-environment-fail-closed",
    );
  });

  it("emits a stable remediation action event payload", () => {
    const action = validateRemediationAction({
      kind: "rotate-credential",
      target: { kind: "resource", id: "token-broker" },
      blastRadius: {
        scope: "resource",
        reversible: false,
        estimatedImpact: "medium",
      },
      environment: "prod",
      idempotencyKey: "incident-14/rotate/token-broker",
      conformanceState: "green",
    });
    const decision = classifyRemediationEffect(action);
    const event = makeRemediationActionEvent({
      id: "evt-remediation-1",
      incidentId: "incident-14",
      action,
      decision,
    });

    assert.equal(event.type, REMEDIATION_ACTION_EVENT_TYPE);
    assert.equal(event.payload.incidentId, "incident-14");
    assert.equal(event.payload.action.kind, "rotate-credential");
    assert.equal(event.payload.policyEffectClass, "require-approval");
    assert.equal(event.payload.blastRadius.scope, "resource");
  });
});

function assertMatchesRemediationActionJsonSchema(action, schema, name) {
  assert.equal(schema.title, "RemediationAction", name);
  assert.deepEqual(
    [...schema.required].sort(),
    ["blastRadius", "conformanceState", "idempotencyKey", "kind", "target"].sort(),
    name,
  );
  assert.equal(isJsonString(action.kind), true, name);
  assert.ok(action.kind.length > 0, name);
  assert.ok(schema.properties.target.properties.kind.enum.includes(action.target.kind), name);
  assert.ok(schema.properties.blastRadius.properties.scope.enum.includes(action.blastRadius.scope), name);
  assert.equal(isJsonBoolean(action.blastRadius.reversible), true, name);
  assert.ok(
    schema.properties.blastRadius.properties.estimatedImpact.enum.includes(
      action.blastRadius.estimatedImpact,
    ),
    name,
  );

  if (action.blastRadius.reversible) {
    assert.equal(isJsonString(action.blastRadius.compensationPath), true, name);
    assert.ok(action.blastRadius.compensationPath.length > 0, name);
  }

  assert.ok(schema.properties.conformanceState.enum.includes(action.conformanceState), name);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
