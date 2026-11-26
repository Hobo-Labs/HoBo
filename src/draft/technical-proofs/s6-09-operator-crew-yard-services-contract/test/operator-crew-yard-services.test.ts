import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  CREW_ROSTER,
  attemptGitOpsPromote,
  attemptPlatformDefinition,
  buildAuditViews,
  replayOperatorCrewEvents,
  runOperatorCrewScenario,
} from "../src/operator-crew-yard-services.js";

describe("S6-09 operator crew yard services contract", () => {
  it("dispatches the SRE operator when endpoint monitor reports an SLO breach", () => {
    const result = runOperatorCrewScenario(baseScenario());

    assert.equal(result.dispatched, true);
    assert.ok(
      result.events.some(
        (event) =>
          event.type === "crew.AgentDispatched" && event.data.agentId === "sre",
      ),
      "SRE operator must be dispatched on SLO burn",
    );
    assert.ok(
      result.events.some((event) => event.type === "slo.BudgetBurned"),
      "endpoint monitor SLO burn precedes dispatch",
    );
    const dispatch = result.events.find((e) => e.type === "crew.AgentDispatched");
    assert.equal(dispatch?.data.dispatchedBy, "endpoint-monitor");
    assert.equal(dispatch?.data.svid, CREW_ROSTER.sre.svid);
    assert.equal(replayOperatorCrewEvents(result.events).dispatched, true);
  });

  it("auto-canaries a low-risk fix and auto-rolls back on regression", () => {
    const result = runOperatorCrewScenario(
      baseScenario({
        rollout: {
          canaryOutcome: "regression",
          failedGate: "golden-suite-regressed",
        },
      }),
    );

    assert.equal(result.status, "rolled-back");
    assert.equal(result.applied, false);
    assert.ok(result.events.some((e) => e.type === "deployment.CanaryStarted"));
    assert.ok(result.events.some((e) => e.type === "deployment.RolledBack"));
    assert.ok(result.events.some((e) => e.type === "crew.ActionDenied"));

    const replay = replayOperatorCrewEvents(result.events);
    assert.equal(replay.status, "rolled-back");
    assert.equal(replay.applied, false);
  });

  it("blocks a production remediation until human approval", () => {
    const pending = runOperatorCrewScenario(
      baseScenario({ environment: "prod" }),
    );

    assert.equal(pending.status, "waiting-for-approval");
    assert.equal(pending.needsApproval, true);
    assert.ok(!pending.events.some((e) => e.type === "crew.ActionApplied"));
    assert.ok(pending.events.some((e) => e.type === "crew.HandoffRequested"));

    const approved = runOperatorCrewScenario(
      baseScenario({ environment: "prod", humanApproval: "approve" }),
    );

    assert.equal(approved.status, "resolved");
    assert.ok(approved.events.some((e) => e.type === "console.ApprovalDecided"));
    assert.ok(approved.events.some((e) => e.type === "crew.ActionApplied"));
  });

  it("records every crew action in credential and agent-activity audit views", () => {
    const result = runOperatorCrewScenario(baseScenario());

    assert.ok(result.audit.credentialAudit.length > 0);
    assert.ok(result.audit.agentActivity.length > 0);

    const crewEvents = result.events.filter((e) => e.type.startsWith("crew."));
    for (const crewEvent of crewEvents) {
      const agentId = crewEvent.data.agentId;
      assert.ok(
        result.audit.credentialAudit.some((entry) => entry.agentId === agentId),
        `credential audit must cover ${crewEvent.type}`,
      );
      if (crewEvent.type !== "crew.HandoffRequested") {
        assert.ok(
          result.audit.agentActivity.some((entry) => entry.agentId === agentId),
          `agent activity must cover ${crewEvent.type}`,
        );
      }
    }

    assert.ok(
      result.audit.credentialAudit.every((entry) => entry.svid.startsWith("spiffe://")),
      "every audit entry carries an SVID",
    );
  });

  it("blocks flagged model output through the AI governance sandbox", () => {
    const result = runOperatorCrewScenario(
      baseScenario({
        governance: { flaggedPrompt: true, blockReason: "jailbreak-detected" },
      }),
    );

    assert.equal(result.status, "blocked-by-governance");
    assert.equal(result.dispatched, false);
    assert.ok(result.events.some((e) => e.type === "guardrail.Blocked"));
    assert.ok(result.events.some((e) => e.type === "crew.ActionDenied"));
    assert.ok(!result.events.some((e) => e.type === "deployment.CanaryStarted"));
  });

  it("denies GitOps promote when the operator lacks the deployer role", () => {
    const result = attemptGitOpsPromote({
      principal: {
        roles: ["deployer-proposer"],
      },
      environment: "prod",
      canDeploy: { green: true },
    });

    assert.equal(result.status, "denied");
    assert.ok(result.events.some((e) => e.type === "crew.ActionDenied"));
    assert.ok(!result.events.some((e) => e.type === "deployment.Promoted"));
    assert.ok(result.audit.credentialAudit.length > 0);
  });

  it("promotes through GitOps when deployer role and can-deploy are green", () => {
    const result = attemptGitOpsPromote({
      principal: {
        roles: ["deployer", "deployer-proposer"],
      },
      environment: "prod",
      canDeploy: { green: true },
    });

    assert.equal(result.status, "promoted");
    assert.ok(result.events.some((e) => e.type === "deployment.Promoted"));
    assert.ok(result.events.some((e) => e.type === "crew.ActionApplied"));
    assert.equal(
      result.audit.credentialAudit[0]?.svid,
      CREW_ROSTER.gitops.svid,
    );
  });

  it("blocks platform-engineer definition proposals in prod until approval", () => {
    const pending = attemptPlatformDefinition({ environment: "prod" });

    assert.equal(pending.status, "waiting-for-approval");
    assert.ok(pending.events.some((e) => e.type === "crew.HandoffRequested"));
    assert.ok(!pending.events.some((e) => e.type === "definition.Proposed"));

    const approved = attemptPlatformDefinition({
      environment: "prod",
      humanApproval: "approve",
      definitionRef: "pack:checkout-api/v2",
    });

    assert.equal(approved.status, "proposed");
    assert.ok(approved.events.some((e) => e.type === "definition.Proposed"));
    assert.equal(
      approved.events.find((e) => e.type === "definition.Proposed")?.data.agentId,
      "platform-engineer",
    );
  });

  it("allows platform-engineer definition proposals in staging without approval", () => {
    const result = attemptPlatformDefinition({ environment: "staging" });

    assert.equal(result.status, "proposed");
    assert.ok(result.events.some((e) => e.type === "crew.ActionApplied"));
    assert.ok(!result.events.some((e) => e.type === "crew.HandoffRequested"));
  });

  it("exposes each crew member with distinct SVID and per-agent policy", () => {
    const roster = Object.values(CREW_ROSTER);
    const svids = new Set(roster.map((member) => member.svid));
    const policies = new Set(roster.map((member) => member.policyId));

    assert.equal(svids.size, roster.length, "each crew member has a unique SVID");
    assert.equal(policies.size, roster.length, "each crew member has a unique policy");
    assert.ok(roster.every((member) => member.autonomousReads));
    assert.ok(
      roster
        .filter((member) => member.agentId !== "endpoint-monitor")
        .every((member) => member.writeGated),
    );
  });

  it("replays audit views deterministically from the event stream", () => {
    const events = runOperatorCrewScenario(baseScenario()).events;
    const first = buildAuditViews(events);
    const second = buildAuditViews(events);

    assert.deepEqual(first, second);
  });
});

function baseScenario(overrides = {}) {
  return {
    now: "2026-07-02T08:00:00.000Z",
    environment: overrides.environment ?? "staging",
    humanApproval: overrides.humanApproval,
    signal: {
      service: "api.checkout",
      burnRate: 3.2,
      correlationId: "corr-checkout-slo",
      incidentId: "incident-checkout-slo",
      ...overrides.signal,
    },
    remediation: {
      action: "failover-provider",
      failureClass: "provider-degraded",
      riskClass: "low",
      blastRadius: { maxResources: 1, destructive: false, reversible: true },
      ...overrides.remediation,
    },
    rollout: {
      id: "rollout-s6-09-001",
      canaryPercent: 5,
      strategy: "canary",
      canaryOutcome: "healthy",
      autoRollbackSignals: ["slo-burn", "golden-suite"],
      ...overrides.rollout,
    },
    governance: overrides.governance ?? { flaggedPrompt: false },
  };
}
