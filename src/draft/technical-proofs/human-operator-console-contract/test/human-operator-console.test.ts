import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  actionProposed,
  createOperatorPrincipal,
  foldCrewStream,
  policyDecided,
} from "../../crew-event-contract/src/crew-event-contract.js";
import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  buildOperatorConsoleProjection,
  createHumanOperatorMcpSurface,
  createRequireApprovalGate,
  decideApproval,
  hashApprovalSnapshot,
} from "../src/human-operator-console.js";

describe("human operator console approval surface", () => {
  it("surfaces pending require-approval actions in the console projection and MCP tool", async () => {
    const events = pendingApprovalEvents();

    const projection = buildOperatorConsoleProjection(events);
    assert.equal(projection.incidents.length, 1);
    assert.equal(projection.incidents[0].id, "incident-checkout-sev2");
    assert.equal(projection.incidents[0].mttdMs, 60_000);
    assert.equal(projection.incidents[0].mttrMs, null);
    assert.deepEqual(
      projection.pendingApprovals.map((approval) => approval.actionId),
      ["action-failover-checkout"],
    );

    const mcp = createHumanOperatorMcpSurface({ events });
    assert.ok(mcp.listTools().some((tool) => tool.name === "operator.decide_approval"));

    const approvals = await mcp.callTool("operator.list_pending_approvals", {}, { actor: viewerActor() });
    assert.equal(approvals.ok, true);
    assert.deepEqual(approvals.data.pendingApprovals, projection.pendingApprovals);
  });

  it("approves a gate through MCP and replays allow before crew.ActionApplied", async () => {
    const eventLog = pendingApprovalEvents();
    const pending = buildOperatorConsoleProjection(eventLog).pendingApprovals[0];
    const mcp = createHumanOperatorMcpSurface({
      readEvents: () => eventLog,
      appendEvents: (events) => eventLog.push(...events),
    });

    const result = await mcp.callTool(
      "operator.decide_approval",
      {
        actionId: pending.actionId,
        decision: "allow",
        expectedActionSnapshotHash: pending.actionSnapshotHash,
        decidedAt: "2026-06-27T18:05:00.000Z",
      },
      { actor: approverActor() },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.data.events.map((event) => event.type),
      ["policy.Decided", "crew.ActionProposed", "crew.ActionApplied", "policy.ObligationSatisfied"],
    );
    assert.equal(result.data.events[0].data.effect, "allow");

    const replayed = buildOperatorConsoleProjection(eventLog);
    assert.deepEqual(replayed.pendingApprovals, []);
    assert.deepEqual(
      replayed.incidents[0].decisionTrail.map((entry) => entry.type),
      [
        "policy.Decided",
        "crew.ActionProposed",
        "policy.ObligationCreated",
        "policy.Decided",
        "crew.ActionProposed",
        "crew.ActionApplied",
        "policy.ObligationSatisfied",
      ],
    );

    const crewReplay = foldCrewStream(
      eventLog.filter((event) => event.type === "policy.Decided" || event.type.startsWith("crew.")),
    );
    assert.equal(crewReplay.actions.at(-1).status, "applied");
  });

  it("supports deny and abort decisions through the same command surface", () => {
    const denied = decideApproval({
      events: pendingApprovalEvents({ actionId: "action-deny-checkout" }),
      actionId: "action-deny-checkout",
      decision: "deny",
      actor: approverActor(),
      expectedActionSnapshotHash: hashApprovalSnapshot(defaultSnapshot()),
      decidedAt: "2026-06-27T18:06:00.000Z",
    });
    const aborted = decideApproval({
      events: pendingApprovalEvents({ actionId: "action-abort-checkout" }),
      actionId: "action-abort-checkout",
      decision: "abort",
      actor: approverActor(),
      expectedActionSnapshotHash: hashApprovalSnapshot(defaultSnapshot()),
      decidedAt: "2026-06-27T18:07:00.000Z",
    });

    assert.equal(denied.status, "deny");
    assert.equal(aborted.status, "abort");
    assert.equal(denied.crewDecision.type, "crew.ActionDenied");
    assert.equal(aborted.crewDecision.type, "crew.ActionDenied");
    assert.equal(denied.policyDecision.data.effect, "deny");
    assert.equal(aborted.policyDecision.data.effect, "deny");
  });

  it("blocks viewers from approving gated actions", async () => {
    const eventLog = pendingApprovalEvents();
    const pending = buildOperatorConsoleProjection(eventLog).pendingApprovals[0];
    const mcp = createHumanOperatorMcpSurface({
      readEvents: () => eventLog,
      appendEvents: (events) => eventLog.push(...events),
    });

    const result = await mcp.callTool(
      "operator.decide_approval",
      {
        actionId: pending.actionId,
        decision: "allow",
        expectedActionSnapshotHash: pending.actionSnapshotHash,
        decidedAt: "2026-06-27T18:08:00.000Z",
      },
      { actor: viewerActor() },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "OPERATOR_APPROVAL_FORBIDDEN");
    assert.ok(!eventLog.some((event) => event.type === "crew.ActionApplied"));
  });

  it("rejects stale approval when action or blast-radius snapshot changes", async () => {
    const eventLog = pendingApprovalEvents();
    const original = buildOperatorConsoleProjection(eventLog).pendingApprovals[0];
    eventLog.push(
      createRequireApprovalGate({
        id: "obligation-failover-checkout-expanded",
        incidentId: "incident-checkout-sev2",
        correlationId: "corr-checkout-sev2",
        actionId: original.actionId,
        proposalId: original.proposalId,
        policyDecisionId: original.policyDecisionId,
        action: { kind: "failover", target: "checkout-route" },
        blastRadiusSnapshot: { environment: "prod", maxResources: 50, reversible: true },
        requestedAt: "2026-06-27T18:04:00.000Z",
        requestedBy: "operator:sre",
        reason: "expanded from route failover to regional failover",
      }),
    );
    const current = buildOperatorConsoleProjection(eventLog).pendingApprovals[0];
    const mcp = createHumanOperatorMcpSurface({
      readEvents: () => eventLog,
      appendEvents: (events) => eventLog.push(...events),
    });

    const result = await mcp.callTool(
      "operator.decide_approval",
      {
        actionId: original.actionId,
        decision: "allow",
        expectedActionSnapshotHash: original.actionSnapshotHash,
        decidedAt: "2026-06-27T18:09:00.000Z",
      },
      { actor: approverActor() },
    );

    assert.notEqual(current.actionSnapshotHash, original.actionSnapshotHash);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "OPERATOR_APPROVAL_STALE");
    assert.ok(!eventLog.some((event) => event.type === "crew.ActionApplied"));
  });

  it("does not resurrect a superseded gate after the current snapshot is approved", () => {
    const eventLog = pendingApprovalEvents();
    const original = buildOperatorConsoleProjection(eventLog).pendingApprovals[0];
    eventLog.push(
      createRequireApprovalGate({
        id: "obligation-failover-checkout-expanded",
        incidentId: "incident-checkout-sev2",
        correlationId: "corr-checkout-sev2",
        actionId: original.actionId,
        proposalId: original.proposalId,
        policyDecisionId: original.policyDecisionId,
        action: { kind: "failover", target: "checkout-route" },
        blastRadiusSnapshot: { environment: "prod", maxResources: 50, reversible: true },
        requestedAt: "2026-06-27T18:04:00.000Z",
        requestedBy: "operator:sre",
        reason: "expanded from route failover to regional failover",
      }),
    );
    const current = buildOperatorConsoleProjection(eventLog).pendingApprovals[0];
    const approved = decideApproval({
      events: eventLog,
      actionId: current.actionId,
      decision: "allow",
      actor: approverActor(),
      expectedActionSnapshotHash: current.actionSnapshotHash,
      decidedAt: "2026-06-27T18:10:00.000Z",
    });

    eventLog.push(...approved.events);

    assert.deepEqual(buildOperatorConsoleProjection(eventLog).pendingApprovals, []);
  });
});

function pendingApprovalEvents(overrides = {}) {
  const actionId = overrides.actionId ?? "action-failover-checkout";
  const action = { kind: "failover", target: "checkout-route" };
  const blastRadiusSnapshot = { environment: "prod", maxResources: 1, reversible: true };
  const policyDecision = policyDecided({
    id: `policy-require-${actionId}`,
    streamId: "policy:incident-checkout-sev2",
    seq: 1,
    ts: "2026-06-27T18:03:00.000Z",
    effect: "require-approval",
  });
  const proposal = actionProposed({
    id: `proposal-${actionId}`,
    streamId: "crew:sre",
    seq: 1,
    ts: "2026-06-27T18:03:01.000Z",
    principal: srePrincipal(),
    correlationId: "corr-checkout-sev2",
    causationId: "incident-root-cause-checkout",
    action,
    blastRadius: blastRadiusSnapshot,
    policyDecisionId: policyDecision.id,
  });
  const gate = createRequireApprovalGate({
    id: `obligation-${actionId}`,
    incidentId: "incident-checkout-sev2",
    correlationId: "corr-checkout-sev2",
    actionId,
    proposalId: proposal.id,
    policyDecisionId: policyDecision.id,
    action,
    blastRadiusSnapshot,
    requestedAt: "2026-06-27T18:03:02.000Z",
    requestedBy: "operator:sre",
    reason: "production failover requires human approval",
  });

  return [...incidentEvents(), policyDecision, proposal, gate];
}

function incidentEvents() {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-checkout",
    incidentId: "incident-checkout-sev2",
    correlationId: "corr-checkout-sev2",
    causationId: "slo-burn-checkout",
    occurredAt: "2026-06-27T18:00:00.000Z",
    payload: {
      severity: "SEV2",
      impact: "checkout error budget burning",
      causedBy: [{ id: "slo-burn-checkout", type: "slo.BudgetBurned", correlationId: "corr-checkout-sev2" }],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: "incident-triaged-checkout",
    incidentId: "incident-checkout-sev2",
    correlationId: "corr-checkout-sev2",
    causationId: opened.id,
    occurredAt: "2026-06-27T18:01:00.000Z",
    payload: { owner: "operator:sre" },
  });
  const rootCause = makeIncidentEvent(INCIDENT_EVENT_TYPES.rootCauseIdentified, {
    id: "incident-root-cause-checkout",
    incidentId: "incident-checkout-sev2",
    correlationId: "corr-checkout-sev2",
    causationId: triaged.id,
    occurredAt: "2026-06-27T18:02:00.000Z",
    payload: { rootCause: "provider edge failure" },
  });

  return [opened, triaged, rootCause];
}

function defaultSnapshot() {
  return {
    action: { kind: "failover", target: "checkout-route" },
    blastRadiusSnapshot: { environment: "prod", maxResources: 1, reversible: true },
  };
}

function approverActor() {
  return {
    subject: "user:primary-on-call",
    roles: ["approver"],
    permissions: [],
  };
}

function viewerActor() {
  return {
    subject: "user:read-only",
    roles: ["viewer"],
    permissions: [],
  };
}

function srePrincipal() {
  return createOperatorPrincipal({
    name: "SRE",
    svid: "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities: ["incident:read", "remediation:apply"],
      spendCapUsd: 50,
      requireApprovalGates: ["prod"],
    },
    enginePort: "hobo:sre-engine/built-in@0.1.0",
  });
}
