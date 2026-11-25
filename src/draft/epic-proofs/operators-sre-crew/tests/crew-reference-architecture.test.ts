import assert from "node:assert/strict";
import { test } from "vitest";

import {
  listServiceBoundaryContracts,
  runCrewReferenceSimulation,
} from "../services/crew-reference-architecture.js";

const expectedBoundaryIds = [
  "endpoint-monitor-to-slo-signals",
  "sre-operator-to-projection-read-api",
  "sre-operator-to-policy-engine",
  "sre-operator-to-remediation-gateway",
  "sre-operator-to-a2h-notifier",
  "sre-operator-to-issue-tracker",
  "sre-operator-to-knowledge-base",
  "dr-runbook-to-replicated-event-log",
  "chaos-orchestrator-to-fault-injector",
];

test("SRE operator resolves a degraded endpoint through gated canary remediation", async () => {
  const result = await runCrewReferenceSimulation({
    scenarioIds: ["provider-degraded-api"],
  });
  const scenario = result.scenarios[0];

  assert.equal(scenario.id, "provider-degraded-api");
  assert.equal(scenario.persona, "sre-operator");
  assert.equal(scenario.verticalSlice, "detect-diagnose-gate-remediate");
  assert.equal(scenario.status, "resolved");
  assert.equal(result.liveNetworkCalls.length, 0);
  assert.ok(
    scenario.events.some((event) => event.type === "incident.Opened"),
    "incident aggregate opens from the monitoring signal",
  );
  assert.ok(
    scenario.events.some((event) => event.type === "crew.actionProposed"),
    "crew event stream records the proposed remediation",
  );
  assert.ok(
    scenario.events.some((event) => event.type === "policy.Decided"),
    "policy boundary is consulted before write action",
  );
  assert.ok(
    scenario.events.some((event) => event.type === "liveFix.CanaryCompleted"),
    "canary gateway is used instead of direct production writes",
  );
  assert.ok(
    scenario.boundaries.every((boundary) => boundary.mocked === true),
    "simulation must use mocked boundaries only",
  );
});

test("production contract skew waits for human approval before remediation", async () => {
  const pending = await runCrewReferenceSimulation({
    scenarioIds: ["prod-contract-skew"],
  });
  const pendingScenario = pending.scenarios[0];

  assert.equal(pendingScenario.status, "waiting_for_human_approval");
  assert.ok(
    pendingScenario.events.some((event) => event.type === "crew.handoffRequested"),
    "A2H handoff is emitted for human-in-the-loop approval",
  );
  assert.equal(
    pendingScenario.events.some((event) => event.type === "liveFix.CanaryCompleted"),
    false,
    "no remediation gateway write occurs before approval",
  );

  const approved = await runCrewReferenceSimulation({
    humanDecisions: { "prod-contract-skew": "approve" },
    scenarioIds: ["prod-contract-skew"],
  });
  const approvedScenario = approved.scenarios[0];

  assert.equal(approvedScenario.status, "resolved_after_approval");
  assert.ok(
    approvedScenario.events.some((event) => event.type === "console.ApprovalDecided"),
    "operator console decision is recorded with the approval snapshot",
  );
  assert.ok(
    approvedScenario.events.some((event) => event.type === "liveFix.CanaryCompleted"),
    "approved contract skew goes through canary remediation",
  );
});

test("unknown or runaway remediation signals fail closed to escalation", async () => {
  const result = await runCrewReferenceSimulation({
    scenarioIds: ["ambiguous-runaway-remediation"],
  });
  const scenario = result.scenarios[0];

  assert.equal(scenario.status, "escalated");
  assert.ok(
    scenario.events.some((event) => event.type === "runawayGuard.CircuitOpened"),
    "runaway guard opens a circuit before another write action can run",
  );
  assert.ok(
    scenario.events.some((event) => event.type === "crew.handoffRequested"),
    "unknown or self-caused remediation escalates to humans",
  );
  assert.equal(
    scenario.events.some((event) => event.type === "liveFix.CanaryCompleted"),
    false,
    "fail-closed path must not run write remediation",
  );
});

test("DR failover certifies fencing, RPO honesty, and replay before traffic shift", async () => {
  const result = await runCrewReferenceSimulation({
    scenarioIds: ["regional-dr-failover"],
  });
  const scenario = result.scenarios[0];

  assert.equal(scenario.status, "integrity_certified");
  assert.ok(
    scenario.events.some((event) => event.type === "dr.FencingVerified"),
    "split-brain fencing is verified before promotion",
  );
  assert.ok(
    scenario.events.some((event) => event.type === "dr.RpoReported"),
    "RPO honesty is part of the failover outcome",
  );
  assert.ok(
    scenario.events.some((event) => event.type === "dr.ReplayVerified"),
    "replicated event log replay is verified before traffic shift",
  );
});

test("every selected epic boundary has a consumer-driven Pact decision", async () => {
  const contracts = await listServiceBoundaryContracts();
  const contractIds = contracts.map((contract) => contract.id).sort();

  assert.deepEqual(contractIds, expectedBoundaryIds.toSorted());
  for (const contract of contracts) {
    assert.equal(contract.mockedInSimulation, true);
    assert.match(contract.pactFile, /contracts\/pacts\/.+\.pact\.json$/);
    assert.ok(contract.interactions.length > 0);
    assert.ok(
      ["consumer_tested", "mocked_provider_unavailable"].includes(contract.status),
      `unexpected contract status for ${contract.id}: ${contract.status}`,
    );
  }
});
