import { isJsonBoolean, isJsonObject } from "./json.js";
export const LAUNCH_DECISION_CLASSES = [
  "launch-blocker",
  "high-risk-non-blocker",
  "launch-note",
  "post-ga-follow-up"
];

export const FINDING_SOURCES = [
  "dogfood",
  "beta",
  "support",
  "security",
  "legal-privacy",
  "upgrade"
];

export const REQUIRED_GATES = ["ci", "review", "security", "contract-tests"];

export const launchBlockerTaxonomy = {
  schema: "hobo.launch-blocker-taxonomy/2026-06-29",
  issue: "HOBO-402",
  project: "V1 Release Program & Cutline",
  phase: "M0",
  severityTaxonomy: [
    {
      id: "launch-blocker",
      label: "Launch blocker",
      mayShip: false,
      goNoGoAction: "no-go",
      definition:
        "A finding that invalidates a required gate, creates unresolved customer harm, or lacks an accepted mitigation for beta or GA.",
      requiredEvidence: ["finding record", "affected launch surface", "owner", "required gate or customer impact"],
      exitCriteria: ["gate passes", "owner accepts downgrade with evidence", "work is removed from the launch scope"]
    },
    {
      id: "high-risk-non-blocker",
      label: "High-risk non-blocker",
      mayShip: true,
      goNoGoAction: "conditional-go",
      definition:
        "A serious but bounded risk with mitigation, rollback or pause path, explicit owner, expiry, and release-owner approval.",
      requiredEvidence: ["finding record", "risk impact", "mitigation", "rollback or pause path", "approval"],
      exitCriteria: ["risk expires", "mitigation is proven", "risk is promoted to launch blocker if evidence regresses"]
    },
    {
      id: "launch-note",
      label: "Launch note",
      mayShip: true,
      goNoGoAction: "go-with-note",
      definition:
        "A customer-visible limitation or support caveat that is understood, documented, and does not invalidate required gates.",
      requiredEvidence: ["customer-visible wording", "support owner", "known limitation text"],
      exitCriteria: ["release note is published", "support path is available"]
    },
    {
      id: "post-ga-follow-up",
      label: "Post-GA follow-up",
      mayShip: true,
      goNoGoAction: "go",
      definition:
        "A non-blocking improvement or cleanup that does not change beta or GA readiness and can be scheduled after launch.",
      requiredEvidence: ["follow-up owner", "non-blocking rationale"],
      exitCriteria: ["tracked after launch", "excluded from go/no-go status"]
    }
  ],
  exceptionProcess: {
    allowedDecisionClasses: ["high-risk-non-blocker", "launch-note", "post-ga-follow-up"],
    forbiddenDecisionClasses: ["launch-blocker"],
    requiredEvidenceFields: ["findingRecord", "impact", "mitigation", "expiry"],
    approverRoles: ["release-owner", "security-owner", "legal-privacy-owner", "support-owner"],
    cannotOverrideGates: REQUIRED_GATES
  },
  requiredGates: REQUIRED_GATES,
  sourceRouting: [
    {
      source: "dogfood",
      decisionInputs: ["reproducibility", "scope of affected dogfood yard", "rollback or pause path"],
      defaultOwner: "V1 Dogfood Yard & Hosted Operations"
    },
    {
      source: "beta",
      decisionInputs: ["pilot cohort impact", "feedback severity", "customer-visible limitation"],
      defaultOwner: "V1 Beta Pilot & Feedback Loop"
    },
    {
      source: "support",
      decisionInputs: ["supportability", "escalation path", "customer communication"],
      defaultOwner: "V1 Launch Support Desk & Escalation"
    },
    {
      source: "security",
      decisionInputs: ["required security gate", "exploitability", "tenant or credential exposure"],
      defaultOwner: "Threat Model & Security Review"
    },
    {
      source: "legal-privacy",
      decisionInputs: ["legal approval", "privacy or data-class impact", "unsupported jurisdiction"],
      defaultOwner: "V1 Legal, Privacy & Terms Readiness"
    },
    {
      source: "upgrade",
      decisionInputs: ["rollback evidence", "migration dry-run", "release-note impact"],
      defaultOwner: "Upgrade & Migration Engine"
    }
  ],
  exampleTriageCases: [
    {
      id: "security-required-gate-fails",
      source: "security",
      decisionClass: "launch-blocker",
      finding: "Credential exposure remains open in the release candidate.",
      evidence: ["security gate failing", "no mitigation accepted"],
      action: "no-go until gate passes or scope is removed"
    },
    {
      id: "dogfood-latency-with-pause",
      source: "dogfood",
      decisionClass: "high-risk-non-blocker",
      finding: "Dogfood p95 deploy latency misses the beta target but has no correctness or data-loss impact.",
      evidence: ["dogfood yard telemetry", "support owner", "rollback or pause path"],
      action: "conditional-go with release-owner approval and expiry"
    },
    {
      id: "support-known-limitation",
      source: "support",
      decisionClass: "launch-note",
      finding: "Support must document that self-host bootstrap logs are retained for the release-support window only.",
      evidence: ["customer-visible wording", "support handoff owner"],
      action: "go with release-note and support text"
    },
    {
      id: "upgrade-cleanup-after-ga",
      source: "upgrade",
      decisionClass: "post-ga-follow-up",
      finding: "Migration dry-run output could include a richer diff after GA.",
      evidence: ["non-blocking rationale", "follow-up owner"],
      action: "track after GA without changing go/no-go"
    },
    {
      id: "beta-feedback-caveat",
      source: "beta",
      decisionClass: "launch-note",
      finding: "Pilot users need a clear caveat for unsupported mobile editing.",
      evidence: ["pilot feedback", "known limitation text"],
      action: "go with customer-visible caveat"
    },
    {
      id: "legal-privacy-unsupported-region",
      source: "legal-privacy",
      decisionClass: "high-risk-non-blocker",
      finding: "A region is unsupported for beta but the launch scope excludes that jurisdiction.",
      evidence: ["legal owner approval", "scope exclusion", "expiry"],
      action: "conditional-go for supported jurisdictions only"
    }
  ],
  scopeGuards: {
    resolvesBlockers: false,
    overridesRequiredGates: [],
    createsMergeBypass: false,
    implementsRuntimePolicy: false
  }
};

export function validateLaunchBlockerTaxonomy(contract) {
  const errors = [];

  if (!contract || !isJsonObject(contract)) {
    return { ok: false, errors: ["launch blocker taxonomy record is required"] };
  }

  if (contract.issue !== "HOBO-402") {
    errors.push("issue must be HOBO-402");
  }
  if (contract.phase !== "M0") {
    errors.push("phase must be M0");
  }

  const classIds = (contract.severityTaxonomy ?? []).map((entry) => entry.id);
  if (JSON.stringify(classIds) !== JSON.stringify(LAUNCH_DECISION_CLASSES)) {
    errors.push("severity taxonomy must define the four launch decision classes in order");
  }

  for (const entry of contract.severityTaxonomy ?? []) {
    if (!entry.label || !entry.definition || !entry.goNoGoAction || !isJsonBoolean(entry.mayShip)) {
      errors.push(`${entry.id ?? "<missing>"} must define label, definition, goNoGoAction, and mayShip`);
    }
    if (!Array.isArray(entry.requiredEvidence) || entry.requiredEvidence.length === 0) {
      errors.push(`${entry.id ?? "<missing>"} must name required evidence`);
    }
    if (!Array.isArray(entry.exitCriteria) || entry.exitCriteria.length === 0) {
      errors.push(`${entry.id ?? "<missing>"} must name exit criteria`);
    }
  }

  for (const gate of REQUIRED_GATES) {
    if (!(contract.requiredGates ?? []).includes(gate)) {
      errors.push(`required gates must include ${gate}`);
    }
  }

  validateExceptionProcess(contract.exceptionProcess, errors);
  validateSourceRouting(contract.sourceRouting, errors);
  validateExamples(contract.exampleTriageCases, errors);

  if (contract.scopeGuards?.resolvesBlockers) {
    errors.push("HOBO-402 does not resolve blockers");
  }
  if ((contract.scopeGuards?.overridesRequiredGates ?? []).length > 0) {
    errors.push("HOBO-402 must not override required gates");
  }
  if (contract.scopeGuards?.createsMergeBypass) {
    errors.push("HOBO-402 must not create merge or review bypasses");
  }
  if (contract.scopeGuards?.implementsRuntimePolicy) {
    errors.push("HOBO-402 must not implement runtime policy enforcement");
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchBlockerTaxonomy(contract = launchBlockerTaxonomy) {
  const result = validateLaunchBlockerTaxonomy(contract);

  if (!result.ok) {
    throw new Error(`launch blocker taxonomy invalid:\n${result.errors.join("\n")}`);
  }

  return contract;
}

export function validateExceptionRequest(request, contract = launchBlockerTaxonomy) {
  const errors = [];
  const process = contract.exceptionProcess;

  if (!process.allowedDecisionClasses.includes(request?.decisionClass)) {
    errors.push(`${request?.decisionClass ?? "<missing>"} cannot use the exception process`);
  }
  if (process.forbiddenDecisionClasses.includes(request?.decisionClass)) {
    errors.push("launch blockers cannot be waived by exception");
  }
  if (!process.approverRoles.includes(request?.approverRole)) {
    errors.push(`${request?.approverRole ?? "<missing>"} is not an approved exception role`);
  }

  for (const field of process.requiredEvidenceFields) {
    if (!hasValue(request?.evidence?.[field])) {
      errors.push(`exception evidence requires ${field}`);
    }
  }

  for (const gate of request?.gateOverrides ?? []) {
    if (process.cannotOverrideGates.includes(gate)) {
      errors.push(`${gate} gate cannot be overridden`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyLaunchFinding(finding, contract = launchBlockerTaxonomy) {
  const sourceRoute = contract.sourceRouting.find((route) => route.source === finding?.source);
  const decisionClass = classifyDecisionClass(finding, contract);
  const decision = contract.severityTaxonomy.find((entry) => entry.id === decisionClass);

  return {
    source: sourceRoute?.source ?? finding?.source ?? "unknown",
    decisionClass,
    goNoGoAction: decision.goNoGoAction,
    ownerProject: sourceRoute?.defaultOwner ?? contract.project,
    requiredEvidence: decision.requiredEvidence
  };
}

function classifyDecisionClass(finding, contract) {
  if (finding?.requiredGate && REQUIRED_GATES.includes(finding.requiredGate) && finding.gateStatus === "failing") {
    return "launch-blocker";
  }
  if (finding?.customerImpact && !finding?.mitigationReady) {
    return "launch-blocker";
  }
  if (finding?.source === "legal-privacy" && finding?.legalApproval === false) {
    return "launch-blocker";
  }
  if (finding?.customerVisibleLimitation && finding?.mitigationReady && finding?.ownerAcceptedRisk) {
    return "launch-note";
  }
  if (finding?.mitigationReady && finding?.ownerAcceptedRisk) {
    return "high-risk-non-blocker";
  }
  if (finding?.customerVisibleLimitation) {
    return "launch-note";
  }

  return contract.severityTaxonomy.some((entry) => entry.id === "post-ga-follow-up")
    ? "post-ga-follow-up"
    : "launch-blocker";
}

function validateExceptionProcess(process, errors) {
  if (!process) {
    errors.push("exception process is required");
    return;
  }

  for (const decisionClass of ["high-risk-non-blocker", "launch-note", "post-ga-follow-up"]) {
    if (!process.allowedDecisionClasses?.includes(decisionClass)) {
      errors.push(`exception process must allow ${decisionClass}`);
    }
  }
  if (!process.forbiddenDecisionClasses?.includes("launch-blocker")) {
    errors.push("exception process must forbid launch-blocker waivers");
  }
  for (const field of ["findingRecord", "impact", "mitigation", "expiry"]) {
    if (!process.requiredEvidenceFields?.includes(field)) {
      errors.push(`exception process must require ${field}`);
    }
  }
  if (!process.approverRoles?.includes("release-owner")) {
    errors.push("exception process must name release-owner as an approver role");
  }
  for (const gate of REQUIRED_GATES) {
    if (!process.cannotOverrideGates?.includes(gate)) {
      errors.push(`exception process must not override ${gate}`);
    }
  }
}

function validateSourceRouting(routes, errors) {
  const sources = (routes ?? []).map((route) => route.source);
  if (JSON.stringify(sources) !== JSON.stringify(FINDING_SOURCES)) {
    errors.push("source routing must cover dogfood, beta, support, security, legal/privacy, and upgrade in order");
  }

  for (const route of routes ?? []) {
    if (!route.defaultOwner) {
      errors.push(`${route.source ?? "<missing>"} must name a default owner`);
    }
    if (!Array.isArray(route.decisionInputs) || route.decisionInputs.length === 0) {
      errors.push(`${route.source ?? "<missing>"} must feed decision inputs into go/no-go`);
    }
  }
}

function validateExamples(examples, errors) {
  const classes = new Set((examples ?? []).map((example) => example.decisionClass));
  const sources = new Set((examples ?? []).map((example) => example.source));

  for (const decisionClass of LAUNCH_DECISION_CLASSES) {
    if (!classes.has(decisionClass)) {
      errors.push(`example triage cases must cover ${decisionClass}`);
    }
  }
  for (const source of FINDING_SOURCES) {
    if (!sources.has(source)) {
      errors.push(`example triage cases must cover ${source}`);
    }
  }
  for (const example of examples ?? []) {
    if (!example.finding || !example.action || !Array.isArray(example.evidence) || example.evidence.length === 0) {
      errors.push(`${example.id ?? "<missing>"} must include finding, evidence, and action`);
    }
  }
}

function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && isJsonObject(value)) {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null && value !== "";
}
