export const REQUIRED_PUBLISHER_PORTAL_PERSONAS = [
  "publisher owner",
  "publisher maintainer",
  "marketplace operator",
  "security reviewer",
  "support operator",
  "release owner",
] as const;

export const REQUIRED_PUBLISHER_PORTAL_STATES = [
  "submission-draft",
  "evidence-upload",
  "review-status",
  "rejection-remediation",
  "resubmission",
  "yank-remediation",
  "payout-support-handoff",
] as const;

export const REQUIRED_PUBLISHER_PORTAL_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_PUBLISHER_PORTAL_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_PUBLISHER_PORTAL_QUICKSTART_FIXTURE_IDS = [
  "rlq-define-object-graph-v1",
  "rlq-collect-manifest-ir-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-snapshot-restore-v1",
  "rlq-recover-scope-out-v1",
] as const;

export const REQUIRED_PUBLISHER_PORTAL_QUICKSTART_PROOF_MODES = [
  "reference-fixture",
  "simulated",
  "live",
  "scope-out",
] as const;

export const REQUIRED_PUBLISHER_PORTAL_ACCESSIBILITY_TOPICS = [
  "keyboard",
  "screen reader",
  "contrast",
  "motion",
] as const;

type PublisherPortalPersona = (typeof REQUIRED_PUBLISHER_PORTAL_PERSONAS)[number];
type PublisherPortalState = (typeof REQUIRED_PUBLISHER_PORTAL_STATES)[number];
type PublisherPortalScenario = (typeof REQUIRED_PUBLISHER_PORTAL_SCENARIOS)[number];
type PublisherPortalProofMode = (typeof REQUIRED_PUBLISHER_PORTAL_PROOF_MODES)[number];
type PublisherPortalQuickstartFixtureId = (typeof REQUIRED_PUBLISHER_PORTAL_QUICKSTART_FIXTURE_IDS)[number];
type PublisherPortalQuickstartProofMode = (typeof REQUIRED_PUBLISHER_PORTAL_QUICKSTART_PROOF_MODES)[number];

type PublisherPortalMockup = {
  readonly id: string;
  readonly state: PublisherPortalState;
  readonly title: string;
  readonly personas: readonly PublisherPortalPersona[];
  readonly questionsAnswered: readonly string[];
  readonly fixtureIds: readonly string[];
};

export type PublisherPortalFixture = {
  readonly id: string;
  readonly artifactMetadata: string;
  readonly evidenceState: string;
  readonly reviewOutcome: string;
  readonly payoutReadinessHandoff: string;
  readonly supportWording: string;
  readonly customerVisibleLimitation: string;
  readonly proofMode: PublisherPortalProofMode;
};

export const REQUIRED_PUBLISHER_PORTAL_FIXTURE_FIELDS = [
  "artifactMetadata",
  "evidenceState",
  "reviewOutcome",
  "payoutReadinessHandoff",
  "supportWording",
  "customerVisibleLimitation",
] as const satisfies readonly (keyof PublisherPortalFixture)[];

type PublisherPortalScenarioPath = {
  readonly id: PublisherPortalScenario;
  readonly narrative: string;
  readonly fixtureIds: readonly string[];
  readonly safeOutcome: string;
};

type PublisherPortalQuickstartFixtureReference = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: PublisherPortalQuickstartFixtureId;
  readonly proofMode: PublisherPortalQuickstartProofMode;
  readonly publisherUse: string;
};

type VibePublisherPortalReviewMockups = {
  readonly issue: "HOBO-548";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-publisher-portal-review-mockups";
  readonly proofPath: "docs/design/proofs/vibe-publisher-portal-review-mockups/README.md";
  readonly designRefs: readonly string[];
  readonly quickstartFixtureRefs: readonly PublisherPortalQuickstartFixtureReference[];
  readonly personas: readonly PublisherPortalPersona[];
  readonly mockups: readonly PublisherPortalMockup[];
  readonly fixtures: readonly PublisherPortalFixture[];
  readonly scenarioPaths: readonly PublisherPortalScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedPublisherPortalMockupsBrand: unique symbol;

export type ParsedVibePublisherPortalReviewMockups = VibePublisherPortalReviewMockups & {
  readonly [parsedPublisherPortalMockupsBrand]: true;
};

const FIXTURES: readonly PublisherPortalFixture[] = [
  {
    id: "ppm-submission-draft-provider-pack",
    artifactMetadata: "signed capability package artifact with digest, version, source, and publisher org id",
    evidenceState: "complete identity and artifact evidence ready for review",
    reviewOutcome: "ready for review by marketplace operator",
    payoutReadinessHandoff: "not eligible until trust review and commercial owner handoff are accepted",
    supportWording: "customer-safe submission summary names owner route and no installability claim",
    customerVisibleLimitation: "limited visibility until review evidence is accepted",
    proofMode: "live",
  },
  {
    id: "ppm-evidence-upload-missing-sbom",
    artifactMetadata: "capability bundle upload with provenance but missing SBOM and vulnerability notice",
    evidenceState: "evidence-required because security evidence is missing",
    reviewOutcome: "limited beta review cannot proceed to installable",
    payoutReadinessHandoff: "blocked by security reviewer owner handoff",
    supportWording: "support can say required evidence is missing without exposing scanner details",
    customerVisibleLimitation: "blocked from installable claims until evidence is complete",
    proofMode: "simulated",
  },
  {
    id: "ppm-review-approved-installable",
    artifactMetadata: "resource pack artifact, conformance report, capability spec, and immutable version pin",
    evidenceState: "complete review evidence with catalog approval",
    reviewOutcome: "approved installable with required provenance and security review",
    payoutReadinessHandoff: "handoff to Marketplace Payout Hooks owner for eligibility review",
    supportWording: "customer-safe support note links review owner and accepted evidence source",
    customerVisibleLimitation: "limited to accepted catalog scopes and proof-mode wording",
    proofMode: "reference fixture",
  },
  {
    id: "ppm-rejected-remediation-copy",
    artifactMetadata: "publisher package with unsupported permission request and stale provenance",
    evidenceState: "rejected stale evidence with remediation required",
    reviewOutcome: "rejected by security reviewer with resubmission guidance",
    payoutReadinessHandoff: "not eligible while rejection remains unresolved",
    supportWording: "customer-safe remediation guidance routes to publisher owner and support operator",
    customerVisibleLimitation: "not installable and not customer-visible as approved",
    proofMode: "scope-out",
  },
  {
    id: "ppm-yanked-migration-guidance",
    artifactMetadata: "previously accepted package now yanked with replacement version and audit link",
    evidenceState: "yanked evidence retained for audit and migration support",
    reviewOutcome: "yanked from new selection with support escalation owner",
    payoutReadinessHandoff: "blocked owner handoff until catalog and payout status are reconciled",
    supportWording: "customer-safe yank wording points to migration guidance and support owner",
    customerVisibleLimitation: "blocked for new installs; existing users receive migration guidance",
    proofMode: "simulated",
  },
  {
    id: "ppm-payout-blocked-unsupported-jurisdiction",
    artifactMetadata: "publisher profile and listing artifact accepted for review but payout facts incomplete",
    evidenceState: "complete listing evidence but payout handoff unsupported",
    reviewOutcome: "escalated for release owner because customer-visible payout copy is unsupported",
    payoutReadinessHandoff: "blocked by unsupported jurisdiction owner route",
    supportWording: "support limitation wording avoids payout promise and names commercial owner",
    customerVisibleLimitation: "unsupported payout claim remains hidden from customer-facing surfaces",
    proofMode: "reference fixture",
  },
];

const QUICKSTART_FIXTURE_REFS: readonly PublisherPortalQuickstartFixtureReference[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-define-object-graph-v1",
    proofMode: "reference-fixture",
    publisherUse: "publisher submission mockups reuse the accepted object graph fixture as artifact source evidence",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-collect-manifest-ir-v1",
    proofMode: "simulated",
    publisherUse: "evidence upload states reuse the accepted collect fixture without claiming Registry storage or live upload",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    publisherUse: "stale evidence and rejection remediation copy reuse the accepted quickstart stale-evidence fixture",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    proofMode: "live",
    publisherUse: "yank remediation can point to accepted recovery proof labels while avoiding runtime migration automation",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    proofMode: "scope-out",
    publisherUse: "scope-out quickstart claims stay visible as launch, payout, and customer-data limitations",
  },
];

export const VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS: VibePublisherPortalReviewMockups = {
  issue: "HOBO-548",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-publisher-portal-review-mockups",
  proofPath: "docs/design/proofs/vibe-publisher-portal-review-mockups/README.md",
  designRefs: [
    "docs/design/publisher-portal.md",
    "docs/design/capability-review-approval.md",
    "docs/design/marketplace-publisher-trust-evidence.md",
    "docs/design/marketplace-payout-hooks.md",
    "docs/design/org-catalogs.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  quickstartFixtureRefs: QUICKSTART_FIXTURE_REFS,
  personas: REQUIRED_PUBLISHER_PORTAL_PERSONAS,
  mockups: [
    {
      id: "mockup-submission-draft",
      state: "submission-draft",
      title: "Publisher submission draft with owner, maintainer, artifact, and evidence checklist",
      personas: ["publisher owner", "publisher maintainer", "marketplace operator", "release owner"],
      questionsAnswered: [
        "Which publisher identity, maintainer role, artifact, and support contact are present before review begins?",
        "Which missing evidence blocks review without creating a live onboarding service?",
      ],
      fixtureIds: ["ppm-submission-draft-provider-pack"],
    },
    {
      id: "mockup-evidence-upload",
      state: "evidence-upload",
      title: "Evidence upload status for provenance, SBOM, conformance, warnings, and support notes",
      personas: ["publisher maintainer", "security reviewer", "marketplace operator"],
      questionsAnswered: [
        "Which evidence item is uploaded, missing, stale, or blocked and who owns the next review action?",
        "How does the mockup show missing evidence without invoking scanners or registry storage?",
      ],
      fixtureIds: ["ppm-evidence-upload-missing-sbom"],
    },
    {
      id: "mockup-review-status",
      state: "review-status",
      title: "Review status projection for ready, limited, installable, rejected, yanked, and escalated states",
      personas: ["marketplace operator", "security reviewer", "publisher owner", "support operator"],
      questionsAnswered: [
        "Which review outcome is visible and which evidence source justifies any installability wording?",
        "Where does support route questions when approval, rejection, or escalation changes?",
      ],
      fixtureIds: ["ppm-review-approved-installable"],
    },
    {
      id: "mockup-rejection-remediation",
      state: "rejection-remediation",
      title: "Rejected listing remediation with reason, resubmission checklist, and owner route",
      personas: ["publisher owner", "publisher maintainer", "security reviewer", "support operator"],
      questionsAnswered: [
        "Which remediation steps are safe to show to the publisher and which remain internal review evidence?",
        "How is a rejected package prevented from becoming customer-visible or installable?",
      ],
      fixtureIds: ["ppm-rejected-remediation-copy"],
    },
    {
      id: "mockup-resubmission",
      state: "resubmission",
      title: "Resubmission path that preserves prior rejection context and new evidence links",
      personas: ["publisher maintainer", "marketplace operator", "security reviewer"],
      questionsAnswered: [
        "Which previous rejection context carries forward and which new evidence resets review readiness?",
        "Does resubmission stay as a mockup contract rather than a workflow engine?",
      ],
      fixtureIds: ["ppm-evidence-upload-missing-sbom", "ppm-review-approved-installable"],
    },
    {
      id: "mockup-yank-remediation",
      state: "yank-remediation",
      title: "Yanked listing remediation, customer-safe migration guidance, and support owner",
      personas: ["marketplace operator", "support operator", "publisher owner", "release owner"],
      questionsAnswered: [
        "Which customer-visible copy explains the yank without promising runtime migration automation?",
        "Which owner accepts support guidance, catalog state, and replacement listing evidence?",
      ],
      fixtureIds: ["ppm-yanked-migration-guidance"],
    },
    {
      id: "mockup-payout-support-handoff",
      state: "payout-support-handoff",
      title: "Payout-readiness and unsupported-state handoff without money movement or provider setup",
      personas: ["publisher owner", "marketplace operator", "support operator", "release owner"],
      questionsAnswered: [
        "Which payout-adjacent state is visible and which commercial owner must accept the limitation?",
        "How is support wording kept customer-safe without implementing payout or support tooling?",
      ],
      fixtureIds: ["ppm-payout-blocked-unsupported-jurisdiction"],
    },
  ],
  fixtures: FIXTURES,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "Publisher submits complete artifact and evidence, review marks it installable, and payout stays a separate handoff.",
      fixtureIds: ["ppm-submission-draft-provider-pack", "ppm-review-approved-installable"],
      safeOutcome: "listing can show accepted review evidence while payout and support execution remain external handoffs",
    },
    {
      id: "blocked-path",
      narrative: "Missing SBOM or vulnerability evidence blocks installability and keeps publisher copy in remediation state.",
      fixtureIds: ["ppm-evidence-upload-missing-sbom", "ppm-rejected-remediation-copy"],
      safeOutcome: "publisher receives customer-safe remediation guidance instead of approval or storefront visibility",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "Stale provenance or unknown catalog approval yields rejected or yanked copy and no launch claim.",
      fixtureIds: ["ppm-rejected-remediation-copy", "ppm-yanked-migration-guidance"],
      safeOutcome: "portal surfaces owner route, limitation, and migration guidance without proofless claims",
    },
    {
      id: "support-handoff",
      narrative: "Yanked or payout-blocked states route to support and commercial owners with approved limitation wording.",
      fixtureIds: ["ppm-yanked-migration-guidance", "ppm-payout-blocked-unsupported-jurisdiction"],
      safeOutcome: "support can explain the state without customer data, support tooling, or payout execution",
    },
  ],
  accessibilityNotes: [
    "Keyboard order follows submission, evidence, review outcome, remediation, yank guidance, payout handoff, and support route.",
    "Screen reader labels include publisher role, listing state, evidence state, review outcome, proof mode, and owner route.",
    "Contrast is not the only state signal; blocked, rejected, yanked, unsupported, and scope-out states use explicit text.",
    "Motion is optional; upload, review, and yank transitions must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No publisher onboarding service.",
    "No artifact hosting, Registry storage, package hosting, or signing runtime.",
    "No payout provider, tax collection, bank account, settlement, or money movement implementation.",
    "No security scanner, conformance runner, approval service, or policy engine implementation.",
    "No production publisher portal UI, storefront, support queue, or support automation.",
    "No customer-data access or launch claim without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(publisher onboarding service|onboarding service|publisher service)\b/i,
  /\b(artifact hosting|registry storage|package hosting|signing runtime|live registry)\b/i,
  /\b(payout implementation|payout provider|bank account|settlement|money movement|tax collection)\b/i,
  /\b(security scanner|conformance runner|approval service|policy engine)\b/i,
  /\b(production publisher portal ui|production ui|storefront|support queue|support automation|support tooling)\b/i,
  /\b(customer data|customer-data|tenant data)\b/i,
  /\b(launch claim|launch claims|public claim).*\bwithout evidence\b/i,
];

export type PublisherPortalReviewMockupRequestClassification = "in-scope-proof" | "scope-out";

export class VibePublisherPortalReviewMockupsParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe publisher portal review mockups failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibePublisherPortalReviewMockupsParseError";
  }
}

export function parseVibePublisherPortalReviewMockups(
  mockups: VibePublisherPortalReviewMockups,
): ParsedVibePublisherPortalReviewMockups {
  const validation = validateVibePublisherPortalReviewMockups(mockups);

  if (!validation.ok) {
    throw new VibePublisherPortalReviewMockupsParseError(validation.errors);
  }

  // SAFETY: `return mockups as ParsedVibePublisherPortalReviewMockups;` is required at this I/O or test boundary.
  return mockups as ParsedVibePublisherPortalReviewMockups;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibePublisherPortalReviewMockups(
  mockups: VibePublisherPortalReviewMockups,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (mockups.issue !== "HOBO-548") {
    errors.push({ code: "wrong-issue", message: "mockup contract must pin HOBO-548" });
  }
  if (mockups.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "mockup contract must stay in M1" });
  }
  if (mockups.packagePath !== "src/draft/exp-proofs/ux/vibe-publisher-portal-review-mockups") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (mockups.proofPath !== "docs/design/proofs/vibe-publisher-portal-review-mockups/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(mockups.personas, REQUIRED_PUBLISHER_PORTAL_PERSONAS)) {
    errors.push({ code: "missing-persona", message: "required persona set must be exact" });
  }
  if (!arraysEqual(mockups.mockups.map((mockup) => mockup.state), REQUIRED_PUBLISHER_PORTAL_STATES)) {
    errors.push({
      code: "missing-mockup-state",
      message: "mockups must cover publisher portal states in accepted order",
    });
  }
  validateQuickstartRefs(mockups.quickstartFixtureRefs, errors);

  const fixtureIds = new Set(mockups.fixtures.map((fixture) => fixture.id));
  for (const mockup of mockups.mockups) {
    if (mockup.personas.length === 0 || mockup.questionsAnswered.length === 0) {
      errors.push({
        code: "incomplete-mockup-question",
        message: `${mockup.id} must name personas and review questions`,
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

  const proofModes = new Set<PublisherPortalProofMode>();
  for (const fixture of mockups.fixtures) {
    for (const field of REQUIRED_PUBLISHER_PORTAL_FIXTURE_FIELDS) {
      const value = fixture[field];
      if (!value) {
        errors.push({
          code: "missing-fixture-field",
          message: `${fixture.id} must include ${String(field)}`,
        });
      }
    }
    if (!REQUIRED_PUBLISHER_PORTAL_PROOF_MODES.includes(fixture.proofMode)) {
      errors.push({
        code: "unsupported-proof-mode",
        message: `${fixture.id} uses unsupported proof mode ${String(fixture.proofMode)}`,
      });
    } else {
      proofModes.add(fixture.proofMode);
    }
  }
  if (!arraysEqual([...proofModes], REQUIRED_PUBLISHER_PORTAL_PROOF_MODES)) {
    errors.push({
      code: "missing-proof-mode-label",
      message: "fixtures must cover live, simulated, reference fixture, and scope-out",
    });
  }

  if (!arraysEqual(mockups.scenarioPaths.map((scenario) => scenario.id), REQUIRED_PUBLISHER_PORTAL_SCENARIOS)) {
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
    for (const fixtureId of scenario.fixtureIds) {
      if (!fixtureIds.has(fixtureId)) {
        errors.push({
          code: "unknown-scenario-fixture",
          message: `${scenario.id} references missing fixture ${fixtureId}`,
        });
      }
    }
  }

  const accessibilityText = mockups.accessibilityNotes.join(" ").toLowerCase();
  for (const topic of REQUIRED_PUBLISHER_PORTAL_ACCESSIBILITY_TOPICS) {
    if (!accessibilityText.includes(topic)) {
      errors.push({
        code: "missing-accessibility-note",
        message: `accessibility notes must include ${topic}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyPublisherPortalReviewMockupRequest(
  summary: string,
): PublisherPortalReviewMockupRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartRefs(
  refs: readonly PublisherPortalQuickstartFixtureReference[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(refs.map((ref) => ref.fixtureId), REQUIRED_PUBLISHER_PORTAL_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "publisher portal mockups must cite required HOBO-577 quickstart fixture ids",
    });
  }

  const proofModes = new Set<PublisherPortalQuickstartProofMode>();
  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({
        code: "wrong-quickstart-source",
        message: `${ref.fixtureId} must cite HOBO-577`,
      });
    }
    if (!REQUIRED_PUBLISHER_PORTAL_QUICKSTART_FIXTURE_IDS.includes(ref.fixtureId)) {
      errors.push({
        code: "unknown-quickstart-fixture",
        message: `${ref.fixtureId} is not an accepted HOBO-577 publisher fixture`,
      });
    }
    if (!REQUIRED_PUBLISHER_PORTAL_QUICKSTART_PROOF_MODES.includes(ref.proofMode)) {
      errors.push({
        code: "unknown-quickstart-proof-mode",
        message: `${ref.fixtureId} uses unsupported HOBO-577 proof mode ${String(ref.proofMode)}`,
      });
    } else {
      proofModes.add(ref.proofMode);
    }
    if (!ref.publisherUse || ref.publisherUse.length < 30) {
      errors.push({
        code: "missing-quickstart-publisher-use",
        message: `${ref.fixtureId} must explain how publisher portal mockups consume the quickstart fixture`,
      });
    }
  }

  if (!arraysEqual([...proofModes], REQUIRED_PUBLISHER_PORTAL_QUICKSTART_PROOF_MODES)) {
    errors.push({
      code: "missing-quickstart-proof-mode",
      message: "publisher portal mockups must preserve HOBO-577 reference-fixture, simulated, live, and scope-out labels",
    });
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
