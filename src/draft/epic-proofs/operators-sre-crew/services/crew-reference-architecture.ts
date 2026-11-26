import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMockBoundaryRecorder,
  scenarioBoundaries,
} from "../adapters/mocked-boundaries.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const refRoot = path.resolve(moduleDir, "..");
const repoRelativeRoot =
  "src/draft/epic-proofs/operators-sre-crew";

export const boundaryCatalog = [
  {
    id: "endpoint-monitor-to-slo-signals",
    boundary: "Endpoint Monitor -> SLO signal source",
    consumer: "Endpoint Monitor operator",
    provider: "SLO signal source",
    protocol: "event/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/endpoint-monitor-slo-signals.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "sre-operator-to-projection-read-api",
    boundary: "SRE operator -> projection read API",
    consumer: "SRE operator",
    provider: "projection read API",
    protocol: "mcp/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/sre-projection-read-api.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "sre-operator-to-policy-engine",
    boundary: "SRE operator -> policy engine",
    consumer: "SRE operator",
    provider: "policy engine",
    protocol: "wit/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/sre-policy-engine.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "sre-operator-to-remediation-gateway",
    boundary: "SRE operator -> remediation/live-fix gateway",
    consumer: "SRE operator",
    provider: "remediation live-fix gateway",
    protocol: "event/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/sre-remediation-gateway.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "sre-operator-to-a2h-notifier",
    boundary: "SRE operator -> A2H notifier",
    consumer: "SRE operator",
    provider: "notify receiver",
    protocol: "event/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/sre-a2h-notifier.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "sre-operator-to-issue-tracker",
    boundary: "SRE operator -> issue tracker port",
    consumer: "SRE operator",
    provider: "issue tracker port",
    protocol: "port/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/sre-issue-tracker.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "sre-operator-to-knowledge-base",
    boundary: "SRE operator -> knowledge port",
    consumer: "SRE operator",
    provider: "knowledge port",
    protocol: "port/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/sre-knowledge-base.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "dr-runbook-to-replicated-event-log",
    boundary: "DR runbook -> replicated event log",
    consumer: "DR runbook executor",
    provider: "replicated event log",
    protocol: "event/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/dr-replicated-event-log.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "consumer_tested",
  },
  {
    id: "chaos-orchestrator-to-fault-injector",
    boundary: "Chaos orchestrator -> sandbox fault injector",
    consumer: "Chaos experiment orchestrator",
    provider: "sandbox fault injector",
    protocol: "event/json",
    pactFile: `${repoRelativeRoot}/contracts/pacts/chaos-fault-injector.pact.json`,
    providerVerification: "mocked provider unavailable",
    mockedInSimulation: true,
    status: "mocked_provider_unavailable",
  },
];

const scenarioBoundaryIds = {
  "provider-degraded-api": [
    "endpoint-monitor-to-slo-signals",
    "sre-operator-to-projection-read-api",
    "sre-operator-to-policy-engine",
    "sre-operator-to-remediation-gateway",
    "sre-operator-to-issue-tracker",
    "sre-operator-to-knowledge-base",
  ],
  "prod-contract-skew": [
    "sre-operator-to-projection-read-api",
    "sre-operator-to-policy-engine",
    "sre-operator-to-a2h-notifier",
    "sre-operator-to-remediation-gateway",
    "sre-operator-to-issue-tracker",
  ],
  "ambiguous-runaway-remediation": [
    "sre-operator-to-projection-read-api",
    "sre-operator-to-policy-engine",
    "sre-operator-to-a2h-notifier",
    "sre-operator-to-issue-tracker",
  ],
  "regional-dr-failover": [
    "sre-operator-to-policy-engine",
    "dr-runbook-to-replicated-event-log",
    "sre-operator-to-knowledge-base",
  ],
};

const defaultScenarioIds = [
  "provider-degraded-api",
  "prod-contract-skew",
  "ambiguous-runaway-remediation",
  "regional-dr-failover",
];

export async function loadCrewReferenceFixture(scenarioId) {
  const fixturePath = path.join(refRoot, "simulation", "fixtures", `${scenarioId}.json`);
  const fixture = await readFile(fixturePath, "utf8");
  return JSON.parse(fixture);
}

export async function listServiceBoundaryContracts() {
  return Promise.all(
    boundaryCatalog.map(async (contract) => {
      const absolutePactPath = path.join(
        refRoot,
        contract.pactFile.replace(`${repoRelativeRoot}/`, ""),
      );
      const pact = JSON.parse(await readFile(absolutePactPath, "utf8"));
      return {
        ...contract,
        interactions: pact.interactions.map((interaction) => interaction.description),
      };
    }),
  );
}

export async function runCrewReferenceSimulation(options = {}) {
  const scenarioIds = options.scenarioIds ?? defaultScenarioIds;
  const humanDecisions = options.humanDecisions ?? {};
  const recorder = createMockBoundaryRecorder();
  const scenarios = [];

  for (const scenarioId of scenarioIds) {
    const fixture = await loadCrewReferenceFixture(scenarioId);
    scenarios.push(runScenario(fixture, humanDecisions[scenarioId], recorder));
  }

  return {
    epic: {
      id: "036f25f3-94bf-4253-ac06-d128eaedbf49",
      title: "Operators & SRE - the Crew",
    },
    scenarios,
    boundaryCalls: recorder.calls,
    liveNetworkCalls: [],
    contracts: await listServiceBoundaryContracts(),
  };
}

function runScenario(fixture, humanDecision, recorder) {
  const boundaries = scenarioBoundaries(boundaryCatalog, scenarioBoundaryIds[fixture.id]);

  for (const boundary of boundaries) {
    recorder.call(boundary.id, fixture.mockInteractions[boundary.id], {
      incidentId: fixture.incidentId,
      scenarioId: fixture.id,
    });
  }

  if (fixture.id === "provider-degraded-api") {
    return providerDegradedScenario(fixture, boundaries);
  }
  if (fixture.id === "prod-contract-skew") {
    return contractSkewScenario(fixture, humanDecision, boundaries);
  }
  if (fixture.id === "ambiguous-runaway-remediation") {
    return runawayScenario(fixture, boundaries);
  }
  if (fixture.id === "regional-dr-failover") {
    return drFailoverScenario(fixture, boundaries);
  }
  throw new Error(`Unknown scenario fixture: ${fixture.id}`);
}

function providerDegradedScenario(fixture, boundaries) {
  return scenarioResult(fixture, "resolved", boundaries, [
    event("slo.BudgetBurned", fixture.incidentId, {
      service: fixture.service,
      burnRate: fixture.signal.burnRate,
    }),
    event("incident.Opened", fixture.incidentId, {
      severity: fixture.severity,
      correlationId: fixture.correlationId,
    }),
    event("crew.AgentDispatched", fixture.incidentId, {
      operator: "sre",
      reason: "endpoint-monitor-slo-burn",
    }),
    event("projection.Diagnosed", fixture.incidentId, {
      failureClass: "provider-degraded",
      evidence: fixture.diagnosis.evidence,
    }),
    event("runbook.Selected", fixture.incidentId, {
      runbook: "high-5xx-on-api",
      version: "1.0.0",
    }),
    event("crew.actionProposed", fixture.incidentId, {
      action: "failover-provider",
      effect: "canary_with_auto_rollback",
    }),
    event("policy.Decided", fixture.incidentId, {
      decision: "allow_canary",
      obligations: ["watch-error-budget", "rollback-on-regression"],
    }),
    event("liveFix.CanaryStarted", fixture.incidentId, {
      targetCamp: "prod-azure-east",
      percent: 5,
    }),
    event("liveFix.CanaryCompleted", fixture.incidentId, {
      targetCamp: "prod-azure-east",
      result: "healthy",
    }),
    event("incident.Resolved", fixture.incidentId, {
      mttrMinutes: fixture.slo.mttrMinutes,
    }),
    event("postmortem.Generated", fixture.incidentId, {
      replayHash: fixture.replayHash,
    }),
    event("knowledge.PostmortemPublished", fixture.incidentId, {
      target: "knowledge-port",
    }),
    event("issueTracker.IncidentSynced", fixture.incidentId, {
      externalKey: fixture.issueKey,
    }),
  ]);
}

function contractSkewScenario(fixture, humanDecision, boundaries) {
  const baseEvents = [
    event("compat.GateFailed", fixture.incidentId, {
      producer: fixture.producer,
      consumer: fixture.consumer,
    }),
    event("incident.Opened", fixture.incidentId, {
      severity: fixture.severity,
      correlationId: fixture.correlationId,
    }),
    event("crew.AgentDispatched", fixture.incidentId, {
      operator: "sre",
      reason: "compat-gate-failed",
    }),
    event("projection.Diagnosed", fixture.incidentId, {
      failureClass: "contract-skew",
      evidence: fixture.diagnosis.evidence,
    }),
    event("crew.actionProposed", fixture.incidentId, {
      action: "dual-publish-shim",
      effect: "require_approval",
    }),
    event("policy.Decided", fixture.incidentId, {
      decision: "require_approval",
      obligations: ["on-call-ack", "operator-console-approval"],
    }),
    event("crew.handoffRequested", fixture.incidentId, {
      to: "on-call",
      package: "contract-skew-shim-approval",
    }),
    event("notify.Sent", fixture.incidentId, {
      receiver: "on-call-primary",
    }),
  ];

  if (humanDecision !== "approve") {
    return scenarioResult(fixture, "waiting_for_human_approval", boundaries, baseEvents);
  }

  return scenarioResult(fixture, "resolved_after_approval", boundaries, [
    ...baseEvents,
    event("console.ApprovalDecided", fixture.incidentId, {
      decision: "approve",
      snapshotHash: fixture.approvalSnapshotHash,
    }),
    event("liveFix.CanaryStarted", fixture.incidentId, {
      action: "dual-publish-shim",
      percent: 5,
    }),
    event("liveFix.CanaryCompleted", fixture.incidentId, {
      action: "dual-publish-shim",
      result: "healthy",
    }),
    event("crew.actionApplied", fixture.incidentId, {
      action: "dual-publish-shim",
    }),
    event("incident.Resolved", fixture.incidentId, {
      mttrMinutes: fixture.slo.mttrMinutes,
    }),
  ]);
}

function runawayScenario(fixture, boundaries) {
  return scenarioResult(fixture, "escalated", boundaries, [
    event("resource.DriftDetected", fixture.incidentId, {
      resource: fixture.resource,
      source: fixture.signal.source,
    }),
    event("incident.Opened", fixture.incidentId, {
      severity: fixture.severity,
      correlationId: fixture.correlationId,
    }),
    event("projection.Diagnosed", fixture.incidentId, {
      failureClass: "unknown",
      evidence: fixture.diagnosis.evidence,
    }),
    event("runawayGuard.CircuitOpened", fixture.incidentId, {
      reason: "self-caused-remediation-loop",
      cooldownMinutes: fixture.cooldownMinutes,
    }),
    event("policy.Decided", fixture.incidentId, {
      decision: "deny_write_escalate",
      obligations: ["human-review", "runbook-revision"],
    }),
    event("crew.handoffRequested", fixture.incidentId, {
      to: "on-call",
      package: "runaway-remediation-loop",
    }),
    event("notify.Sent", fixture.incidentId, {
      receiver: "on-call-primary",
    }),
    event("issueTracker.FollowupFiled", fixture.incidentId, {
      title: "Revise drift runbook guard",
    }),
  ]);
}

function drFailoverScenario(fixture, boundaries) {
  return scenarioResult(fixture, "integrity_certified", boundaries, [
    event("dr.RegionLossDetected", fixture.incidentId, {
      region: fixture.failedRegion,
    }),
    event("incident.Opened", fixture.incidentId, {
      severity: fixture.severity,
      correlationId: fixture.correlationId,
    }),
    event("dr.FencingVerified", fixture.incidentId, {
      leaseOwner: fixture.survivorRegion,
      splitBrain: false,
    }),
    event("dr.RpoReported", fixture.incidentId, {
      rpoSeconds: fixture.rpoSeconds,
      honesty: "bounded-staleness-disclosed",
    }),
    event("dr.ReplayVerified", fixture.incidentId, {
      replayedEvents: fixture.replayedEvents,
      replayHash: fixture.replayHash,
    }),
    event("policy.Decided", fixture.incidentId, {
      decision: "allow_failover",
      obligations: ["publish-status-page", "postmortem"],
    }),
    event("crew.actionProposed", fixture.incidentId, {
      action: "regional-traffic-shift",
      effect: "canary_with_auto_rollback",
    }),
    event("dr.TrafficShiftReady", fixture.incidentId, {
      targetRegion: fixture.survivorRegion,
    }),
    event("incident.Resolved", fixture.incidentId, {
      mttrMinutes: fixture.slo.mttrMinutes,
    }),
  ]);
}

function scenarioResult(fixture, status, boundaries, events) {
  return {
    id: fixture.id,
    title: fixture.title,
    persona: fixture.persona,
    bddScenario: fixture.bddScenario,
    verticalSlice: fixture.verticalSlice,
    status,
    boundaries,
    events,
  };
}

function event(type, incidentId, body) {
  return {
    type,
    incidentId,
    body,
  };
}
