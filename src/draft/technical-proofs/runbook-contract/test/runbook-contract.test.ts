import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  RUNBOOK_EVENT_TYPES,
  defineRunbook,
  foldRunbookEvents,
  makeRunbookEvent,
  selectFixForClass,
  validateRunbook,
} from "../src/runbook-contract.js";

const jsonSchema = JSON.parse(
  readFileSync(new URL("../schema/runbook.v1.schema.json", import.meta.url), "utf8"),
);

describe("runbook contract", () => {
  it("publishes a versioned JSON schema for runbooks and runbook events", () => {
    assert.equal(jsonSchema.title, "Runbook");
    assert.deepEqual(jsonSchema.required, ["name", "version", "on", "diagnose", "fix", "signature"]);
    assert.deepEqual(jsonSchema.$defs.runbookEvent.properties.type.enum, [
      "runbook.Defined",
      "runbook.Triggered",
      "runbook.StepCompleted",
      "runbook.Completed",
      "runbook.Failed",
    ]);
    assert.ok(jsonSchema.properties.signature.required.includes("signedBy"));
    assert.ok(jsonSchema.properties.signature.required.includes("digest"));
  });

  it("validates the high-5xx-on-api runbook with bounded diagnosis and gated fix actions", () => {
    const runbook = validateRunbook(high5xxRunbook());

    assert.equal(runbook.name, "high-5xx-on-api");
    assert.equal(runbook.on.alert, "api.5xx-burst");
    assert.deepEqual(runbook.diagnose, [
      "tail_logs api",
      "get_drift api",
      "slo_status api.availability",
    ]);
    assert.equal(runbook.fix.length, 3);
    assert.equal(runbook.fix[0].when, "provider-degraded");
    assert.equal(runbook.fix[0].gate, "canary-with-auto-rollback");
    assert.equal(runbook.fix[0].action.kind, "failover");
    assert.equal(runbook.signature.signedBy, "yard:ops");
  });

  it("resolves no matching fix to a typed escalate action", () => {
    const runbook = defineRunbook("no-capacity-match", {
      version: "0.1.0",
      on: { alert: "api.5xx-burst" },
      diagnose: ["tail_logs api"],
      fix: [
        {
          when: "provider-degraded",
          gate: "auto",
          action: boundedAction({
            kind: "retry",
            target: { kind: "resource", id: "api" },
            environment: "staging",
            impact: "low",
          }),
        },
      ],
      signature: signedFixture(),
    });

    const selected = selectFixForClass(runbook, "capacity-exhausted");

    assert.equal(selected.when, "unknown");
    assert.equal(selected.gate, "require-approval");
    assert.equal(selected.action.kind, "escalate");
    assert.equal(selected.action.target.kind, "resource");
    assert.equal(selected.action.target.id, "runbook:no-capacity-match");
  });

  it("emits replayable runbook events for the defined, triggered, step, completed, and failed facts", () => {
    const runbook = validateRunbook(high5xxRunbook());
    const completedEvents = [
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.defined, {
        id: "evt-defined",
        runbook,
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
      }),
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.triggered, {
        id: "evt-triggered",
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
        causationId: "evt-defined",
        payload: { incidentId: "incident-api-5xx" },
      }),
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.stepCompleted, {
        id: "evt-step",
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
        causationId: "evt-triggered",
        payload: { step: "tail_logs api", kind: "diagnose" },
      }),
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.completed, {
        id: "evt-completed",
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
        causationId: "evt-step",
        payload: { selectedFix: "provider-degraded" },
      }),
    ];
    const failedEvents = [
      ...completedEvents.slice(0, -1),
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.failed, {
        id: "evt-failed",
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
        causationId: "evt-step",
        payload: { reason: "runner unavailable" },
      }),
    ];

    const completedReplay = foldRunbookEvents(completedEvents);
    const failedReplay = foldRunbookEvents(failedEvents);

    assert.deepEqual(completedReplay.eventTypes, [
      "runbook.Defined",
      "runbook.Triggered",
      "runbook.StepCompleted",
      "runbook.Completed",
    ]);
    assert.deepEqual(failedReplay.eventTypes, [
      "runbook.Defined",
      "runbook.Triggered",
      "runbook.StepCompleted",
      "runbook.Failed",
    ]);
    assert.equal(completedReplay.runbookId, "runbook-high-5xx");
    assert.equal(completedReplay.status, "completed");
    assert.equal(failedReplay.status, "failed");
  });

  it("rejects events appended after a terminal runbook outcome", () => {
    const runbook = validateRunbook(high5xxRunbook());
    const events = [
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.defined, {
        id: "evt-defined",
        runbook,
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
      }),
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.triggered, {
        id: "evt-triggered",
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
        causationId: "evt-defined",
      }),
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.completed, {
        id: "evt-completed",
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
        causationId: "evt-triggered",
        payload: { selectedFix: "provider-degraded" },
      }),
      makeRunbookEvent(RUNBOOK_EVENT_TYPES.failed, {
        id: "evt-failed",
        runbookId: "runbook-high-5xx",
        correlationId: "incident-api-5xx",
        causationId: "evt-completed",
        payload: { reason: "late failure" },
      }),
    ];

    assert.throws(() => foldRunbookEvents(events), /terminal runbook outcome/);
  });

  it("keeps runbook.Defined payload anchored to the validated signed runbook", () => {
    const runbook = validateRunbook(high5xxRunbook());

    const event = makeRunbookEvent(RUNBOOK_EVENT_TYPES.defined, {
      id: "evt-defined",
      runbook,
      runbookId: "runbook-high-5xx",
      correlationId: "incident-api-5xx",
      payload: { runbook: { name: "unsigned-override" } },
    });

    assert.equal(event.payload.runbook.name, "high-5xx-on-api");
    assert.equal(event.payload.runbook.signature.signedBy, "yard:ops");
  });

  it("rejects fix actions that omit the RemediationAction blast-radius envelope", () => {
    assert.throws(
      () =>
        validateRunbook({
          ...high5xxRunbook(),
          fix: [
            {
              when: "provider-degraded",
              gate: "auto",
              action: {
                kind: "failover",
                target: { kind: "camp", id: "staging-azure" },
                environment: "staging",
                idempotencyKey: "incident-1/failover/staging-azure",
                conformanceState: "green",
              },
            },
          ],
        }),
      /blastRadius is required/,
    );
  });

  it("rejects auto-gated fixes whose RemediationAction effect class requires approval", () => {
    assert.throws(
      () =>
        validateRunbook({
          ...high5xxRunbook(),
          fix: [
            {
              when: "provider-degraded",
              gate: "auto",
              action: boundedAction({
                kind: "failover",
                target: { kind: "camp", id: "prod-azure" },
                environment: "prod",
                impact: "low",
              }),
            },
          ],
        }),
      /gate auto is less restrictive than action effect require-approval/,
    );
  });

  it("rejects unsigned runbooks before they can be loaded", () => {
    const { signature: _signature, ...unsigned } = high5xxRunbook();

    assert.throws(() => validateRunbook(unsigned), /signature is required/);
  });
});

function high5xxRunbook() {
  return {
    name: "high-5xx-on-api",
    version: "0.1.0",
    on: { alert: "api.5xx-burst", severity: ">=SEV2" },
    diagnose: ["tail_logs api", "get_drift api", "slo_status api.availability"],
    fix: [
      {
        when: "provider-degraded",
        gate: "canary-with-auto-rollback",
        action: boundedAction({
          kind: "failover",
          target: { kind: "camp", id: "staging-azure" },
          environment: "staging",
          impact: "medium",
        }),
      },
      {
        when: "capacity-exhausted",
        gate: "auto",
        action: boundedAction({
          kind: "scale",
          target: { kind: "resource", id: "api" },
          environment: "staging",
          impact: "low",
        }),
      },
      {
        when: "unknown",
        gate: "require-approval",
        action: {
          kind: "escalate",
          target: { kind: "resource", id: "runbook:high-5xx-on-api" },
          blastRadius: {
            scope: "resource",
            reversible: false,
            estimatedImpact: "high",
          },
          environment: "prod",
          idempotencyKey: "runbook/high-5xx/escalate",
          conformanceState: "unknown",
        },
      },
    ],
    signature: signedFixture(),
  };
}

function boundedAction({ kind, target, environment, impact }) {
  return {
    kind,
    target,
    blastRadius: {
      scope: target.kind,
      reversible: true,
      compensationPath: `undo-${kind}`,
      estimatedImpact: impact,
    },
    environment,
    idempotencyKey: `incident-1/${kind}/${target.id}`,
    conformanceState: "green",
  };
}

function signedFixture() {
  return {
    signedBy: "yard:ops",
    digest: "sha256:2d7c8f6b6b3ce3ed0f7722e9d14a0ebc1d6f8fbe31dbbb7f647df1c0fcb427e8",
    signature: "sigstore:fixture",
  };
}
