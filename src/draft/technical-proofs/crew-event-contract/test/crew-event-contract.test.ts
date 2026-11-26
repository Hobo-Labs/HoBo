import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  actionApplied,
  actionDenied,
  actionProposed,
  agentDispatched,
  createOperatorPrincipal,
  foldCrewStream,
  handoffRequested,
  policyDecided,
  roundTripCrewEvent,
} from "../src/crew-event-contract.js";

const sre = createOperatorPrincipal({
  name: "SRE",
  svid: "spiffe://yard/acme/agent/sre",
  perAgentPolicy: {
    scopedCapabilities: ["incident:read", "remediation:propose"],
    spendCapUsd: 50,
    requireApprovalGates: ["prod", "destroy", "over-budget"],
  },
  enginePort: "hobo:sre-engine/built-in@0.1.0",
});

describe("crew.* event contract", () => {
  it("round-trips event schemas and stamps principal/correlation metadata", () => {
    const dispatch = agentDispatched({
      id: "evt-dispatch",
      streamId: "crew:sre",
      seq: 1,
      ts: "2026-06-25T05:00:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "alert-1",
      trigger: {
        type: "alert.Fired",
        id: "alert-1",
      },
    });
    const proposed = actionProposed({
      id: "proposal-round-trip",
      streamId: "crew:sre",
      seq: 2,
      ts: "2026-06-25T05:01:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "evt-dispatch",
      action: { kind: "failover", target: "prod-azure" },
      blastRadius: { environment: "prod", maxResources: 1, reversible: true },
      policyDecisionId: "policy-round-trip",
    });
    const applied = actionApplied({
      id: "applied-round-trip",
      streamId: "crew:sre",
      seq: 3,
      ts: "2026-06-25T05:02:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "proposal-round-trip",
      proposalId: "proposal-round-trip",
      policyDecisionId: "policy-round-trip",
    });
    const denied = actionDenied({
      id: "denied-round-trip",
      streamId: "crew:sre",
      seq: 4,
      ts: "2026-06-25T05:03:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "proposal-round-trip",
      proposalId: "proposal-round-trip",
      policyDecisionId: "policy-round-trip-deny",
      reason: "blocked by prod gate",
    });
    const handoff = handoffRequested({
      id: "handoff-round-trip",
      streamId: "crew:sre",
      seq: 5,
      ts: "2026-06-25T05:04:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "denied-round-trip",
      target: { kind: "human", name: "on-call" },
      reason: "needs human approval",
    });

    for (const event of [dispatch, proposed, applied, denied, handoff]) {
      assert.deepEqual(roundTripCrewEvent(event), event);
    }
    assert.equal(dispatch.type, "crew.AgentDispatched");
    assert.equal(dispatch.principal.name, "SRE");
    assert.equal(dispatch.correlationId, "incident-1");
    assert.equal(dispatch.causationId, "alert-1");
  });

  it("normalizes the operator principal descriptor", () => {
    const disabled = createOperatorPrincipal({
      name: "UX Designer",
      svid: "spiffe://yard/acme/agent/ux",
      perAgentPolicy: {
        scopedCapabilities: ["ui:generate", "ui:read", "ui:generate"],
        spendCapUsd: 5,
        requireApprovalGates: ["prod"],
      },
      enginePort: "hobo:ux-engine/built-in@0.1.0",
      disabled: true,
    });

    assert.equal(disabled.disabled, true);
    assert.deepEqual(disabled.perAgentPolicy.scopedCapabilities, ["ui:generate", "ui:read"]);
    assert.throws(
      () =>
        createOperatorPrincipal({
          name: "bad",
          svid: "https://not-spiffe",
          perAgentPolicy: { scopedCapabilities: [], spendCapUsd: 0, requireApprovalGates: [] },
          enginePort: "hobo:sre-engine/built-in@0.1.0",
        }),
      /SPIFFE URI/,
    );
  });

  it("replays a proposed and applied action into an auditable summary", () => {
    const decision = policyDecided({
      id: "policy-1",
      streamId: "policy:incident-1",
      seq: 1,
      ts: "2026-06-25T05:01:00.000Z",
      effect: "allow",
    });
    const proposed = actionProposed({
      id: "proposal-1",
      streamId: "crew:sre",
      seq: 2,
      ts: "2026-06-25T05:02:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "evt-dispatch",
      action: { kind: "failover", target: "prod-azure" },
      blastRadius: { environment: "prod", maxResources: 1, reversible: true },
      policyDecisionId: "policy-1",
    });
    const applied = actionApplied({
      id: "applied-1",
      streamId: "crew:sre",
      seq: 3,
      ts: "2026-06-25T05:03:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "proposal-1",
      proposalId: "proposal-1",
      policyDecisionId: "policy-1",
    });

    const replay = foldCrewStream([decision, proposed, applied]);

    assert.deepEqual(replay.actions, [
      {
        operator: "SRE",
        action: "failover",
        target: "prod-azure",
        policyDecisionId: "policy-1",
        status: "applied",
        appliedAt: "2026-06-25T05:03:00.000Z",
      },
    ]);
  });

  it("replays denied actions against the same policy decision seam", () => {
    const decision = policyDecided({
      id: "policy-deny-1",
      streamId: "policy:incident-2",
      seq: 1,
      ts: "2026-06-25T05:05:00.000Z",
      effect: "deny",
    });
    const proposed = actionProposed({
      id: "proposal-deny-1",
      streamId: "crew:sre",
      seq: 2,
      ts: "2026-06-25T05:06:00.000Z",
      principal: sre,
      correlationId: "incident-2",
      action: { kind: "scale", target: "prod-api" },
      blastRadius: { environment: "prod", maxResources: 3, reversible: true },
      policyDecisionId: "policy-deny-1",
    });
    const denied = actionDenied({
      id: "denied-1",
      streamId: "crew:sre",
      seq: 3,
      ts: "2026-06-25T05:07:00.000Z",
      principal: sre,
      correlationId: "incident-2",
      proposalId: "proposal-deny-1",
      policyDecisionId: "policy-deny-1",
      reason: "prod scale requires approval",
    });

    const replay = foldCrewStream([decision, proposed, denied]);

    assert.deepEqual(replay.actions, [
      {
        operator: "SRE",
        action: "scale",
        target: "prod-api",
        policyDecisionId: "policy-deny-1",
        status: "denied",
      },
    ]);
  });

  it("rejects applied actions without a policy decision reference", () => {
    assert.throws(
      () =>
        actionApplied({
          id: "applied-1",
          streamId: "crew:sre",
          seq: 1,
          ts: "2026-06-25T05:03:00.000Z",
          principal: sre,
          correlationId: "incident-1",
          causationId: "proposal-1",
          proposalId: "proposal-1",
        }),
      /policyDecisionId is required/,
    );
  });

  it("rejects apply facts that lack preceding proposal or policy decision facts", () => {
    const applied = actionApplied({
      id: "applied-1",
      streamId: "crew:sre",
      seq: 1,
      ts: "2026-06-25T05:03:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      causationId: "proposal-1",
      proposalId: "proposal-1",
      policyDecisionId: "policy-1",
    });

    assert.throws(() => foldCrewStream([applied]), /without preceding crew.ActionProposed/);

    const proposed = actionProposed({
      id: "proposal-1",
      streamId: "crew:sre",
      seq: 1,
      ts: "2026-06-25T05:02:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      action: { kind: "failover", target: "prod-azure" },
      blastRadius: { environment: "prod", maxResources: 1, reversible: true },
      policyDecisionId: "policy-1",
    });

    assert.throws(() => foldCrewStream([proposed, applied]), /without preceding policy.Decided/);
  });

  it("rejects applied actions when policy decision denied or still gates the proposal", () => {
    for (const effect of ["deny", "require-approval"]) {
      const decision = policyDecided({
        id: `policy-${effect}`,
        streamId: "policy:incident-1",
        seq: 1,
        ts: "2026-06-25T05:01:00.000Z",
        effect,
      });
      const proposed = actionProposed({
        id: `proposal-${effect}`,
        streamId: "crew:sre",
        seq: 2,
        ts: "2026-06-25T05:02:00.000Z",
        principal: sre,
        correlationId: "incident-1",
        action: { kind: "failover", target: "prod-azure" },
        blastRadius: { environment: "prod", maxResources: 1, reversible: true },
        policyDecisionId: `policy-${effect}`,
      });
      const applied = actionApplied({
        id: `applied-${effect}`,
        streamId: "crew:sre",
        seq: 3,
        ts: "2026-06-25T05:03:00.000Z",
        principal: sre,
        correlationId: "incident-1",
        causationId: `proposal-${effect}`,
        proposalId: `proposal-${effect}`,
        policyDecisionId: `policy-${effect}`,
      });

      assert.throws(
        () => foldCrewStream([decision, proposed, applied]),
        /requires an allow or warn policy.Decided effect/,
      );
    }
  });

  it("rejects action resolution that crosses proposal correlation boundaries", () => {
    const decision = policyDecided({
      id: "policy-correlation",
      streamId: "policy:incident-1",
      seq: 1,
      ts: "2026-06-25T05:01:00.000Z",
      effect: "allow",
    });
    const proposed = actionProposed({
      id: "proposal-correlation",
      streamId: "crew:sre",
      seq: 2,
      ts: "2026-06-25T05:02:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      action: { kind: "failover", target: "prod-azure" },
      blastRadius: { environment: "prod", maxResources: 1, reversible: true },
      policyDecisionId: "policy-correlation",
    });
    const applied = actionApplied({
      id: "applied-correlation",
      streamId: "crew:sre",
      seq: 3,
      ts: "2026-06-25T05:03:00.000Z",
      principal: sre,
      correlationId: "incident-2",
      causationId: "proposal-correlation",
      proposalId: "proposal-correlation",
      policyDecisionId: "policy-correlation",
    });

    assert.throws(
      () => foldCrewStream([decision, proposed, applied]),
      /correlationId does not match its proposal/,
    );
  });

  it("serializes racing handoffs by correlation id", () => {
    const gitops = createOperatorPrincipal({
      name: "GitOps",
      svid: "spiffe://yard/acme/agent/gitops",
      perAgentPolicy: {
        scopedCapabilities: ["deployment:promote"],
        spendCapUsd: 10,
        requireApprovalGates: ["prod"],
      },
      enginePort: "hobo:gitops-engine/built-in@0.1.0",
    });
    const first = handoffRequested({
      id: "handoff-1",
      streamId: "crew:sre",
      seq: 1,
      ts: "2026-06-25T05:04:00.000Z",
      principal: sre,
      correlationId: "incident-1",
      target: { kind: "operator", name: "GitOps" },
      reason: "deployment rollback needs GitOps operator",
    });
    const racing = handoffRequested({
      id: "handoff-2",
      streamId: "crew:gitops",
      seq: 1,
      ts: "2026-06-25T05:04:01.000Z",
      principal: gitops,
      correlationId: "incident-1",
      target: { kind: "human", name: "on-call" },
      reason: "same incident raced without causation",
    });
    const serialized = handoffRequested({
      ...racing,
      id: "handoff-3",
      causationId: "handoff-1",
    });

    assert.throws(() => foldCrewStream([first, racing]), /handoff race for correlationId incident-1/);
    assert.equal(foldCrewStream([first, serialized]).handoffs.length, 2);
  });
});
