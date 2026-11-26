import { isJsonString } from "./json.js";
export const OPERATOR_CREW_YARD_SERVICES_SCHEMA_VERSION =
  "hobo.draft.operator-crew-yard-services/v1";

const PROD_ENVIRONMENTS = new Set(["prod", "production"]);

export type CrewPrincipal = {
  agentId: string;
  svid: string;
  policyId: string;
  mcpTools: readonly string[];
  autonomousReads: boolean;
  writeGated: boolean;
  roles: readonly string[];
};

export type SloBreachSignal = {
  id: string;
  service: string;
  burnRate: number;
  correlationId: string;
  incidentId: string;
};

export type RemediationPlan = {
  action: string;
  failureClass: string;
  evidence: readonly string[];
  riskClass: string;
  blastRadius: {
    maxResources: number;
    destructive: boolean;
    reversible: boolean;
  };
};

/** Built-in Crew roster as Yard service principals (Plan 40). */
export const CREW_ROSTER = Object.freeze({
  "endpoint-monitor": {
    agentId: "endpoint-monitor",
    svid: "spiffe://yard.hobo/crew/endpoint-monitor",
    policyId: "policy:crew:endpoint-monitor:read-autonomous",
    mcpTools: ["probe", "report-slo-burn", "surface-drift"],
    autonomousReads: true,
    writeGated: false,
    roles: ["observer"],
  },
  sre: {
    agentId: "sre",
    svid: "spiffe://yard.hobo/crew/sre",
    policyId: "policy:crew:sre:remediate-gated",
    mcpTools: ["diagnose", "heal", "propose-fix", "escalate"],
    autonomousReads: true,
    writeGated: true,
    roles: ["remediator", "incident-owner"],
  },
  gitops: {
    agentId: "gitops",
    svid: "spiffe://yard.hobo/crew/gitops",
    policyId: "policy:crew:gitops:promote-gated",
    mcpTools: ["promote", "rollback", "inspect-can-deploy"],
    autonomousReads: true,
    writeGated: true,
    roles: ["deployer-proposer"],
  },
  "platform-engineer": {
    agentId: "platform-engineer",
    svid: "spiffe://yard.hobo/crew/platform-engineer",
    policyId: "policy:crew:platform-engineer:propose-definitions",
    mcpTools: ["propose-definition", "propose-pack"],
    autonomousReads: true,
    writeGated: true,
    roles: ["platform-author"],
  },
});

export class OperatorCrewYardServicesError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "OperatorCrewYardServicesError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Run an operator-crew scenario: SLO breach → dispatch → gated remediation.
 * Returns event stream plus credential/agent-activity audit views.
 */
export function runOperatorCrewScenario(input = {}) {
  const now = parseIso(input.now ?? "2026-07-02T00:00:00.000Z", "$.now");
  const signal = parseSloBreachSignal(input.signal);
  const environment = parseEnvironment(input.environment ?? "staging");
  const remediation = parseRemediation(input.remediation);
  const rollout = parseRollout(input.rollout);
  const governance = parseGovernance(input.governance);
  const humanApproval = input.humanApproval ?? null;

  const events = [];
  const emit = (type, data) => {
    const event = {
      id: `crew-run:${events.length + 1}`,
      type,
      schemaVersion: OPERATOR_CREW_YARD_SERVICES_SCHEMA_VERSION,
      seq: events.length + 1,
      ts: now,
      correlationId: signal.correlationId,
      causationId: events.at(-1)?.id ?? signal.id,
      data,
    };
    events.push(event);
    return event;
  };

  const endpointMonitor = CREW_ROSTER["endpoint-monitor"];
  const sre = CREW_ROSTER.sre;

  emit("slo.BudgetBurned", {
    service: signal.service,
    burnRate: signal.burnRate,
    observer: endpointMonitor.agentId,
  });

  if (governance.flaggedPrompt) {
    emit("guardrail.Blocked", {
      agentId: sre.agentId,
      reason: governance.blockReason ?? "jailbreak-or-pii-detected",
      policyRef: "policy:ai-safety:default",
    });
    emit("policy.Decided", {
      effect: "deny",
      reason: "ai-governance-block",
      agentId: sre.agentId,
    });
    emit("crew.ActionDenied", {
      agentId: sre.agentId,
      action: "heal",
      reason: "guardrail-blocked",
    });

    const audit = buildAuditViews(events);
    return finish({
      status: "blocked-by-governance",
      events,
      audit,
      dispatched: false,
    });
  }

  emit("crew.AgentDispatched", {
    agentId: sre.agentId,
    svid: sre.svid,
    policyId: sre.policyId,
    trigger: "endpoint-monitor-slo-burn",
    dispatchedBy: endpointMonitor.agentId,
    mcpTool: "diagnose",
  });

  emit("reasoning.Diagnosed", {
    agentId: sre.agentId,
    enginePort: "sre-engine",
    engineProvider: input.engineProvider ?? "builtin-default",
    failureClass: remediation.failureClass,
    evidence: remediation.evidence,
  });

  emit("crew.ActionProposed", {
    agentId: sre.agentId,
    action: remediation.action,
    blastRadius: remediation.blastRadius,
    environment,
    mcpTool: remediation.riskClass === "low" ? "heal" : "propose-fix",
  });

  const policyDecision = decideRemediationPolicy({
    environment,
    remediation,
    rollout,
  });
  emit("policy.Decided", policyDecision);

  if (policyDecision.effect === "require-approval") {
    emit("crew.HandoffRequested", {
      agentId: sre.agentId,
      to: "on-call",
      reason: policyDecision.reason,
      approvalKind: "human",
    });

    if (humanApproval !== "approve") {
      const audit = buildAuditViews(events);
      return finish({
        status: "waiting-for-approval",
        events,
        audit,
        dispatched: true,
        needsApproval: true,
      });
    }

    emit("console.ApprovalDecided", {
      decision: "approve",
      approver: "on-call-primary",
      candidateAction: remediation.action,
    });
  }

  emit("deployment.CanaryStarted", {
    agentId: sre.agentId,
    rolloutId: rollout.id,
    percent: rollout.canaryPercent,
    strategy: rollout.strategy,
    autoRollbackSignals: rollout.autoRollbackSignals,
  });

  if (rollout.canaryOutcome === "regression") {
    emit("deployment.RollbackStarted", {
      rolloutId: rollout.id,
      reason: rollout.failedGate,
      reversible: remediation.blastRadius.reversible,
    });
    emit("deployment.RolledBack", {
      rolloutId: rollout.id,
      agentId: sre.agentId,
      reason: rollout.failedGate,
    });
    emit("crew.ActionDenied", {
      agentId: sre.agentId,
      action: remediation.action,
      reason: "canary-regression",
    });

    const audit = buildAuditViews(events);
    return finish({
      status: "rolled-back",
      events,
      audit,
      dispatched: true,
      applied: false,
    });
  }

  emit("deployment.CanaryCompleted", {
    rolloutId: rollout.id,
    agentId: sre.agentId,
    result: "healthy",
  });
  emit("crew.ActionApplied", {
    agentId: sre.agentId,
    action: remediation.action,
    svid: sre.svid,
    policyEffect: policyDecision.effect,
  });
  emit("incident.Resolved", {
    incidentId: signal.incidentId,
    resolvedBy: sre.agentId,
  });

  const audit = buildAuditViews(events);
  return finish({
    status: "resolved",
    events,
    audit,
    dispatched: true,
    applied: true,
  });
}

/** Attempt a GitOps promote — role-gated per ADR-0074. */
export function attemptGitOpsPromote(input = {}) {
  const principal = parseGitOpsPrincipal(input.principal);
  const environment = parseEnvironment(input.environment ?? "prod");
  const canDeploy = input.canDeploy ?? { green: true, reason: null };
  const events = [];
  const emit = (type, data) => {
    events.push({
      id: `gitops:${events.length + 1}`,
      type,
      schemaVersion: OPERATOR_CREW_YARD_SERVICES_SCHEMA_VERSION,
      seq: events.length + 1,
      data,
    });
  };

  emit("crew.ActionProposed", {
    agentId: principal.agentId,
    action: "promote",
    environment,
    mcpTool: "promote",
  });

  if (!principal.roles.includes("deployer")) {
    emit("policy.Decided", {
      effect: "deny",
      reason: "missing-deployer-role",
      agentId: principal.agentId,
    });
    emit("crew.ActionDenied", {
      agentId: principal.agentId,
      action: "promote",
      reason: "rbac-denied",
    });
    return {
      status: "denied",
      events,
      audit: buildAuditViews(events),
    };
  }

  if (!canDeploy.green) {
    emit("policy.Decided", {
      effect: "deny",
      reason: canDeploy.reason ?? "can-deploy-red",
      agentId: principal.agentId,
    });
    emit("crew.ActionDenied", {
      agentId: principal.agentId,
      action: "promote",
      reason: "can-deploy-blocked",
    });
    return {
      status: "blocked",
      events,
      audit: buildAuditViews(events),
    };
  }

  emit("policy.Decided", {
    effect: "allow",
    reason: "can-deploy-green",
    agentId: principal.agentId,
  });
  emit("crew.ActionApplied", {
    agentId: principal.agentId,
    action: "promote",
    svid: principal.svid,
  });
  emit("deployment.Promoted", {
    environment,
    agentId: principal.agentId,
  });

  return {
    status: "promoted",
    events,
    audit: buildAuditViews(events),
  };
}

/** Attempt a Platform Engineer definition proposal — write-gated per Plan 40. */
export function attemptPlatformDefinition(input = {}) {
  const principal = parsePlatformPrincipal(input.principal);
  const environment = parseEnvironment(input.environment ?? "staging");
  const humanApproval = input.humanApproval ?? null;
  const events = [];
  const emit = (type, data) => {
    events.push({
      id: `platform:${events.length + 1}`,
      type,
      schemaVersion: OPERATOR_CREW_YARD_SERVICES_SCHEMA_VERSION,
      seq: events.length + 1,
      data,
    });
  };

  emit("crew.ActionProposed", {
    agentId: principal.agentId,
    action: "propose-definition",
    environment,
    mcpTool: "propose-definition",
  });

  if (PROD_ENVIRONMENTS.has(environment)) {
    emit("policy.Decided", {
      effect: "require-approval",
      reason: "production-definition-change",
      agentId: principal.agentId,
    });
    emit("crew.HandoffRequested", {
      agentId: principal.agentId,
      to: "platform-owner",
      reason: "production-definition-change",
      approvalKind: "human",
    });

    if (humanApproval !== "approve") {
      return {
        status: "waiting-for-approval",
        events,
        audit: buildAuditViews(events),
      };
    }

    emit("console.ApprovalDecided", {
      decision: "approve",
      approver: "platform-owner-primary",
      candidateAction: "propose-definition",
    });
  } else {
    emit("policy.Decided", {
      effect: "allow",
      reason: "staging-definition-proposal",
      agentId: principal.agentId,
    });
  }

  emit("crew.ActionApplied", {
    agentId: principal.agentId,
    action: "propose-definition",
    svid: principal.svid,
  });
  emit("definition.Proposed", {
    environment,
    agentId: principal.agentId,
    definitionRef: input.definitionRef ?? "pack:checkout-api/v2",
  });

  return {
    status: "proposed",
    events,
    audit: buildAuditViews(events),
  };
}

/** Fold crew events into credential + agent-activity audit views. */
export function buildAuditViews(events) {
  const credentialAudit = [];
  const agentActivity = [];

  for (const event of events) {
    const agentId = event.data?.agentId ?? event.data?.observer;
    if (!agentId) continue;

    const principal = findPrincipal(agentId);
    const svid = event.data?.svid ?? principal?.svid ?? `spiffe://yard.hobo/crew/${agentId}`;

    if (
      event.type.startsWith("crew.") ||
      event.type === "policy.Decided" ||
      event.type === "credential.AuditRecorded"
    ) {
      credentialAudit.push({
        agentId,
        svid,
        action: event.data?.action ?? event.type,
        tokenGrantId: `grant:${agentId}:${event.seq}`,
        ts: event.ts ?? "unknown",
        eventType: event.type,
      });
    }

    if (event.type.startsWith("crew.") || event.type === "reasoning.Diagnosed") {
      agentActivity.push({
        agentId,
        svid,
        activity: event.type,
        mcpTool: event.data?.mcpTool ?? null,
        seq: event.seq,
      });
    }
  }

  return { credentialAudit, agentActivity };
}

export function replayOperatorCrewEvents(events) {
  const audit = buildAuditViews(events);
  const dispatched = events.some((e) => e.type === "crew.AgentDispatched");
  const applied = events.some((e) => e.type === "crew.ActionApplied");
  const denied = events.some((e) => e.type === "crew.ActionDenied");
  const rolledBack = events.some((e) => e.type === "deployment.RolledBack");
  const blocked = events.some((e) => e.type === "guardrail.Blocked");

  let status = "unknown";
  if (blocked) status = "blocked-by-governance";
  else if (rolledBack) status = "rolled-back";
  else if (applied) status = "resolved";
  else if (denied && !applied) status = "denied";
  else if (events.some((e) => e.type === "crew.HandoffRequested")) status = "waiting-for-approval";

  return { status, dispatched, applied, denied, audit };
}

function decideRemediationPolicy({ environment, remediation, rollout }) {
  if (PROD_ENVIRONMENTS.has(environment)) {
    return {
      effect: "require-approval",
      reason: "production-remediation",
      policyIds: ["policy:crew:sre:prod-approval"],
    };
  }
  if (remediation.blastRadius.destructive) {
    return {
      effect: "require-approval",
      reason: "destructive-remediation",
      policyIds: ["policy:crew:sre:destructive-gate"],
    };
  }
  if (remediation.riskClass === "low" && remediation.blastRadius.reversible) {
    return {
      effect: "allow-canary",
      reason: "low-risk-reversible",
      policyIds: ["policy:crew:sre:auto-canary"],
      autoRollbackSignals: rollout.autoRollbackSignals,
    };
  }
  return {
    effect: "require-approval",
    reason: "ambiguous-risk",
    policyIds: ["policy:crew:sre:default-gate"],
  };
}

function findPrincipal(agentId) {
  return Object.values(CREW_ROSTER).find((p) => p.agentId === agentId);
}

function finish(result) {
  return {
    schemaVersion: OPERATOR_CREW_YARD_SERVICES_SCHEMA_VERSION,
    ...result,
  };
}

function parseIso(value, path) {
  if (!isJsonString(value) || Number.isNaN(Date.parse(value))) {
    throw new OperatorCrewYardServicesError("invalid-iso-timestamp", path);
  }
  return value;
}

function parseEnvironment(value) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new OperatorCrewYardServicesError("invalid-environment", "$.environment");
  }
  return value.trim().toLowerCase();
}

function parseSloBreachSignal(raw): SloBreachSignal {
  const signal = raw ?? {};
  if (!signal.service || !signal.correlationId) {
    throw new OperatorCrewYardServicesError(
      "invalid-slo-signal",
      "$.signal",
      "service and correlationId required",
    );
  }
  return {
    id: signal.id ?? `slo-burn:${signal.service}`,
    service: signal.service,
    burnRate: signal.burnRate ?? 2.5,
    correlationId: signal.correlationId,
    incidentId: signal.incidentId ?? `incident:${signal.service}`,
  };
}

function parseRemediation(raw): RemediationPlan {
  const remediation = raw ?? {};
  return {
    action: remediation.action ?? "failover-provider",
    failureClass: remediation.failureClass ?? "provider-degraded",
    evidence: remediation.evidence ?? ["provider-error-rate-spike"],
    riskClass: remediation.riskClass ?? "low",
    blastRadius: {
      maxResources: remediation.blastRadius?.maxResources ?? 1,
      destructive: remediation.blastRadius?.destructive ?? false,
      reversible: remediation.blastRadius?.reversible ?? true,
    },
  };
}

function parseRollout(raw) {
  const rollout = raw ?? {};
  return {
    id: rollout.id ?? "rollout-crew-001",
    strategy: rollout.strategy ?? "canary",
    canaryPercent: rollout.canaryPercent ?? 5,
    canaryOutcome: rollout.canaryOutcome ?? "healthy",
    failedGate: rollout.failedGate ?? "golden-suite-regressed",
    autoRollbackSignals: rollout.autoRollbackSignals ?? ["slo-burn", "golden-suite"],
  };
}

function parseGovernance(raw) {
  const governance = raw ?? {};
  return {
    flaggedPrompt: governance.flaggedPrompt ?? false,
    blockReason: governance.blockReason ?? null,
  };
}

function parseGitOpsPrincipal(raw): CrewPrincipal {
  const base = CREW_ROSTER.gitops;
  const principal = raw ?? {};
  return {
    ...base,
    agentId: principal.agentId ?? base.agentId,
    svid: principal.svid ?? base.svid,
    roles: Array.isArray(principal.roles) ? principal.roles : base.roles,
  };
}

function parsePlatformPrincipal(raw): CrewPrincipal {
  const base = CREW_ROSTER["platform-engineer"];
  const principal = raw ?? {};
  return {
    ...base,
    agentId: principal.agentId ?? base.agentId,
    svid: principal.svid ?? base.svid,
    roles: Array.isArray(principal.roles) ? principal.roles : base.roles,
  };
}
