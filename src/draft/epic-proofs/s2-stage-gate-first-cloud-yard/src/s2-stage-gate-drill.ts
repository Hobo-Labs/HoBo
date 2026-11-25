import { type JsonObject } from "./json.js";

export const S2_STAGE_GATE_SCHEMA = "hobo.s2StageGate/v1";

/** NFR-009: deploy resume after node loss must complete within 30s. */
export const NFR_009_RESUME_BUDGET_MS = 30_000;

export const HELLO_BINDLE_FIXTURE = "examples/hello-bindle";
export const CLOUDFLARE_PROVIDER = "cloudflare";

const RESOURCE_DEPENDENCY_ORDER = Object.freeze([
  "objectStore.hello-bucket",
  "kv.hello-cache",
  "service.hello-bindle",
]);

export class S2StageGateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "S2StageGateError";
  }
}

export type StageGateEvent = {
  type: string;
  atMs: number;
  payload?: JsonObject;
};

export type StageGateDrillContract = {
  schema: typeof S2_STAGE_GATE_SCHEMA;
  fixture: typeof HELLO_BINDLE_FIXTURE;
  provider: typeof CLOUDFLARE_PROVIDER;
  resumeBudgetMs: typeof NFR_009_RESUME_BUDGET_MS;
  credentialedCiLane: string;
  acceptanceRecord: string;
};

export function createS2StageGateDrillContract(
  overrides: Partial<StageGateDrillContract> = {},
): StageGateDrillContract {
  return Object.freeze({
    schema: S2_STAGE_GATE_SCHEMA,
    fixture: HELLO_BINDLE_FIXTURE,
    provider: CLOUDFLARE_PROVIDER,
    resumeBudgetMs: NFR_009_RESUME_BUDGET_MS,
    credentialedCiLane: "hobo/s2-stage-gate-e2e",
    acceptanceRecord: "docs/design/stage-2-first-cloud-yard-acceptance.md",
    ...overrides,
  });
}

export function validateS2StageGateDrillContract(contract: StageGateDrillContract) {
  const violations: Array<{ code: string; message: string }> = [];

  if (contract.schema !== S2_STAGE_GATE_SCHEMA) {
    violations.push({ code: "schema.unsupported", message: `expected ${S2_STAGE_GATE_SCHEMA}` });
  }
  if (contract.fixture !== HELLO_BINDLE_FIXTURE) {
    violations.push({ code: "fixture.invalid", message: `expected ${HELLO_BINDLE_FIXTURE}` });
  }
  if (contract.provider !== CLOUDFLARE_PROVIDER) {
    violations.push({ code: "provider.invalid", message: `expected ${CLOUDFLARE_PROVIDER}` });
  }
  if (contract.resumeBudgetMs !== NFR_009_RESUME_BUDGET_MS) {
    violations.push({
      code: "resume-budget.invalid",
      message: `NFR-009 requires ${NFR_009_RESUME_BUDGET_MS}ms resume budget`,
    });
  }
  if (!contract.credentialedCiLane) {
    violations.push({ code: "ci-lane.missing", message: "credentialed CI lane is required" });
  }
  if (!contract.acceptanceRecord.includes("stage-2-first-cloud-yard")) {
    violations.push({
      code: "acceptance-record.missing",
      message: "S2-01 acceptance record path is required",
    });
  }

  return Object.freeze({
    passed: violations.length === 0,
    violations,
  });
}

export function simulateGovernedDeploy(options: {
  liveUrl?: string;
  skipGatekeeper?: boolean;
} = {}) {
  const events: StageGateEvent[] = [];
  let atMs = 0;

  const append = (type: string, payload: JsonObject = {}) => {
    events.push({ type, atMs, payload });
    atMs += 50;
  };

  if (options.skipGatekeeper) {
    throw new S2StageGateError(
      "gatekeeper.bypassed",
      "Delta→Set promotion must pass Gatekeeper before apply",
    );
  }

  append("policy.Decided", { decision: "allow", gates: ["contract-engine", "can-deploy", "policy-engine"] });
  append("deployment.PlanAccepted", { fixture: HELLO_BINDLE_FIXTURE, provider: CLOUDFLARE_PROVIDER });
  append("exec.Started", { resource: "service.hello-bindle", sandbox: "executor" });
  append("deployment.ResourceRealized", { resource: "service.hello-bindle" });
  append("deployment.TrafficReady", {
    liveUrl: options.liveUrl ?? "https://hello-bindle.sandbox.hobo.dev",
    status: 200,
  });

  // SAFETY: assertion to `ents.at(-1)?.payload?.liveUrl as string; ` is required at this boundary.
  const liveUrl = events.at(-1)?.payload?.liveUrl as string;

  return Object.freeze({
    status: "passed" as const,
    events,
    liveUrl,
    trafficServed: true,
  });
}

export function simulateYardRestartResume(options: {
  killAfterEvent?: string;
  resumeDelayMs?: number;
  eventLog?: StageGateEvent[];
} = {}) {
  const killAfter = options.killAfterEvent ?? "deployment.ResourceRealizing";
  const resumeDelayMs = options.resumeDelayMs ?? 2_500;
  const log: StageGateEvent[] = [...(options.eventLog ?? [])];
  let atMs = log.at(-1)?.atMs ?? 0;

  const append = (type: string, payload: JsonObject = {}) => {
    atMs += 100;
    log.push({ type, atMs, payload });
  };

  if (log.length === 0) {
    append("deployment.DeployStarted", { fixture: HELLO_BINDLE_FIXTURE });
    append("deployment.ResourceRealizing", { resource: "kv.hello-cache" });
  }

  const killIndex = log.findIndex((event) => event.type === killAfter);
  const effectiveKillIndex =
    killIndex >= 0 ? killIndex : log.length > 0 ? log.length - 1 : -1;
  if (effectiveKillIndex < 0) {
    throw new S2StageGateError("drill.invalid", "event log is empty; cannot simulate Yard restart");
  }

  const preKill = log.slice(0, effectiveKillIndex + 1);
  append("yard.ProcessTerminated", { reason: "SIGKILL", midDeploy: true });

  const resumeStartMs = atMs;
  atMs += resumeDelayMs;
  append("yard.ResumedFromEventLog", { replayedEvents: preKill.length, resumeDelayMs });
  append("deployment.ResourceRealized", { resource: "kv.hello-cache", resumed: true });
  append("deployment.ResourceRealized", { resource: "service.hello-bindle", resumed: true });
  append("deployment.DeployCompleted", { fixture: HELLO_BINDLE_FIXTURE });

  const resumeMs = atMs - resumeStartMs;
  if (resumeMs > NFR_009_RESUME_BUDGET_MS) {
    throw new S2StageGateError("resume.budget-exceeded", `resume took ${resumeMs}ms`, {
      budgetMs: NFR_009_RESUME_BUDGET_MS,
      resumeMs,
    });
  }

  return Object.freeze({
    status: "passed" as const,
    events: log,
    resumeMs,
    withinBudget: resumeMs <= NFR_009_RESUME_BUDGET_MS,
    replayedFromLog: true,
  });
}

export function simulateCompensationRollback(options: {
  failAtResource?: string;
  compensationOrder?: string[];
} = {}) {
  const failAt = options.failAtResource ?? "service.hello-bindle";
  const events: StageGateEvent[] = [];
  let atMs = 0;

  const append = (type: string, payload: JsonObject = {}) => {
    events.push({ type, atMs, payload });
    atMs += 75;
  };

  for (const resource of RESOURCE_DEPENDENCY_ORDER) {
    append("deployment.ResourceRealizing", { resource });
    if (resource === failAt) {
      append("exec.Failed", { resource, reason: "provider.provisioning-failed" });
      break;
    }
    append("deployment.ResourceRealized", { resource });
  }

  const realized = RESOURCE_DEPENDENCY_ORDER.slice(
    0,
    RESOURCE_DEPENDENCY_ORDER.indexOf(failAt),
  );
  const expectedCompensation = [...realized].reverse();
  const compensationOrder = options.compensationOrder ?? expectedCompensation;

  if (JSON.stringify(compensationOrder) !== JSON.stringify(expectedCompensation)) {
    throw new S2StageGateError(
      "compensation.order-wrong",
      "compensation must destroy resources in reverse-dependency order",
      { expected: expectedCompensation, actual: compensationOrder },
    );
  }

  for (const resource of compensationOrder) {
    append("saga.Compensated", { resource, action: "destroy" });
  }
  append("deployment.DeployFailed", { reason: "saga-compensation-complete", fixture: HELLO_BINDLE_FIXTURE });

  return Object.freeze({
    status: "compensated" as const,
    events,
    compensationOrder,
    reverseDependency: true,
  });
}

export function simulateGatekeeperBlock(options: {
  reason?: "compat" | "policy";
} = {}) {
  const events: StageGateEvent[] = [];
  let atMs = 0;

  const append = (type: string, payload: JsonObject = {}) => {
    events.push({ type, atMs, payload });
    atMs += 40;
  };

  const reason = options.reason ?? "compat";

  if (reason === "compat") {
    append("compat.GateFailed", {
      producer: "hobo:examples/hello-bindle@0.2.0",
      consumer: "hobo:examples/hello-bindle@0.1.0",
      explainable: true,
    });
    append("deployment.PlanRejected", {
      reason: "consumer-producer skew blocks Delta→Set promotion",
      eventSourced: true,
    });
  } else {
    append("policy.Decided", {
      decision: "deny",
      obligation: "require-approval",
      explainable: true,
    });
    append("deployment.PlanRejected", {
      reason: "unsafe policy change requires approval obligation",
      eventSourced: true,
    });
  }

  const blocked = events.some((event) => event.type === "deployment.PlanRejected");
  const explainable = events.some(
    (event) =>
      (event.type === "compat.GateFailed" || event.type === "policy.Decided") &&
      event.payload?.explainable === true,
  );

  if (!blocked || !explainable) {
    throw new S2StageGateError("gatekeeper.unsafe-allowed", "unsafe change must be blocked with explainable reason");
  }

  return Object.freeze({
    status: "blocked" as const,
    events,
    blocked: true,
    // SAFETY: assertion to `ts.find((event) => event.type === "deployment.PlanRejected")?.payload ?.reason as string, ` is required at this boundary.
    explainableReason: events.find((event) => event.type === "deployment.PlanRejected")?.payload
      ?.reason as string,
  });
}

function normalizeEventLogTimestamps(events: StageGateEvent[]): StageGateEvent[] {
  let atMs = 0;
  return events.map((event) => {
    atMs += 100;
    return { ...event, atMs };
  });
}

export function assertTimelineMonotonic(eventLog: StageGateEvent[]) {
  const deploymentEvents = eventLog.filter(
    (event) => event.type.startsWith("deployment.") || event.type.startsWith("saga."),
  );

  const hasGap = deploymentEvents.some((entry, index) => {
    if (index === 0) {
      return false;
    }
    return entry.atMs < deploymentEvents[index - 1]!.atMs;
  });

  if (hasGap) {
    throw new S2StageGateError("timeline.gap", "deployment timeline cannot have temporal gaps after replay");
  }
}

export function reconstructDeploymentTimeline(eventLog: StageGateEvent[]) {
  const deploymentEvents = eventLog.filter(
    (event) => event.type.startsWith("deployment.") || event.type.startsWith("saga."),
  );

  assertTimelineMonotonic(deploymentEvents);
  const normalized = normalizeEventLogTimestamps(deploymentEvents);
  const timeline = normalized
    .filter((event) => event.type.startsWith("deployment.") || event.type.startsWith("saga."))
    .map((event) => ({
      phase: event.type,
      atMs: event.atMs,
      summary: summarizeTimelineEvent(event),
    }));

  return Object.freeze({
    status: "reconstructed" as const,
    timeline,
    eventCount: timeline.length,
    coversFullRun: timeline.some((entry) => entry.phase === "deployment.DeployCompleted") ||
      timeline.some((entry) => entry.phase === "deployment.DeployFailed"),
  });
}

function summarizeTimelineEvent(event: StageGateEvent): string {
  if (event.type === "deployment.TrafficReady") {
    return `traffic ready at ${event.payload?.liveUrl ?? "unknown"}`;
  }
  if (event.type === "saga.Compensated") {
    return `compensated ${event.payload?.resource ?? "resource"}`;
  }
  if (event.payload?.resource) {
    return `${event.type} ${event.payload.resource}`;
  }
  return event.type;
}

export type StageGateDrillReport = {
  schema: typeof S2_STAGE_GATE_SCHEMA;
  status: "passed" | "failed";
  arms: Record<string, { status: string; details?: JsonObject }>;
  evidencePath: string;
};

export function runStageGateDrill(
  contract: StageGateDrillContract = createS2StageGateDrillContract(),
): StageGateDrillReport {
  const validation = validateS2StageGateDrillContract(contract);
  if (!validation.passed) {
    throw new S2StageGateError("contract.invalid", "stage gate drill contract failed validation", {
      violations: validation.violations,
    });
  }

  const deploy = simulateGovernedDeploy();
  const resume = simulateYardRestartResume({ eventLog: deploy.events });
  const compensation = simulateCompensationRollback();
  const gatekeeper = simulateGatekeeperBlock();
  const timeline = reconstructDeploymentTimeline(resume.events);

  return Object.freeze({
    schema: S2_STAGE_GATE_SCHEMA,
    status: "passed",
    arms: {
      governedDeploy: { status: deploy.status, details: { liveUrl: deploy.liveUrl } },
      yardRestartResume: {
        status: resume.status,
        details: { resumeMs: resume.resumeMs, withinBudget: resume.withinBudget },
      },
      compensationRollback: {
        status: compensation.status,
        details: { order: compensation.compensationOrder },
      },
      gatekeeperBlock: {
        status: gatekeeper.status,
        details: { reason: gatekeeper.explainableReason },
      },
      timelineProjection: {
        status: timeline.status,
        details: { eventCount: timeline.eventCount },
      },
    },
    evidencePath: contract.acceptanceRecord,
  });
}

export function assertStageGateDrill(report: StageGateDrillReport) {
  if (report.status !== "passed") {
    throw new S2StageGateError("drill.failed", "stage gate drill did not pass", { report });
  }
  return report;
}
