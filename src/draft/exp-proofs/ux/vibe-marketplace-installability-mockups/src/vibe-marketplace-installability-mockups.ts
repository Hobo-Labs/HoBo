export const REQUIRED_MARKETPLACE_PERSONAS = [
  "app developer",
  "workspace administrator",
  "marketplace operator",
  "security reviewer",
  "support operator",
] as const;

export const REQUIRED_MARKETPLACE_SURFACES = [
  "browse",
  "search",
  "listing-detail",
  "installability-panel",
] as const;

export const REQUIRED_MARKETPLACE_FIXTURE_STATES = [
  "preview-only",
  "limited-beta",
  "installable",
  "policy-blocked",
  "deprecated",
  "yanked",
] as const;

export const REQUIRED_MARKETPLACE_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_MARKETPLACE_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_QUICKSTART_FIXTURE_IDS = [
  "rlq-collect-manifest-ir-v1",
  "rlq-plan-safe-preview-v1",
  "rlq-deploy-run-accepted-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-scope-out-v1",
] as const;

type MarketplacePersona = (typeof REQUIRED_MARKETPLACE_PERSONAS)[number];
type MarketplaceSurface = (typeof REQUIRED_MARKETPLACE_SURFACES)[number];
type MarketplaceFixtureState = (typeof REQUIRED_MARKETPLACE_FIXTURE_STATES)[number];
type MarketplaceScenario = (typeof REQUIRED_MARKETPLACE_SCENARIOS)[number];
type MarketplaceProofMode = (typeof REQUIRED_MARKETPLACE_PROOF_MODES)[number];
type QuickstartFixtureId = (typeof REQUIRED_QUICKSTART_FIXTURE_IDS)[number];
type QuickstartProofMode = "reference-fixture" | "simulated" | "live" | "scope-out";

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceWireframe proto message in data-models/.
export type MarketplaceWireframe = {
  readonly id: string;
  readonly surface: MarketplaceSurface;
  readonly title: string;
  readonly personas: readonly MarketplacePersona[];
  readonly questionsAnswered: readonly string[];
  readonly fixtureIds: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceListingFixture proto message in data-models/.
export type MarketplaceListingFixture = {
  readonly state: MarketplaceFixtureState;
  readonly fixtureId: string;
  readonly visibleState: string;
  readonly evidenceSource: string;
  readonly ownerRoute: string;
  readonly customerSafeMessage: string;
  readonly orgCatalogDisposition: string;
  readonly proofMode: MarketplaceProofMode;
  readonly trustEvidence: string;
  readonly supportHandoff: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceScenarioPath proto message in data-models/.
export type MarketplaceScenarioPath = {
  readonly id: MarketplaceScenario;
  readonly narrative: string;
  readonly fixtureIds: readonly string[];
  readonly proofModeLabels: readonly MarketplaceProofMode[];
  readonly accessibilityNote: string;
  readonly safeOutcome: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceQuickstartFixtureReference proto message in data-models/.
export type MarketplaceQuickstartFixtureReference = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: QuickstartFixtureId;
  readonly proofMode: QuickstartProofMode;
  readonly consumingSurface: MarketplaceSurface;
  readonly marketplaceUse: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the VibeMarketplaceInstallabilityMockups proto message in data-models/.
export type VibeMarketplaceInstallabilityMockups = {
  readonly issue: "HOBO-546";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups";
  readonly proofPath: "docs/design/proofs/vibe-marketplace-installability-mockups/README.md";
  readonly designRefs: readonly string[];
  readonly quickstartFixtureRefs: readonly MarketplaceQuickstartFixtureReference[];
  readonly personas: readonly MarketplacePersona[];
  readonly wireframes: readonly MarketplaceWireframe[];
  readonly fixtures: readonly MarketplaceListingFixture[];
  readonly scenarioPaths: readonly MarketplaceScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

export type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedMarketplaceMockupsBrand: unique symbol;

export type ParsedVibeMarketplaceInstallabilityMockups =
  VibeMarketplaceInstallabilityMockups & {
    readonly [parsedMarketplaceMockupsBrand]: true;
  };

const FIXTURES: readonly MarketplaceListingFixture[] = [
  {
    state: "preview-only",
    fixtureId: "hobo-546-marketplace-preview-only",
    visibleState: "Preview only",
    evidenceSource: "docs/design/marketplace-publisher-trust-evidence.md#launch-limitations",
    ownerRoute: "Marketplace Publisher Trust Evidence",
    customerSafeMessage:
      "Preview listing is visible for evaluation but cannot be presented as installable.",
    orgCatalogDisposition: "not in org catalog; workspace admins see an evaluation-only state",
    proofMode: "reference fixture",
    trustEvidence: "publisher identity present; security review and catalog approval incomplete",
    supportHandoff: "route questions to marketplace trust owner with launch-limit wording",
  },
  {
    state: "limited-beta",
    fixtureId: "hobo-546-marketplace-limited-beta",
    visibleState: "Limited beta",
    evidenceSource: "docs/design/capability-review-approval.md#approval-outcomes",
    ownerRoute: "Capability Review & Approval",
    customerSafeMessage:
      "Limited-beta listing is available only to allowed scopes with explicit missing-evidence limits.",
    orgCatalogDisposition: "approved for beta workspace scope with policy pin required",
    proofMode: "simulated",
    trustEvidence: "limited-beta approval recorded; conformance evidence still bounded",
    supportHandoff: "route blockers to capability review owner before expanding visibility",
  },
  {
    state: "installable",
    fixtureId: "hobo-546-marketplace-installable",
    visibleState: "Installable with evidence",
    evidenceSource: "docs/design/marketplace-ux.md#installability-outcomes",
    ownerRoute: "Capability Review & Approval",
    customerSafeMessage:
      "Listing is installable only because provenance, conformance, security review, catalog, and policy evidence are present.",
    orgCatalogDisposition: "approved in org catalog with immutable version pin and support owner",
    proofMode: "live",
    trustEvidence: "signed provenance, conformance certificate, security review, and org catalog approval exist",
    supportHandoff: "attach evidence links and approved scope before any customer action",
  },
  {
    state: "policy-blocked",
    fixtureId: "hobo-546-marketplace-policy-blocked",
    visibleState: "Blocked by policy",
    evidenceSource: "docs/design/org-catalogs.md#entry-states",
    ownerRoute: "Org Catalogs",
    customerSafeMessage:
      "Listing is blocked for this workspace by catalog, policy, trust, or approval state.",
    orgCatalogDisposition: "blocked for current workspace; no install intent is exposed",
    proofMode: "reference fixture",
    trustEvidence: "policy pin denies this scope even though listing metadata remains visible",
    supportHandoff: "show owner route and denial evidence without granting override",
  },
  {
    state: "deprecated",
    fixtureId: "hobo-546-marketplace-deprecated",
    visibleState: "Deprecated",
    evidenceSource: "docs/design/org-catalogs.md#entry-states",
    ownerRoute: "Registry Distribution",
    customerSafeMessage:
      "Deprecated listing remains visible only for migration guidance and existing-use explanation.",
    orgCatalogDisposition: "deprecated entry remains audit-visible with replacement route",
    proofMode: "reference fixture",
    trustEvidence: "deprecation notice and replacement evidence exist; new install is not default",
    supportHandoff: "route to migration owner and support-safe replacement guidance",
  },
  {
    state: "yanked",
    fixtureId: "hobo-546-marketplace-yanked",
    visibleState: "Yanked",
    evidenceSource: "docs/design/capability-review-approval.md#review-queue-states",
    ownerRoute: "Support Workflow",
    customerSafeMessage:
      "Yanked listing is removed from new selection and routed to support or migration guidance.",
    orgCatalogDisposition: "retired from org catalog selection and retained for audit only",
    proofMode: "scope-out",
    trustEvidence: "yank decision exists; production registry removal stays out of this proof",
    supportHandoff: "send redacted customer-safe yank reason to support owner",
  },
];

const QUICKSTART_REFS: readonly MarketplaceQuickstartFixtureReference[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-collect-manifest-ir-v1",
    proofMode: "reference-fixture",
    consumingSurface: "browse",
    marketplaceUse: "browse cards use accepted manifest fixture ids instead of inventing resource lifecycle behavior",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-plan-safe-preview-v1",
    proofMode: "simulated",
    consumingSurface: "search",
    marketplaceUse: "search result warnings reuse plan-preview proof-mode wording",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-deploy-run-accepted-v1",
    proofMode: "live",
    consumingSurface: "installability-panel",
    marketplaceUse: "installability copy can cite accepted deploy evidence without building install runtime",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    consumingSurface: "listing-detail",
    marketplaceUse: "listing detail stale-evidence labels reuse the accepted manage fixture",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    proofMode: "scope-out",
    consumingSurface: "installability-panel",
    marketplaceUse: "scope-out recovery label prevents marketplace UI from implying live remediation",
  },
];

export const VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS: VibeMarketplaceInstallabilityMockups = {
  issue: "HOBO-546",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups",
  proofPath: "docs/design/proofs/vibe-marketplace-installability-mockups/README.md",
  designRefs: [
    "docs/design/marketplace-ux.md",
    "docs/design/marketplace-publisher-trust-evidence.md",
    "docs/design/capability-review-approval.md",
    "docs/design/org-catalogs.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  quickstartFixtureRefs: QUICKSTART_REFS,
  personas: REQUIRED_MARKETPLACE_PERSONAS,
  wireframes: [
    {
      id: "wf-marketplace-browse",
      surface: "browse",
      title: "Browse grid with visible listing state and proof-mode chips",
      personas: ["app developer", "workspace administrator", "marketplace operator"],
      questionsAnswered: [
        "Which listings are visible, preview-only, beta, installable, blocked, deprecated, or yanked before the user clicks?",
        "What evidence and owner route explain why a card can or cannot expose install intent?",
      ],
      fixtureIds: [
        "hobo-546-marketplace-preview-only",
        "hobo-546-marketplace-limited-beta",
        "hobo-546-marketplace-installable",
      ],
    },
    {
      id: "wf-marketplace-search",
      surface: "search",
      title: "Search results with org-catalog filter and blocked-state explanation",
      personas: ["app developer", "workspace administrator", "security reviewer"],
      questionsAnswered: [
        "Which policy, trust, catalog, or evidence boundary removed or downgraded a search result?",
        "Can a reviewer see why ratings or publisher identity did not make the listing installable?",
      ],
      fixtureIds: ["hobo-546-marketplace-policy-blocked", "hobo-546-marketplace-preview-only"],
    },
    {
      id: "wf-marketplace-listing-detail",
      surface: "listing-detail",
      title: "Listing detail with trust evidence, stale warning, deprecation, and owner route",
      personas: ["app developer", "marketplace operator", "support operator"],
      questionsAnswered: [
        "Which evidence source, customer-safe message, and support handoff are visible on detail pages?",
        "When a listing is deprecated or stale, what migration or support action replaces install intent?",
      ],
      fixtureIds: ["hobo-546-marketplace-deprecated", "hobo-546-marketplace-yanked"],
    },
    {
      id: "wf-marketplace-installability-panel",
      surface: "installability-panel",
      title: "Installability outcome panel with customer-safe message and scope-out guard",
      personas: ["workspace administrator", "security reviewer", "support operator"],
      questionsAnswered: [
        "Does the panel have enough provenance, conformance, security, catalog, and policy evidence to show installability?",
        "What exact text is shown when install runtime, registry, policy, or support execution is out of scope?",
      ],
      fixtureIds: [
        "hobo-546-marketplace-installable",
        "hobo-546-marketplace-policy-blocked",
        "hobo-546-marketplace-yanked",
      ],
    },
  ],
  fixtures: FIXTURES,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "Browse and installability panel show one listing as installable only after all evidence sources exist.",
      fixtureIds: ["hobo-546-marketplace-installable"],
      proofModeLabels: ["reference fixture", "live"],
      accessibilityNote: "Keyboard focus reaches state, evidence source, owner route, and proof-mode chip in order.",
      safeOutcome: "show install intent copy while naming the evidence owner and fixture source",
    },
    {
      id: "blocked-path",
      narrative: "Policy-blocked and yanked listings keep state visible but suppress install intent.",
      fixtureIds: ["hobo-546-marketplace-policy-blocked", "hobo-546-marketplace-yanked"],
      proofModeLabels: ["reference fixture", "scope-out"],
      accessibilityNote: "Blocked and yanked states are text labels, not color-only badges.",
      safeOutcome: "route to org catalog or support owner without granting override",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "Preview-only and limited-beta listings carry missing-evidence language rather than optimistic install claims.",
      fixtureIds: ["hobo-546-marketplace-preview-only", "hobo-546-marketplace-limited-beta"],
      proofModeLabels: ["reference fixture", "simulated"],
      accessibilityNote: "Screen reader copy announces missing evidence and limited-beta status.",
      safeOutcome: "show warning copy and review owner before selection",
    },
    {
      id: "support-handoff",
      narrative: "Deprecated and yanked listings expose customer-safe support or migration wording.",
      fixtureIds: ["hobo-546-marketplace-deprecated", "hobo-546-marketplace-yanked"],
      proofModeLabels: ["reference fixture", "live"],
      accessibilityNote: "Responsive layout keeps support route and customer-safe message adjacent.",
      safeOutcome: "handoff support-safe deprecation or yank evidence with no live ticket creation",
    },
  ],
  accessibilityNotes: [
    "Keyboard order moves from browse/search result to listing detail and then installability panel actions.",
    "Screen reader labels include visible state, evidence source, owner route, proof mode, and support handoff.",
    "Contrast and text labels distinguish preview, beta, installable, blocked, deprecated, and yanked states without relying on color.",
    "Responsive layouts keep customer-safe message, org-catalog disposition, and owner route visible on narrow screens.",
    "Motion is optional; warning and status transitions must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No live storefront, browse/search service, marketplace service, or install runtime.",
    "No Registry storage, resolver, package hosting, signing, or install-time verification implementation.",
    "No ranking, recommendation, paid placement, monetization, payout, or commercial marketplace policy.",
    "No publisher portal workflow, evidence upload service, maintainer workflow, or submission tooling.",
    "No policy engine, RBAC runtime, scanner integration, conformance runner, or approval service implementation.",
    "No support tooling, notification delivery, launch publication, or customer-facing launch claim without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(live storefront|storefront|browse service|search service|marketplace service)\b/i,
  /\b(registry storage|resolver|package hosting|artifact signing|install-time verification)\b/i,
  /\b(install runtime|install service|production install)\b/i,
  /\b(ranking|recommendation|paid placement|monetization|payout|revenue)\b/i,
  /\b(publisher portal|publisher submission|evidence upload|maintainer workflow)\b/i,
  /\b(policy engine|rbac runtime|scanner integration|conformance runner|approval service)\b/i,
  /\b(support tooling|live ticket|notification delivery|launch readiness|launch claim|customer-facing claim)\b/i,
];

export type MarketplaceMockupRequestClassification = "in-scope-proof" | "scope-out";

export class VibeMarketplaceInstallabilityMockupsParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(
      `Vibe marketplace installability mockups failed parsing: ${errors
        .map((error) => error.code)
        .join(", ")}`,
    );
    this.name = "VibeMarketplaceInstallabilityMockupsParseError";
  }
}

export function parseVibeMarketplaceInstallabilityMockups(
  mockups: VibeMarketplaceInstallabilityMockups,
): ParsedVibeMarketplaceInstallabilityMockups {
  const validation = validateVibeMarketplaceInstallabilityMockups(mockups);

  if (!validation.ok) {
    throw new VibeMarketplaceInstallabilityMockupsParseError(validation.errors);
  }

  // SAFETY: `return mockups as ParsedVibeMarketplaceInstallabilityMockups;` is required at this I/O or test boundary.
  return mockups as ParsedVibeMarketplaceInstallabilityMockups;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeMarketplaceInstallabilityMockups(
  mockups: VibeMarketplaceInstallabilityMockups,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (mockups.issue !== "HOBO-546") {
    errors.push({ code: "wrong-issue", message: "mockup contract must pin HOBO-546" });
  }
  if (mockups.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "mockup contract must stay in M1" });
  }
  if (mockups.packagePath !== "src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (mockups.proofPath !== "docs/design/proofs/vibe-marketplace-installability-mockups/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(mockups.personas, REQUIRED_MARKETPLACE_PERSONAS)) {
    errors.push({ code: "missing-persona", message: "required persona set must be exact" });
  }

  validateQuickstartFixtureRefs(mockups.quickstartFixtureRefs, errors);

  if (!arraysEqual(mockups.wireframes.map((wireframe) => wireframe.surface), REQUIRED_MARKETPLACE_SURFACES)) {
    errors.push({
      code: "missing-wireframe-surface",
      message: "wireframes must cover browse, search, listing detail, and installability panel",
    });
  }

  const fixtureIds = new Set(mockups.fixtures.map((fixture) => fixture.fixtureId));
  const states = mockups.fixtures.map((fixture) => fixture.state);
  if (!arraysEqual(states, REQUIRED_MARKETPLACE_FIXTURE_STATES)) {
    errors.push({
      code: "missing-fixture-state",
      message: "fixtures must cover accepted marketplace installability states",
    });
  }

  for (const wireframe of mockups.wireframes) {
    if (wireframe.personas.length === 0 || wireframe.questionsAnswered.length === 0) {
      errors.push({
        code: "incomplete-wireframe",
        message: `${wireframe.id} must name personas and operating questions`,
      });
    }
    for (const fixtureId of wireframe.fixtureIds) {
      if (!fixtureIds.has(fixtureId)) {
        errors.push({
          code: "unknown-wireframe-fixture",
          message: `${wireframe.id} references missing ${fixtureId}`,
        });
      }
    }
  }

  for (const fixture of mockups.fixtures) {
    if (
      !fixture.visibleState ||
      !fixture.evidenceSource ||
      !fixture.ownerRoute ||
      !fixture.customerSafeMessage ||
      !fixture.orgCatalogDisposition ||
      !fixture.trustEvidence ||
      !fixture.supportHandoff
    ) {
      errors.push({
        code: "missing-fixture-metadata",
        message: `${fixture.fixtureId} must name visible state, evidence, owner, message, catalog disposition, trust, and support`,
      });
    }
    if (!REQUIRED_MARKETPLACE_PROOF_MODES.includes(fixture.proofMode)) {
      errors.push({
        code: "unsupported-proof-mode",
        message: `${fixture.fixtureId} uses unsupported proof mode`,
      });
    }
  }

  if (!arraysEqual(mockups.scenarioPaths.map((scenario) => scenario.id), REQUIRED_MARKETPLACE_SCENARIOS)) {
    errors.push({
      code: "missing-scenario-path",
      message: "scenario paths must cover happy, blocked, stale/unknown, and support handoff",
    });
  }

  for (const scenario of mockups.scenarioPaths) {
    if (!scenario.narrative || !scenario.safeOutcome || !scenario.accessibilityNote) {
      errors.push({
        code: "incomplete-scenario",
        message: `${scenario.id} must name narrative, accessibility, and safe outcome`,
      });
    }
    if (scenario.fixtureIds.length === 0 || scenario.proofModeLabels.length === 0) {
      errors.push({
        code: "empty-scenario-links",
        message: `${scenario.id} must link fixtures and proof modes`,
      });
    }
    for (const fixtureId of scenario.fixtureIds) {
      if (!fixtureIds.has(fixtureId)) {
        errors.push({
          code: "unknown-scenario-fixture",
          message: `${scenario.id} references missing ${fixtureId}`,
        });
      }
    }
    for (const proofMode of scenario.proofModeLabels) {
      if (!REQUIRED_MARKETPLACE_PROOF_MODES.includes(proofMode)) {
        errors.push({
          code: "unsupported-scenario-proof-mode",
          message: `${scenario.id} uses unsupported proof mode ${String(proofMode)}`,
        });
      }
    }
  }

  const scenarioProofModes = new Set(mockups.scenarioPaths.flatMap((scenario) => scenario.proofModeLabels));
  for (const proofMode of REQUIRED_MARKETPLACE_PROOF_MODES) {
    if (!scenarioProofModes.has(proofMode)) {
      errors.push({
        code: "missing-proof-mode-label",
        message: `scenario paths must include ${proofMode}`,
      });
    }
  }

  const accessibilityText = mockups.accessibilityNotes.join(" ").toLowerCase();
  for (const requirement of ["keyboard", "screen reader", "contrast", "responsive", "motion"]) {
    if (!accessibilityText.includes(requirement)) {
      errors.push({
        code: "missing-accessibility-note",
        message: `accessibility notes must include ${requirement}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyMarketplaceMockupRequest(
  summary: string,
): MarketplaceMockupRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary))
    ? "scope-out"
    : "in-scope-proof";
}

export function renderInstallabilitySummary(fixture: MarketplaceListingFixture): string {
  return [
    `state: ${fixture.state}`,
    `visible: ${fixture.visibleState}`,
    `evidence: ${fixture.evidenceSource}`,
    `owner: ${fixture.ownerRoute}`,
    `message: ${fixture.customerSafeMessage}`,
    `proof mode: ${fixture.proofMode}`,
  ].join("\n");
}

function validateQuickstartFixtureRefs(
  refs: readonly MarketplaceQuickstartFixtureReference[],
  errors: ValidationError[],
): void {
  if (!Array.isArray(refs)) {
    errors.push({
      code: "missing-quickstart-fixture-refs",
      message: "marketplace mockups must cite accepted HOBO-577 quickstart fixtures",
    });
    return;
  }

  const fixtureIds = refs.map((ref) => ref.fixtureId);
  if (!arraysEqual(fixtureIds, REQUIRED_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "marketplace mockups must cite required HOBO-577 fixture ids",
    });
  }

  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({
        code: "wrong-quickstart-source",
        message: `${ref.fixtureId} must cite HOBO-577`,
      });
    }
    if (!REQUIRED_MARKETPLACE_SURFACES.includes(ref.consumingSurface)) {
      errors.push({
        code: "unsupported-quickstart-consuming-surface",
        message: `${ref.fixtureId} targets unsupported surface`,
      });
    }
    if (!ref.marketplaceUse) {
      errors.push({
        code: "missing-quickstart-marketplace-use",
        message: `${ref.fixtureId} must explain marketplace consumption`,
      });
    }
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
