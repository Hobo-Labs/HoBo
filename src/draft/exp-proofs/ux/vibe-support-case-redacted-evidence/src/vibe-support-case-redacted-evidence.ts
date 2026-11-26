export const REQUIRED_SUPPORT_CASE_CONSUMED_MOCKUP_IDS = [
  "wf-received-intake",
  "wf-classified-triage",
  "wf-evidence-linked",
  "wf-owner-routed",
  "wf-customer-updated",
  "wf-closed",
] as const;

export const REQUIRED_SUPPORT_CASE_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_SUPPORT_CASE_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

type SupportCaseConsumedMockupId = (typeof REQUIRED_SUPPORT_CASE_CONSUMED_MOCKUP_IDS)[number];
type SupportCaseProofMode = (typeof REQUIRED_SUPPORT_CASE_PROOF_MODES)[number];
type SupportCaseScenario = (typeof REQUIRED_SUPPORT_CASE_SCENARIOS)[number];
type SupportCaseRedactionState =
  | "customer-safe"
  | "internal-only"
  | "requires-security-approval"
  | "scope-out";

// domain-view: parse-produced draft-proof record; its wire form is the ConsumedSupportWorkflowMockupRef proto message in data-models/.
type ConsumedSupportWorkflowMockupRef = {
  readonly sourceIssue: "HOBO-550";
  readonly mockupId: SupportCaseConsumedMockupId;
  readonly sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md";
  readonly supportCaseUse: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the SupportCaseEvidencePack proto message in data-models/.
export type SupportCaseEvidencePack = {
  readonly id: string;
  readonly supportCaseState: "intake" | "triage" | "evidence-pack" | "owner-route" | "customer-update" | "closure";
  readonly customerSafeSummary: string;
  readonly severity: "SEV0" | "SEV1" | "SEV2" | "SEV3";
  readonly ownerRoute: string;
  readonly consumedMockupIds: readonly SupportCaseConsumedMockupId[];
  readonly redactedLogs: readonly string[];
  readonly incidentRefs: readonly string[];
  readonly supportRefs: readonly string[];
  readonly adminContext: string;
  readonly docsSource: string;
  readonly proofPackageLink: string;
  readonly redactionState: SupportCaseRedactionState;
  readonly nextUpdateCondition: string;
  readonly proofMode: SupportCaseProofMode;
};

export const REQUIRED_SUPPORT_CASE_EVIDENCE_FIELDS = [
  "redactedLogs",
  "incidentRefs",
  "supportRefs",
  "adminContext",
  "docsSource",
  "proofPackageLink",
  "redactionState",
  "nextUpdateCondition",
] as const satisfies readonly (keyof SupportCaseEvidencePack)[];

// domain-view: parse-produced draft-proof record; its wire form is the SupportCaseScenarioPath proto message in data-models/.
type SupportCaseScenarioPath = {
  readonly id: SupportCaseScenario;
  readonly narrative: string;
  readonly evidencePackIds: readonly string[];
  readonly safeOutcome: string;
};

type VibeSupportCaseRedactedEvidence = {
  readonly issue: "HOBO-564";
  readonly phase: "M2";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-support-case-redacted-evidence";
  readonly proofPath: "docs/design/proofs/vibe-support-case-redacted-evidence/README.md";
  readonly designRefs: readonly string[];
  readonly consumedSupportWorkflowMockupRefs: readonly ConsumedSupportWorkflowMockupRef[];
  readonly evidencePacks: readonly SupportCaseEvidencePack[];
  readonly scenarioPaths: readonly SupportCaseScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedSupportCaseRedactedEvidenceBrand: unique symbol;

export type ParsedVibeSupportCaseRedactedEvidence = VibeSupportCaseRedactedEvidence & {
  readonly [parsedSupportCaseRedactedEvidenceBrand]: true;
};

const CONSUMED_MOCKUP_REFS: readonly ConsumedSupportWorkflowMockupRef[] = [
  {
    sourceIssue: "HOBO-550",
    mockupId: "wf-received-intake",
    sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    supportCaseUse: "case prototype starts from accepted requester, channel, affected surface, and first customer-safe summary",
  },
  {
    sourceIssue: "HOBO-550",
    mockupId: "wf-classified-triage",
    sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    supportCaseUse: "severity and owner route are copied from the accepted triage mockup, not inferred from raw ticket text",
  },
  {
    sourceIssue: "HOBO-550",
    mockupId: "wf-evidence-linked",
    sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    supportCaseUse: "redacted logs, incident refs, admin context, docs, and proof package links remain explicit evidence pack fields",
  },
  {
    sourceIssue: "HOBO-550",
    mockupId: "wf-owner-routed",
    sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    supportCaseUse: "support case owner route preserves security, incident, release, docs, and support boundaries",
  },
  {
    sourceIssue: "HOBO-550",
    mockupId: "wf-customer-updated",
    sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    supportCaseUse: "customer update text is gated by redaction state and next update condition",
  },
  {
    sourceIssue: "HOBO-550",
    mockupId: "wf-closed",
    sourceProofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    supportCaseUse: "closure cites approved docs, follow-up owner, or unsupported-state explanation without building support runtime",
  },
];

const EVIDENCE_PACKS: readonly SupportCaseEvidencePack[] = [
  {
    id: "scrp-happy-redacted-doc-answer",
    supportCaseState: "closure",
    customerSafeSummary: "customer-safe support case summary with redacted deploy log lines and approved docs answer",
    severity: "SEV3",
    ownerRoute: "Support Workflow / Docs Portal",
    consumedMockupIds: ["wf-received-intake", "wf-evidence-linked", "wf-customer-updated", "wf-closed"],
    redactedLogs: [
      "log://deploy/run-accepted/redacted-line-17",
      "log://deploy/run-accepted/redacted-line-42",
    ],
    incidentRefs: ["incident://none-customer-impacting-confirmed"],
    supportRefs: ["support://case/sc-happy-doc-answer-v1"],
    adminContext: "workspace acme-prod, project launch-demo, environment preview; tenant ids redacted",
    docsSource: "docs/design/support-workflow.md#required-support-evidence",
    proofPackageLink: "src/draft/exp-proofs/ux/vibe-support-workflow-mockups/README.md",
    redactionState: "customer-safe",
    nextUpdateCondition: "when docs owner approves the final customer-safe answer",
    proofMode: "live",
  },
  {
    id: "scrp-incident-handoff-redacted-context",
    supportCaseState: "owner-route",
    customerSafeSummary: "redacted incident-adjacent context without responder-only notes or raw diagnostic payloads",
    severity: "SEV1",
    ownerRoute: "Incident Communications / Support Workflow",
    consumedMockupIds: ["wf-classified-triage", "wf-owner-routed", "wf-customer-updated"],
    redactedLogs: ["log://incident/candidate/redacted-slo-window"],
    incidentRefs: ["incident://candidate/inc-launch-window-17"],
    supportRefs: ["support://case/sc-incident-handoff-v1"],
    adminContext: "affected launch-demo project and environment only; no customer payloads or secrets",
    docsSource: "docs/design/incident-communications.md#communication-surfaces",
    proofPackageLink: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    redactionState: "internal-only",
    nextUpdateCondition: "after incident commander confirms customer-visible impact and approved wording",
    proofMode: "simulated",
  },
  {
    id: "scrp-stale-proof-limitation-update",
    supportCaseState: "customer-update",
    customerSafeSummary: "customer-safe stale evidence update that points to limitation wording instead of a launch claim",
    severity: "SEV3",
    ownerRoute: "V1 Release Program & Cutline",
    consumedMockupIds: ["wf-evidence-linked", "wf-customer-updated"],
    redactedLogs: ["log://plan-diff/stale-evidence/redacted-fixture-id"],
    incidentRefs: ["incident://not-open-stale-proof"],
    supportRefs: ["support://case/sc-stale-proof-v1"],
    adminContext: "workspace acme-prod, plan review snapshot, freshness state stale; customer identifiers redacted",
    docsSource: "docs/design/known-limitations-register.md",
    proofPackageLink: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md#fixture-ids",
    redactionState: "customer-safe",
    nextUpdateCondition: "once release owner accepts limitation wording or refreshes the proof fixture",
    proofMode: "reference fixture",
  },
  {
    id: "scrp-security-blocked-raw-data-request",
    supportCaseState: "owner-route",
    customerSafeSummary: "customer-safe scope-out raw data request routed without raw disclosure or support impersonation",
    severity: "SEV0",
    ownerRoute: "Security Verification / Legal",
    consumedMockupIds: ["wf-owner-routed", "wf-customer-updated"],
    redactedLogs: ["log://withheld/requires-security-approval"],
    incidentRefs: ["incident://security-review/raw-data-request-withheld"],
    supportRefs: ["support://case/sc-security-blocked-v1"],
    adminContext: "raw tenant data request withheld; support can see route, not payload",
    docsSource: "docs/design/security-verification.md#customer-communication",
    proofPackageLink: "src/draft/exp-proofs/ux/vibe-support-case-redacted-evidence/README.md",
    redactionState: "requires-security-approval",
    nextUpdateCondition: "before any customer-visible evidence leaves security and legal review",
    proofMode: "scope-out",
  },
];

export const VIBE_SUPPORT_CASE_REDACTED_EVIDENCE: VibeSupportCaseRedactedEvidence = {
  issue: "HOBO-564",
  phase: "M2",
  packagePath: "src/draft/exp-proofs/ux/vibe-support-case-redacted-evidence",
  proofPath: "docs/design/proofs/vibe-support-case-redacted-evidence/README.md",
  designRefs: [
    "docs/design/support-workflow.md",
    "docs/design/support-sla-channels.md",
    "docs/design/incident-communications.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/proofs/vibe-support-workflow-mockups/README.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  consumedSupportWorkflowMockupRefs: CONSUMED_MOCKUP_REFS,
  evidencePacks: EVIDENCE_PACKS,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "A customer-safe support case links redacted deploy logs, approved docs, support references, and proof evidence before closure.",
      evidencePackIds: ["scrp-happy-redacted-doc-answer"],
      safeOutcome: "customer receives approved docs answer and redacted proof references without raw evidence exposure",
    },
    {
      id: "blocked-path",
      narrative: "A raw customer-data request is routed to security/legal and remains scope-out until approval exists.",
      evidencePackIds: ["scrp-security-blocked-raw-data-request"],
      safeOutcome: "support records the owner route and next update condition instead of granting data access",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "A stale proof fixture produces limitation wording and a refresh owner instead of an unsupported readiness claim.",
      evidencePackIds: ["scrp-stale-proof-limitation-update"],
      safeOutcome: "support states stale evidence and routes refresh work before claiming launch readiness",
    },
    {
      id: "support-handoff",
      narrative: "Incident-adjacent context is handed to Incident Communications with redacted support references and customer-safe boundaries.",
      evidencePackIds: ["scrp-incident-handoff-redacted-context"],
      safeOutcome: "support handoff preserves incident owner routing, redaction state, and next customer update condition",
    },
  ],
  accessibilityNotes: [
    "Keyboard order moves from case summary to severity, redaction state, evidence pack, owner route, and next update condition.",
    "Screen reader labels announce proof mode, redaction state, owner route, and whether evidence is customer-safe or internal-only.",
    "Contrast is paired with text labels for blocked, stale, internal-only, and scope-out evidence pack states.",
    "Motion is optional; evidence pack expansion, route changes, and status transitions must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No helpdesk integration or support queue automation.",
    "No customer-data access, support impersonation, tenant browsing, or secret exposure.",
    "No incident command ownership, runbook execution, on-call staffing, or notification dispatch.",
    "No production support UI or support portal implementation.",
    "No contractual SLA promise, paid support term, or public response-time guarantee.",
    "No launch claim without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(helpdesk|ticket|support queue|queue assignment|queue automation)\b/i,
  /\b(customer[- ]data access|raw customer data|tenant browsing|support impersonation|secret access)\b/i,
  /\b(incident command|runbook execution|notification dispatch)\b/i,
  /\b(on-call staffing|oncall staffing|on-call schedule)\b/i,
  /\b(production support ui|support portal|production ui)\b/i,
  /\b(contractual sla|response-time guarantee|paid support term|promise.*sla)\b/i,
  /\b(launch claim|launch readiness).*\bwithout evidence\b/i,
];

export type SupportCasePrototypeRequestClassification = "in-scope-proof" | "scope-out";

export class VibeSupportCaseRedactedEvidenceParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe support case redacted evidence failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibeSupportCaseRedactedEvidenceParseError";
  }
}

export function parseVibeSupportCaseRedactedEvidence(
  record: VibeSupportCaseRedactedEvidence,
): ParsedVibeSupportCaseRedactedEvidence {
  const validation = validateVibeSupportCaseRedactedEvidence(record);

  if (!validation.ok) {
    throw new VibeSupportCaseRedactedEvidenceParseError(validation.errors);
  }

  // SAFETY: `return record as ParsedVibeSupportCaseRedactedEvidence;` is required at this I/O or test boundary.
  return record as ParsedVibeSupportCaseRedactedEvidence;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeSupportCaseRedactedEvidence(
  record: VibeSupportCaseRedactedEvidence,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (record.issue !== "HOBO-564") {
    errors.push({ code: "wrong-issue", message: "support case prototype must pin HOBO-564" });
  }
  if (record.phase !== "M2") {
    errors.push({ code: "wrong-phase", message: "support case prototype must stay in M2" });
  }
  if (record.packagePath !== "src/draft/exp-proofs/ux/vibe-support-case-redacted-evidence") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (record.proofPath !== "docs/design/proofs/vibe-support-case-redacted-evidence/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }

  validateConsumedMockups(record.consumedSupportWorkflowMockupRefs, errors);
  validateEvidencePacks(record.evidencePacks, errors);
  validateScenarioPaths(record.scenarioPaths, record.evidencePacks, errors);
  validateAccessibilityNotes(record.accessibilityNotes, errors);

  if (record.scopeOut.length === 0) {
    errors.push({ code: "missing-scope-out", message: "scope-out register must be explicit" });
  }

  return { ok: errors.length === 0, errors };
}

export function classifySupportCasePrototypeRequest(
  summary: string,
): SupportCasePrototypeRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateConsumedMockups(
  refs: readonly ConsumedSupportWorkflowMockupRef[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(refs.map((ref) => ref.mockupId), REQUIRED_SUPPORT_CASE_CONSUMED_MOCKUP_IDS)) {
    errors.push({
      code: "missing-consumed-mockup",
      message: "support case prototype must consume every accepted HOBO-550 support workflow mockup",
    });
  }

  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-550") {
      errors.push({ code: "wrong-mockup-source", message: `${ref.mockupId} must cite HOBO-550` });
    }
    if (ref.sourceProofPath !== "docs/design/proofs/vibe-support-workflow-mockups/README.md") {
      errors.push({ code: "wrong-mockup-proof", message: `${ref.mockupId} must cite the HOBO-550 proof path` });
    }
    if (!ref.supportCaseUse) {
      errors.push({ code: "missing-mockup-use", message: `${ref.mockupId} must describe support case consumption` });
    }
  }
}

function validateEvidencePacks(
  packs: readonly SupportCaseEvidencePack[],
  errors: ValidationError[],
): void {
  const proofModes = new Set<SupportCaseProofMode>();
  const consumedMockupIds = new Set<SupportCaseConsumedMockupId>(REQUIRED_SUPPORT_CASE_CONSUMED_MOCKUP_IDS);

  for (const pack of packs) {
    for (const field of REQUIRED_SUPPORT_CASE_EVIDENCE_FIELDS) {
      const value = pack[field];
      if (Array.isArray(value) ? value.length === 0 : !value) {
        errors.push({ code: "missing-evidence-field", message: `${pack.id} must include ${String(field)}` });
      }
    }
    if (!pack.customerSafeSummary || !pack.ownerRoute || pack.consumedMockupIds.length === 0) {
      errors.push({ code: "incomplete-evidence-pack", message: `${pack.id} must name summary, owner, and mockup refs` });
    }
    for (const mockupId of pack.consumedMockupIds) {
      if (!consumedMockupIds.has(mockupId)) {
        errors.push({ code: "unknown-consumed-mockup", message: `${pack.id} references ${mockupId}` });
      }
    }
    if (!REQUIRED_SUPPORT_CASE_PROOF_MODES.includes(pack.proofMode)) {
      errors.push({ code: "unsupported-proof-mode", message: `${pack.id} uses unsupported proof mode ${String(pack.proofMode)}` });
    } else {
      proofModes.add(pack.proofMode);
    }
  }

  if (!arraysEqual([...proofModes], REQUIRED_SUPPORT_CASE_PROOF_MODES)) {
    errors.push({
      code: "missing-proof-mode-label",
      message: "evidence packs must cover live, simulated, reference fixture, and scope-out proof modes",
    });
  }
}

function validateScenarioPaths(
  scenarios: readonly SupportCaseScenarioPath[],
  packs: readonly SupportCaseEvidencePack[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(scenarios.map((scenario) => scenario.id), REQUIRED_SUPPORT_CASE_SCENARIOS)) {
    errors.push({
      code: "missing-scenario-path",
      message: "support case scenarios must cover happy, blocked, stale/unknown, and support handoff paths",
    });
  }

  const packIds = new Set(packs.map((pack) => pack.id));
  for (const scenario of scenarios) {
    if (!scenario.narrative || scenario.evidencePackIds.length === 0 || !scenario.safeOutcome) {
      errors.push({ code: "incomplete-scenario", message: `${scenario.id} must name narrative, packs, and outcome` });
    }
    for (const packId of scenario.evidencePackIds) {
      if (!packIds.has(packId)) {
        errors.push({ code: "unknown-scenario-pack", message: `${scenario.id} references missing pack ${packId}` });
      }
    }
  }
}

function validateAccessibilityNotes(notes: readonly string[], errors: ValidationError[]): void {
  const text = notes.join(" ").toLowerCase();

  for (const requiredNote of ["keyboard", "screen reader", "contrast", "motion"]) {
    if (!text.includes(requiredNote)) {
      errors.push({ code: "missing-accessibility-note", message: `accessibility notes must include ${requiredNote}` });
    }
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
