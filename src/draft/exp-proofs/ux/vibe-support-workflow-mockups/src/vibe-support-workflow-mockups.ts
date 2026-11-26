export const REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS = [
  "support lead",
  "support operator",
  "customer admin",
  "incident commander",
  "release owner",
  "security/compliance reviewer",
] as const;

export const REQUIRED_SUPPORT_WORKFLOW_MOCKUP_STATES = [
  "received",
  "classified",
  "evidence-linked",
  "owner-routed",
  "customer-updated",
  "closed",
] as const;

export const REQUIRED_SUPPORT_WORKFLOW_MOCKUP_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_FIXTURE_IDS = [
  "rlq-deploy-run-accepted-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-snapshot-restore-v1",
  "rlq-recover-scope-out-v1",
] as const;

export const REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_PROOF_MODES = [
  "reference-fixture",
  "simulated",
  "live",
  "scope-out",
] as const;

type SupportWorkflowMockupPersona = (typeof REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS)[number];
type SupportWorkflowMockupState = (typeof REQUIRED_SUPPORT_WORKFLOW_MOCKUP_STATES)[number];
type SupportWorkflowMockupScenario = (typeof REQUIRED_SUPPORT_WORKFLOW_MOCKUP_SCENARIOS)[number];
type SupportWorkflowMockupProofMode = (typeof REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PROOF_MODES)[number];
type SupportWorkflowQuickstartFixtureId = (typeof REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_FIXTURE_IDS)[number];
type SupportWorkflowQuickstartProofMode = (typeof REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_PROOF_MODES)[number];

type RedactionState = "customer-safe" | "internal-only" | "requires-security-approval" | "scope-out";

type SupportWorkflowMockup = {
  readonly id: string;
  readonly state: SupportWorkflowMockupState;
  readonly title: string;
  readonly personas: readonly SupportWorkflowMockupPersona[];
  readonly questionsAnswered: readonly string[];
  readonly fixtureIds: readonly string[];
};

export type SupportWorkflowFixture = {
  readonly id: string;
  readonly requester: string;
  readonly customerSafeSummary: string;
  readonly severity: "SEV0" | "SEV1" | "SEV2" | "SEV3";
  readonly affectedSurface: string;
  readonly ownerRoute: string;
  readonly evidenceLinks: readonly string[];
  readonly redactionState: RedactionState;
  readonly nextUpdateCondition: string;
  readonly proofMode: SupportWorkflowMockupProofMode;
};

export const REQUIRED_SUPPORT_WORKFLOW_FIXTURE_FIELDS = [
  "requester",
  "customerSafeSummary",
  "severity",
  "affectedSurface",
  "ownerRoute",
  "evidenceLinks",
  "redactionState",
  "nextUpdateCondition",
] as const satisfies readonly (keyof SupportWorkflowFixture)[];

type SupportWorkflowScenarioPath = {
  readonly id: SupportWorkflowMockupScenario;
  readonly narrative: string;
  readonly fixtureIds: readonly string[];
  readonly safeOutcome: string;
};

type SupportWorkflowQuickstartFixtureReference = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: SupportWorkflowQuickstartFixtureId;
  readonly proofMode: SupportWorkflowQuickstartProofMode;
  readonly supportUse: string;
};

type VibeSupportWorkflowMockups = {
  readonly issue: "HOBO-550";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-support-workflow-mockups";
  readonly proofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md";
  readonly designRefs: readonly string[];
  readonly quickstartFixtureRefs: readonly SupportWorkflowQuickstartFixtureReference[];
  readonly personas: readonly SupportWorkflowMockupPersona[];
  readonly mockups: readonly SupportWorkflowMockup[];
  readonly fixtures: readonly SupportWorkflowFixture[];
  readonly scenarioPaths: readonly SupportWorkflowScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedSupportWorkflowMockupsBrand: unique symbol;

export type ParsedVibeSupportWorkflowMockups = VibeSupportWorkflowMockups & {
  readonly [parsedSupportWorkflowMockupsBrand]: true;
};

const FIXTURES: readonly SupportWorkflowFixture[] = [
  {
    id: "swm-received-admin-request",
    requester: "customer admin for workspace acme-prod",
    customerSafeSummary: "customer-safe intake summary with no raw secrets or tenant payloads",
    severity: "SEV2",
    affectedSurface: "workspace onboarding support form",
    ownerRoute: "Support Workflow / Customer Onboarding",
    evidenceLinks: [
      "docs/design/support-workflow.md#required-support-evidence",
      "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md#fixture-ids",
    ],
    redactionState: "customer-safe",
    nextUpdateCondition: "when support classifies severity and affected surface",
    proofMode: "live",
  },
  {
    id: "swm-classified-incident-risk",
    requester: "support operator after launch-window alert",
    customerSafeSummary: "redacted incident-adjacent summary without responder-only notes",
    severity: "SEV1",
    affectedSurface: "resource lifecycle deploy quickstart",
    ownerRoute: "Incident Communications / Support Workflow",
    evidenceLinks: [
      "docs/design/incident-communications.md#communication-surfaces",
      "docs/design/launch-support-escalation.md#severity-matrix",
    ],
    redactionState: "internal-only",
    nextUpdateCondition: "after incident commander confirms customer-visible impact",
    proofMode: "simulated",
  },
  {
    id: "swm-evidence-linked-plan-block",
    requester: "release owner reviewing blocked plan evidence",
    customerSafeSummary: "customer-safe blocked-plan summary with redacted proof ids",
    severity: "SEV3",
    affectedSurface: "plan/diff viewer handoff",
    ownerRoute: "Docs / Troubleshooting Guides",
    evidenceLinks: [
      "fixture://rlq-manage-stale-evidence-v1",
      "docs/design/troubleshooting-guides.md",
    ],
    redactionState: "customer-safe",
    nextUpdateCondition: "once docs owner approves the customer-safe workaround",
    proofMode: "reference fixture",
  },
  {
    id: "swm-owner-routed-security-approval",
    requester: "security/compliance reviewer",
    customerSafeSummary: "scope-out raw customer-data request routed without disclosure",
    severity: "SEV0",
    affectedSurface: "support evidence redaction gate",
    ownerRoute: "Security Verification / Legal",
    evidenceLinks: [
      "docs/design/security-verification.md#customer-communication",
      "docs/design/support-workflow.md#scope-out-and-non-goals",
    ],
    redactionState: "requires-security-approval",
    nextUpdateCondition: "before any customer-visible evidence leaves internal review",
    proofMode: "scope-out",
  },
  {
    id: "swm-customer-updated-limitation",
    requester: "customer admin awaiting support update",
    customerSafeSummary: "customer-safe limitation update without unsupported SLA language",
    severity: "SEV3",
    affectedSurface: "support ticket customer update",
    ownerRoute: "V1 Release Program & Cutline",
    evidenceLinks: [
      "docs/design/support-sla-channels.md#sla-language-boundary",
      "docs/design/known-limitations-register.md",
    ],
    redactionState: "customer-safe",
    nextUpdateCondition: "when release owner accepts or rejects the limitation wording",
    proofMode: "simulated",
  },
  {
    id: "swm-closed-docs-answer",
    requester: "support lead closing an approved docs answer",
    customerSafeSummary: "redacted closure summary with approved docs source and owner",
    severity: "SEV3",
    affectedSurface: "docs portal troubleshooting answer",
    ownerRoute: "Support Workflow / Docs Portal",
    evidenceLinks: [
      "docs/design/docs-portal.md",
      "docs/design/support-workflow.md#intake-states",
    ],
    redactionState: "customer-safe",
    nextUpdateCondition: "after follow-up issue or approved unsupported-state explanation is linked",
    proofMode: "reference fixture",
  },
];

const QUICKSTART_FIXTURE_REFS: readonly SupportWorkflowQuickstartFixtureReference[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-deploy-run-accepted-v1",
    proofMode: "simulated",
    supportUse: "support intake can cite accepted deploy transcript ids without claiming live provider operation",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    supportUse: "stale evidence support copy reuses the accepted quickstart stale-evidence fixture",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    proofMode: "live",
    supportUse: "future live recovery handoff stays gated by proof-mode label and owner route",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    proofMode: "scope-out",
    supportUse: "scope-out quickstart claims stay visible as limitations, not support promises",
  },
];

export const VIBE_SUPPORT_WORKFLOW_MOCKUPS: VibeSupportWorkflowMockups = {
  issue: "HOBO-550",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-support-workflow-mockups",
  proofPath: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
  designRefs: [
    "docs/design/support-workflow.md",
    "docs/design/support-sla-channels.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/incident-communications.md",
    "docs/design/admin-console.md",
    "docs/design/security-verification.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  quickstartFixtureRefs: QUICKSTART_FIXTURE_REFS,
  personas: REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS,
  mockups: [
    {
      id: "wf-received-intake",
      state: "received",
      title: "Support intake with requester, channel, affected surface, and first safe summary",
      personas: ["support lead", "support operator", "customer admin"],
      questionsAnswered: [
        "What was received, who asked for help, and what can support safely repeat back?",
        "Which evidence is missing before severity and owner route become accepted?",
      ],
      fixtureIds: ["swm-received-admin-request"],
    },
    {
      id: "wf-classified-triage",
      state: "classified",
      title: "Severity triage over accepted support SLA and escalation language",
      personas: ["support lead", "support operator", "incident commander", "release owner"],
      questionsAnswered: [
        "Which severity applies and which owner must accept the next support boundary?",
        "Does the issue need incident communication or stay in support workflow scope?",
      ],
      fixtureIds: ["swm-classified-incident-risk"],
    },
    {
      id: "wf-evidence-linked",
      state: "evidence-linked",
      title: "Redacted proof links and source records attached to a support case",
      personas: ["support operator", "security/compliance reviewer", "release owner"],
      questionsAnswered: [
        "Which proof package, docs source, quickstart fixture, or incident record is safe to link?",
        "Is the evidence customer-safe, internal-only, or blocked on approval?",
      ],
      fixtureIds: ["swm-evidence-linked-plan-block"],
    },
    {
      id: "wf-owner-routed",
      state: "owner-routed",
      title: "Owner route matrix for security, incident, docs, release, and support handoffs",
      personas: ["support lead", "incident commander", "security/compliance reviewer"],
      questionsAnswered: [
        "Which owning initiative accepts the next action without mutating customer data here?",
        "What must support say while the owner route is pending?",
      ],
      fixtureIds: ["swm-owner-routed-security-approval"],
    },
    {
      id: "wf-customer-updated",
      state: "customer-updated",
      title: "Customer-safe update with limitation wording and next update condition",
      personas: ["support operator", "customer admin", "release owner"],
      questionsAnswered: [
        "What can be told to the customer without exposing internals or promising an SLA?",
        "When is the next update due and which owner can change the answer?",
      ],
      fixtureIds: ["swm-customer-updated-limitation"],
    },
    {
      id: "wf-closed",
      state: "closed",
      title: "Closure state with approved answer, follow-up issue, or unsupported explanation",
      personas: ["support lead", "support operator", "customer admin"],
      questionsAnswered: [
        "Does closure link an approved docs answer, a follow-up owner, or an unsupported-state explanation?",
        "Can the request close without creating support automation or public launch claims?",
      ],
      fixtureIds: ["swm-closed-docs-answer"],
    },
  ],
  fixtures: FIXTURES,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "Support receives a customer-safe request, classifies it, links proof, updates the customer, and closes on approved docs.",
      fixtureIds: ["swm-received-admin-request", "swm-evidence-linked-plan-block", "swm-closed-docs-answer"],
      safeOutcome: "customer receives approved support wording and a docs source without raw evidence exposure",
    },
    {
      id: "blocked-path",
      narrative: "Security-sensitive evidence blocks customer-visible update until the security/legal owner route accepts it.",
      fixtureIds: ["swm-owner-routed-security-approval"],
      safeOutcome: "request remains owner-routed with scope-out label instead of leaking customer data",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "A stale quickstart or proof fixture creates a customer-safe limitation update instead of an unsupported claim.",
      fixtureIds: ["swm-evidence-linked-plan-block", "swm-customer-updated-limitation"],
      safeOutcome: "support states limitation and next update condition before promising readiness",
    },
    {
      id: "support-handoff",
      narrative: "Incident-adjacent severity routes to incident communications while support preserves redacted context.",
      fixtureIds: ["swm-classified-incident-risk", "swm-owner-routed-security-approval"],
      safeOutcome: "incident commander receives context and support keeps customer-safe boundary wording",
    },
  ],
  accessibilityNotes: [
    "Keyboard order follows intake, triage, evidence, owner route, customer update, then closure regions.",
    "Screen reader labels include state, severity, owner route, redaction state, proof mode, and next update condition.",
    "Contrast is not the only signal; blocked, stale, internal-only, and scope-out states include explicit text labels.",
    "Motion is optional; status changes and timeline transitions must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No helpdesk software or ticket queue automation.",
    "No production support UI.",
    "No customer-data access, secret access, or support impersonation.",
    "No incident command, on-call staffing, runbook execution, or notification dispatch.",
    "No contractual SLA promise, public response-time guarantee, or paid support term.",
    "No launch claim without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(helpdesk software|helpdesk integration|ticket queue|ticket queues|ticket automation|queue automation)\b/i,
  /\b(customer[- ]data access|raw customer data|tenant data browsing|support impersonation|secret access)\b/i,
  /\b(run|own|replace|implement)\b.*\bincident command\b/i,
  /\b(on-call staffing|oncall staffing|on-call schedule|runbook execution|notification dispatch)\b/i,
  /\b(production support ui|support portal ui|production ui)\b/i,
  /\b(contractual sla|promise.*sla|response-time guarantee|paid support term)\b/i,
  /\b(launch claim|launch readiness).*\bwithout evidence\b/i,
];

export type SupportWorkflowMockupRequestClassification = "in-scope-proof" | "scope-out";

export class VibeSupportWorkflowMockupsParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe support workflow mockups failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibeSupportWorkflowMockupsParseError";
  }
}

export function parseVibeSupportWorkflowMockups(
  mockups: VibeSupportWorkflowMockups,
): ParsedVibeSupportWorkflowMockups {
  const validation = validateVibeSupportWorkflowMockups(mockups);

  if (!validation.ok) {
    throw new VibeSupportWorkflowMockupsParseError(validation.errors);
  }

  // SAFETY: `return mockups as ParsedVibeSupportWorkflowMockups;` is required at this I/O or test boundary.
  return mockups as ParsedVibeSupportWorkflowMockups;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeSupportWorkflowMockups(
  mockups: VibeSupportWorkflowMockups,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (mockups.issue !== "HOBO-550") {
    errors.push({ code: "wrong-issue", message: "mockup contract must pin HOBO-550" });
  }
  if (mockups.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "mockup contract must stay in M1" });
  }
  if (mockups.packagePath !== "src/draft/exp-proofs/ux/vibe-support-workflow-mockups") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (mockups.proofPath !== "docs/design/proofs/vibe-support-workflow-mockups/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(mockups.personas, REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS)) {
    errors.push({ code: "missing-persona", message: "required persona set must be exact" });
  }
  if (!arraysEqual(mockups.mockups.map((mockup) => mockup.state), REQUIRED_SUPPORT_WORKFLOW_MOCKUP_STATES)) {
    errors.push({
      code: "missing-mockup-state",
      message: "mockups must cover support intake states in accepted order",
    });
  }

  validateQuickstartRefs(mockups.quickstartFixtureRefs, errors);

  const fixtureIds = new Set(mockups.fixtures.map((fixture) => fixture.id));
  for (const mockup of mockups.mockups) {
    if (mockup.personas.length === 0 || mockup.questionsAnswered.length === 0) {
      errors.push({
        code: "incomplete-mockup-question",
        message: `${mockup.id} must name personas and support questions`,
      });
    }
    for (const fixtureId of mockup.fixtureIds) {
      if (!fixtureIds.has(fixtureId)) {
        errors.push({
          code: "unknown-mockup-fixture",
          message: `${mockup.id} references missing fixture ${fixtureId}`,
        });
      }
    }
  }

  const proofModes = new Set<SupportWorkflowMockupProofMode>();
  for (const fixture of mockups.fixtures) {
    for (const field of REQUIRED_SUPPORT_WORKFLOW_FIXTURE_FIELDS) {
      const value = fixture[field];
      if (Array.isArray(value) ? value.length === 0 : !value) {
        errors.push({
          code: "missing-fixture-field",
          message: `${fixture.id} must include ${String(field)}`,
        });
      }
    }
    if (!REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PROOF_MODES.includes(fixture.proofMode)) {
      errors.push({
        code: "unsupported-proof-mode",
        message: `${fixture.id} uses unsupported proof mode ${String(fixture.proofMode)}`,
      });
    } else {
      proofModes.add(fixture.proofMode);
    }
  }
  if (!arraysEqual([...proofModes], REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PROOF_MODES)) {
    errors.push({
      code: "missing-proof-mode-label",
      message: "fixtures must cover live, simulated, reference fixture, and scope-out",
    });
  }

  if (!arraysEqual(mockups.scenarioPaths.map((scenario) => scenario.id), REQUIRED_SUPPORT_WORKFLOW_MOCKUP_SCENARIOS)) {
    errors.push({
      code: "missing-scenario-path",
      message: "scenario paths must cover happy, blocked, stale/unknown, and support handoff",
    });
  }
  for (const scenario of mockups.scenarioPaths) {
    if (!scenario.narrative || scenario.fixtureIds.length === 0 || !scenario.safeOutcome) {
      errors.push({
        code: "incomplete-scenario",
        message: `${scenario.id} must name narrative, fixtures, and safe outcome`,
      });
    }
  }

  const accessibilityText = mockups.accessibilityNotes.join(" ").toLowerCase();
  for (const requiredNote of ["keyboard", "screen reader", "contrast", "motion"]) {
    if (!accessibilityText.includes(requiredNote)) {
      errors.push({
        code: "missing-accessibility-note",
        message: `accessibility notes must include ${requiredNote}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifySupportWorkflowMockupRequest(
  summary: string,
): SupportWorkflowMockupRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartRefs(
  refs: readonly SupportWorkflowQuickstartFixtureReference[],
  errors: ValidationError[],
): void {
  const fixtureIds = refs.map((ref) => ref.fixtureId);
  const proofModes = new Set<SupportWorkflowQuickstartProofMode>();

  if (!arraysEqual(fixtureIds, REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "support workflow mockups must cite required HOBO-577 quickstart fixture ids",
    });
  }
  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({
        code: "wrong-quickstart-source",
        message: `${ref.fixtureId} must cite HOBO-577`,
      });
    }
    if (!REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_FIXTURE_IDS.includes(ref.fixtureId)) {
      errors.push({
        code: "unknown-quickstart-fixture",
        message: `${ref.fixtureId} is not an accepted HOBO-577 support fixture`,
      });
    }
    if (!REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_PROOF_MODES.includes(ref.proofMode)) {
      errors.push({
        code: "unknown-quickstart-proof-mode",
        message: `${ref.fixtureId} uses unsupported HOBO-577 proof mode ${String(ref.proofMode)}`,
      });
    } else {
      proofModes.add(ref.proofMode);
    }
    if (!ref.supportUse) {
      errors.push({
        code: "missing-quickstart-support-use",
        message: `${ref.fixtureId} must explain support workflow consumption`,
      });
    }
  }
  for (const proofMode of REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_PROOF_MODES) {
    if (proofModes.has(proofMode)) continue;
    errors.push({
      code: "missing-quickstart-proof-mode",
      message: "support workflow mockups must preserve HOBO-577 reference-fixture, simulated, live, and scope-out labels",
    });
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
