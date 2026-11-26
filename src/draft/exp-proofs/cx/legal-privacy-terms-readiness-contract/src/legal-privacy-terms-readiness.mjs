const REQUIRED_DOMAINS = [
  "terms",
  "privacy-notice",
  "data-retention",
  "telemetry",
  "subprocessors-provider-claims",
  "security-claims",
  "support-obligations",
  "customer-communications",
];

const REQUIRED_DEPENDENCIES = [
  "docs/design/security-networking.md#plan-12",
  "docs/design/governance-planes.md#plan-46",
  "docs/design/adr/02-identity-security.md#adr-0023",
  "docs/design/adr/02-identity-security.md#adr-0060",
  "docs/design/adr/02-identity-security.md#adr-0074",
  "docs/design/adr/07-portability-extensibility.md#adr-0064",
];

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const VALID_UNKNOWN_DISPOSITIONS = new Set(["blocker", "post-v1"]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /draft final .*terms/i,
  /draft final .*privacy/i,
  /publish legal terms/i,
  /public compliance claim/i,
  /soc2 certified/i,
];

export const LEGAL_PRIVACY_TERMS_READINESS = {
  issue: "HOBO-405",
  project: "V1 Legal, Privacy & Terms Readiness",
  phase: "M0",
  goal:
    "Define the launch-facing legal, privacy, terms, support, and communications checklist without drafting final legal text or making unsupported public claims.",
  scopeIn: [
    "A launch checklist for terms, privacy notice, data handling, telemetry, subprocessors/provider claims, security claims, support obligations, and customer communications.",
    "Owner, owning project, evidence source, support action, audit evidence, customer-facing message, and entitlement impact per checklist item.",
    "Open legal/privacy unknowns classified as release blockers or explicit post-v1 follow-ups.",
    "References to HoBo security, compliance/data governance, organizational governance, and meta-cloud scope records.",
  ],
  scopeOut: [
    "Do not draft final customer terms or legal policy text.",
    "Do not publish compliance, security, privacy, or provider claims without evidence.",
    "Do not implement a legal workflow, contract lifecycle system, billing policy, or support-desk product.",
    "Do not create downstream M1-M4 issues until this M0 checklist is accepted.",
  ],
  checklist: [
    {
      domain: "terms",
      title: "Terms launch posture",
      owner: "legal owner",
      owningProject: "V1 Legal, Privacy & Terms Readiness",
      status: "blocker-input-required",
      evidenceSource: "legal owner approval plus release cutline signoff",
      customerVisibleMessage:
        "Terms are pending final legal approval; do not publish final terms from this M0 record.",
      supportAction: "Route terms questions to legal owner and release owner.",
      auditEvidence: "signed launch checklist row and approval reference",
      entitlementImpact: "Blocks paid or public launch if final legal approval is absent.",
    },
    {
      domain: "privacy-notice",
      title: "Privacy notice and data-handling posture",
      owner: "privacy owner",
      owningProject: "V1 Legal, Privacy & Terms Readiness",
      status: "blocker-input-required",
      evidenceSource: "privacy review over telemetry, retention, subprocessors, and support access",
      customerVisibleMessage:
        "Privacy notice must describe what HoBo collects, retains, exports, and shares before launch.",
      supportAction: "Escalate data-handling questions to privacy owner.",
      auditEvidence: "privacy review reference and data map link",
      entitlementImpact: "Blocks launch for workflows that collect production customer data.",
    },
    {
      domain: "data-retention",
      title: "Retention and erasure obligations",
      owner: "governance owner",
      owningProject: "Compliance Evidence Pack",
      status: "needs-evidence",
      evidenceSource: "Plan 46 classification, retention, erasure, and OCSF attestation model",
      customerVisibleMessage:
        "Retention commitments must distinguish product data, audit streams, telemetry, and support artifacts.",
      supportAction: "Route retention exceptions to governance owner.",
      auditEvidence: "retention matrix and exported attestation evidence",
      entitlementImpact: "Controls whether customer data can enter beta or GA environments.",
    },
    {
      domain: "telemetry",
      title: "Telemetry and opt-out posture",
      owner: "product analytics owner",
      owningProject: "Workspace & Onboarding UX",
      status: "needs-evidence",
      evidenceSource: "workspace activation metrics and privacy-safe telemetry contract",
      customerVisibleMessage:
        "Telemetry must state purpose, PII exclusions, retention, opt-out behavior, and support/debug use.",
      supportAction: "Route telemetry opt-out and deletion requests to support owner.",
      auditEvidence: "event catalog, retention policy, and opt-out handling evidence",
      entitlementImpact: "Beta telemetry can proceed only inside the reviewed privacy boundary.",
    },
    {
      domain: "subprocessors-provider-claims",
      title: "Subprocessors and provider claim boundaries",
      owner: "vendor owner",
      owningProject: "Compliance Evidence Pack",
      status: "blocker-input-required",
      evidenceSource: "confirmed subprocessor/provider list and provider claim evidence",
      customerVisibleMessage:
        "Provider and subprocessor statements must distinguish required, optional, mocked, and unsupported services.",
      supportAction: "Escalate customer assurance requests to vendor owner.",
      auditEvidence: "subprocessor list, provider claim register, and known limitations",
      entitlementImpact: "Blocks enterprise pilot commitments if required subprocessors are unconfirmed.",
    },
    {
      domain: "security-claims",
      title: "Security claim evidence",
      owner: "security owner",
      owningProject: "Security Verification",
      status: "needs-evidence",
      evidenceSource: "security posture commitments, vulnerability process, SBOM/provenance, and launch-blocker gates",
      customerVisibleMessage:
        "Security claims must name implemented, simulated/reference, beta-only, and future-roadmap evidence.",
      supportAction: "Remove or downgrade unsupported public security claims.",
      auditEvidence: "claim register row plus linked verification evidence",
      entitlementImpact: "Unsupported security claims cannot unlock customer-facing launch copy.",
      claimType: "evidence-backed-security-claim",
    },
    {
      domain: "support-obligations",
      title: "Support and customer communication obligations",
      owner: "support owner",
      owningProject: "Support & Debug Tools",
      status: "needs-evidence",
      evidenceSource: "support intake, severity, escalation, and debug evidence contract",
      customerVisibleMessage:
        "Support expectations must state response path, evidence needed, known limitations, and escalation triggers.",
      supportAction: "Route incidents through support intake with launch-blocker escalation.",
      auditEvidence: "support runbook, severity table, and handoff evidence",
      entitlementImpact: "Defines beta and GA support boundaries without promising unowned SLAs.",
    },
    {
      domain: "customer-communications",
      title: "Customer communications and release notices",
      owner: "launch communications owner",
      owningProject: "V1 Launch Site, Messaging & Demo Assets",
      status: "needs-evidence",
      evidenceSource: "launch messaging claim register and release notes",
      customerVisibleMessage:
        "Customer-facing communications must align with evidence, known limitations, support boundaries, and release cutline.",
      supportAction: "Route unsupported or risky claims back to launch communications owner.",
      auditEvidence: "claim register, release notes, and approval references",
      entitlementImpact: "Controls which claims can appear in beta, GA, docs, and demo assets.",
    },
  ],
  unknowns: [
    {
      id: "final-legal-review",
      question: "Who signs final terms, privacy notice, and customer-facing legal copy?",
      disposition: "blocker",
      owner: "legal owner",
      requiredBefore: "public launch or paid GA",
    },
    {
      id: "subprocessor-list-confirmation",
      question: "Which providers, telemetry services, support tools, and model vendors are subprocessors in v1?",
      disposition: "blocker",
      owner: "vendor owner",
      requiredBefore: "enterprise beta or GA customer assurance packet",
    },
    {
      id: "security-claim-evidence-review",
      question: "Which security claims have branch, CI, SBOM, provenance, or audit evidence behind them?",
      disposition: "blocker",
      owner: "security owner",
      requiredBefore: "public security or compliance claims",
    },
    {
      id: "localized-terms",
      question: "Which localized terms, translations, or jurisdiction-specific notices are needed after v1?",
      disposition: "post-v1",
      owner: "legal owner",
      requiredBefore: "post-v1 expansion",
    },
    {
      id: "formal-compliance-certification",
      question: "When does HoBo pursue formal SOC2 or similar certification beyond evidence export?",
      disposition: "post-v1",
      owner: "compliance owner",
      requiredBefore: "future certification program",
    },
  ],
  dependencies: REQUIRED_DEPENDENCIES.map((source) => ({
    source,
    reason: dependencyReason(source),
  })),
  followUpGate: {
    allowedAfter: "HOBO-405 M0 checklist accepted",
    blockedBefore:
      "M1-M4 legal, privacy, support, communications, or evidence work must not fan out before this checklist is accepted.",
  },
};

export function canCreateLaunchFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function classifyUnknowns(record) {
  return {
    blockers: (record.unknowns ?? [])
      .filter((unknown) => unknown.disposition === "blocker")
      .map((unknown) => unknown.id),
    postV1: (record.unknowns ?? [])
      .filter((unknown) => unknown.disposition === "post-v1")
      .map((unknown) => unknown.id),
  };
}

export function validateLaunchChecklist(record) {
  const errors = [];

  if (record.issue !== "HOBO-405") {
    errors.push("issue must be HOBO-405");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
    const creepingEntry = [...(record.scopeIn ?? []), ...(record.checklist ?? []).map((item) => item.customerVisibleMessage ?? "")]
      .find((entry) => pattern.test(entry));
    if (creepingEntry) {
      errors.push(`scope creep: ${creepingEntry}`);
    }
  }

  const domains = (record.checklist ?? []).map((item) => item.domain);
  for (const domain of REQUIRED_DOMAINS) {
    if (!domains.includes(domain)) {
      errors.push(`missing checklist domain ${domain}`);
    }
  }

  for (const item of record.checklist ?? []) {
    if (!item.owner || !item.owningProject) {
      errors.push(`${item.domain ?? "<unknown>"} must name owner and owning project`);
    }
    if (!item.evidenceSource) {
      errors.push(`${item.domain ?? "<unknown>"} must name evidence source`);
    }
    if (!item.customerVisibleMessage) {
      errors.push(`${item.domain ?? "<unknown>"} must name customer-visible message`);
    }
    if (!item.supportAction) {
      errors.push(`${item.domain ?? "<unknown>"} must name support action`);
    }
    if (!item.auditEvidence) {
      errors.push(`${item.domain ?? "<unknown>"} must name audit evidence`);
    }
    if (!item.entitlementImpact) {
      errors.push(`${item.domain ?? "<unknown>"} must name entitlement impact`);
    }
    if (item.claimType === "public-compliance-claim" && !item.evidenceSource) {
      errors.push("public compliance claim requires evidence");
    }
  }

  for (const unknown of record.unknowns ?? []) {
    if (!VALID_UNKNOWN_DISPOSITIONS.has(unknown.disposition)) {
      errors.push(`unknown ${unknown.id ?? "<unknown>"} must be blocker or post-v1`);
    }
    if (!unknown.owner || !unknown.requiredBefore) {
      errors.push(`unknown ${unknown.id ?? "<unknown>"} must name owner and required-before`);
    }
  }

  const sources = new Set((record.dependencies ?? []).map((dependency) => dependency.source));
  for (const source of REQUIRED_DEPENDENCIES) {
    if (!sources.has(source)) {
      errors.push(`missing dependency ${source}`);
    }
  }

  if (!record.followUpGate?.allowedAfter || !record.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function dependencyReason(source) {
  if (source.includes("security-networking.md")) {
    return "Security posture, audit/compliance, subprocessors/provider claim evidence, and supportable security boundaries.";
  }
  if (source.includes("governance-planes.md")) {
    return "Compliance/data governance, retention, erasure, attestation export, and AI-safety evidence boundaries.";
  }
  if (source.includes("adr-0023")) {
    return "Security claims must trace to verifiable security posture commitments.";
  }
  if (source.includes("adr-0060")) {
    return "Compliance/data governance exports facts but does not create a legal certification program.";
  }
  if (source.includes("adr-0074")) {
    return "Organizational governance owns RBAC and mandatory policy rules for control-plane actions.";
  }
  return "ADR-0064 keeps business/legal/commercial products outside the HoBo meta-cloud implementation scope.";
}
