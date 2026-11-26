const REQUIRED_DEPENDENCIES = Object.freeze([
  "V1 Release Program & Cutline",
  "Incident Communications",
  "Support Workflow",
  "V1 Beta Pilot & Feedback Loop",
  "Reliability, Observability & Cost Controls",
  "Operator Agents, SRE & Incident Response",
]);

const SUPPORT_TOOLING_PATTERN =
  /\b(build|implement|wire|automate)\b.*\b(support|ticket|incident)\b.*\b(tooling|tool|automation|queue|portal|console)\b/i;
const UNAPPROVED_SLA_PATTERN =
  /\b(approve|publish|promise|commit|guarantee)\b.*\b(\d+\s*(minute|minutes|min|hour|hours|hr|hrs)|response\s+sla|customer-facing\s+sla)\b/i;

export const HOBO_460_REQUIRED_EVIDENCE = Object.freeze([
  "support-model-record",
  "sev0-sev1-drill",
  "alpha-known-limitation-faq",
  "redaction-communication-sample",
  "debug-access-fixture",
  "cutline-risk-export",
]);

export const launchSupportDogfoodAlphaEvidence = Object.freeze({
  issue: "HOBO-460",
  phase: "M1",
  project: "V1 Launch Support Desk & Escalation",
  milestoneGate: "M1 Dogfood/alpha proof",
  goal:
    "Prove launch support dogfood/alpha evidence is accepted enough to support the v1 release cutline without implementing support tooling.",
  scopeIn: Object.freeze([
    "Record M1 dogfood/alpha support evidence, owners, sources, and accepted limitations.",
    "Map support findings to launch blocker, accepted-risk, launch-note, or post-GA follow-up decisions.",
    "Reflect support dependencies in the release cutline and adjacent launch-readiness lanes.",
    "Create follow-up execution issue records only for missing support evidence.",
    "Update the parent release-readiness initiative only when support evidence changes launch risk.",
  ]),
  scopeOut: Object.freeze([
    "No support tooling implementation, ticket queue automation, helpdesk integration, admin console UI, or status-page publishing workflow.",
    "No customer-facing response SLA or public support guarantee without accepted evidence and business-owner approval.",
    "No live customer data, production support operation, or support staff scheduling.",
  ]),
  evidence: Object.freeze([
    {
      id: "support-model-record",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md",
      proves:
        "M0 launch support severity, responder, communication, and gap-routing matrix is accepted for dogfood/alpha use.",
      acceptanceStatus: "accepted",
    },
    {
      id: "sev0-sev1-drill",
      ownerProject: "Operator Agents, SRE & Incident Response",
      source: "docs/design/launch-support-escalation.md#severity-matrix",
      proves:
        "SEV0 and SEV1 support handoff drills name incident commander, operators/SRE owner, customer communication gate, and evidence source.",
      acceptanceStatus: "accepted",
    },
    {
      id: "alpha-known-limitation-faq",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/support-sla-channels.md#support-channels-and-hours",
      proves:
        "Alpha support FAQ covers support window, unsupported request routing, and known limitation wording before public claim promotion.",
      acceptanceStatus: "missing-follow-up",
      followUpTitle: "Fill Launch Support Desk alpha known-limitation FAQ evidence",
      blocksLaunch: false,
    },
    {
      id: "redaction-communication-sample",
      ownerProject: "Incident Communications",
      source: "docs/design/incident-communications.md",
      proves:
        "Customer-safe incident update sample uses redaction gate and incident evidence before support or status-page publication.",
      acceptanceStatus: "accepted",
    },
    {
      id: "debug-access-fixture",
      ownerProject: "Reliability, Observability & Cost Controls",
      source: "docs/design/launch-support-escalation.md#support-and-debug-prerequisites",
      proves:
        "Support debug access fixture names scoped metrics, logs, traces, tenant context, and evidence boundaries without exposing secrets.",
      acceptanceStatus: "accepted",
    },
    {
      id: "cutline-risk-export",
      ownerProject: "V1 Release Program & Cutline",
      source: "docs/design/launch-blocker-taxonomy.md#source-routing",
      proves:
        "Support findings export into cutline decisions as launch blocker, accepted risk, launch note, or post-GA follow-up.",
      acceptanceStatus: "accepted",
    },
  ]),
  findings: Object.freeze([
    {
      id: "alpha-support-window-limitation",
      sourceEvidenceId: "alpha-known-limitation-faq",
      classification: "accepted-risk",
      ownerProject: "V1 Launch Support Desk & Escalation",
      blocksLaunch: false,
      mitigation:
        "Alpha support window is explicitly limited to business-hours ticket intake plus launch-room escalation for customer-visible incidents.",
      expiry: "private-beta-entry",
    },
    {
      id: "known-limitation-public-wording",
      sourceEvidenceId: "alpha-known-limitation-faq",
      classification: "launch-note",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      blocksLaunch: false,
      mitigation:
        "Release notes must carry the alpha support limitation until the support FAQ evidence is accepted.",
      expiry: "before-ga-handoff",
    },
    {
      id: "helpdesk-integration-deferred",
      sourceEvidenceId: "support-model-record",
      classification: "post-ga-follow-up",
      ownerProject: "Support Workflow",
      blocksLaunch: false,
      mitigation:
        "Manual ticket intake remains allowed for dogfood/alpha; helpdesk automation stays post-GA or later support workflow implementation.",
      expiry: "post-ga-support-tooling-planning",
    },
  ]),
  dependencies: Object.freeze([
    {
      ownerProject: "V1 Release Program & Cutline",
      cutlineRef: "docs/design/launch-blocker-taxonomy.md#source-routing",
      requiredForM1: true,
      consumes: "Support finding classifications and parent initiative risk summary.",
    },
    {
      ownerProject: "Incident Communications",
      cutlineRef: "docs/design/incident-communications.md",
      requiredForM1: true,
      consumes: "Customer-safe message redaction, incident facts, and update handoff evidence.",
    },
    {
      ownerProject: "Support Workflow",
      cutlineRef: "docs/design/support-sla-channels.md",
      requiredForM1: true,
      consumes: "Support channels, unsupported request classes, and SLA language boundary.",
    },
    {
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      cutlineRef: "docs/design/beta-pilot-feedback.md#triage-routes",
      requiredForM1: true,
      consumes: "Beta feedback routed to support as support path or escalation gaps.",
    },
    {
      ownerProject: "Reliability, Observability & Cost Controls",
      cutlineRef: "docs/design/launch-support-escalation.md#support-and-debug-prerequisites",
      requiredForM1: true,
      consumes: "Scoped observability evidence needed by support first responders.",
    },
    {
      ownerProject: "Operator Agents, SRE & Incident Response",
      cutlineRef: "docs/design/operators-sre.md#plan-40",
      requiredForM1: true,
      consumes: "Incident command, runbook, on-call, hobo:notify, and escalation handoff evidence.",
    },
  ]),
});

export function validateLaunchSupportDogfoodAlphaEvidence(record = launchSupportDogfoodAlphaEvidence) {
  const errors: string[] = [];

  if (record?.issue !== "HOBO-460") {
    errors.push("issue must be HOBO-460");
  }
  if (record?.phase !== "M1") {
    errors.push("phase must be M1");
  }
  if (record?.project !== "V1 Launch Support Desk & Escalation") {
    errors.push("project must be V1 Launch Support Desk & Escalation");
  }

  for (const item of record?.scopeIn ?? []) {
    if (SUPPORT_TOOLING_PATTERN.test(item)) {
      errors.push(`support tooling implementation is out of scope: ${item}`);
    }
    if (UNAPPROVED_SLA_PATTERN.test(item)) {
      errors.push(`unapproved customer-facing SLA claim is out of scope: ${item}`);
    }
  }

  const evidenceIds = (record?.evidence ?? []).map((item) => item.id);
  if (JSON.stringify(evidenceIds) !== JSON.stringify(HOBO_460_REQUIRED_EVIDENCE)) {
    errors.push("evidence must match the HOBO-460 required evidence list");
  }

  for (const item of record?.evidence ?? []) {
    for (const field of ["id", "ownerProject", "source", "proves", "acceptanceStatus"] as const) {
      if (!item[field]) {
        errors.push(`evidence ${item.id ?? "<missing>"} must include ${field}`);
      }
    }
    if (item.acceptanceStatus === "missing-follow-up" && !item.followUpTitle) {
      errors.push(`evidence ${item.id} needs a follow-up title`);
    }
  }

  for (const finding of record?.findings ?? []) {
    for (const field of ["id", "sourceEvidenceId", "classification", "ownerProject"] as const) {
      if (!finding[field]) {
        errors.push(`finding ${finding.id ?? "<missing>"} must include ${field}`);
      }
    }
    if (finding.classification === "accepted-risk" && (!finding.mitigation || !finding.expiry)) {
      errors.push(`accepted risk ${finding.id} must include mitigation and expiry`);
    }
  }

  const dependencyOwners = (record?.dependencies ?? []).map((dependency) => dependency.ownerProject);
  if (JSON.stringify(dependencyOwners) !== JSON.stringify(REQUIRED_DEPENDENCIES)) {
    errors.push("dependencies must reflect release cutline and adjacent launch lanes");
  }
  for (const dependency of record?.dependencies ?? []) {
    if (!dependency.cutlineRef || !dependency.requiredForM1) {
      errors.push(`dependency ${dependency.ownerProject ?? "<missing>"} must name cutlineRef and be required for M1`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function deriveSupportFollowUpIssues(record = launchSupportDogfoodAlphaEvidence) {
  return (record?.evidence ?? [])
    .filter((item) => item.acceptanceStatus === "missing-follow-up")
    .map((item) => ({
      title: item.followUpTitle,
      ownerProject: item.ownerProject,
      blocksLaunch: Boolean(item.blocksLaunch),
      sourceEvidenceId: item.id,
    }));
}

export function buildParentInitiativeStatus(record = launchSupportDogfoodAlphaEvidence) {
  const blockers = (record?.findings ?? []).filter((finding) => finding.blocksLaunch);
  if (blockers.length > 0) {
    return {
      health: "atRisk",
      summary: `HOBO-460 M1 support evidence has ${blockers.length} launch blocker${blockers.length === 1 ? "" : "s"}.`,
      changedLaunchRisk: true,
    };
  }

  const followUps = deriveSupportFollowUpIssues(record);
  return {
    health: "onTrack",
    summary:
      followUps.length === 1
        ? "HOBO-460 M1 support evidence is accepted with one non-blocking launch-note follow-up."
        : `HOBO-460 M1 support evidence is accepted with ${followUps.length} non-blocking follow-ups.`,
    changedLaunchRisk: false,
  };
}
