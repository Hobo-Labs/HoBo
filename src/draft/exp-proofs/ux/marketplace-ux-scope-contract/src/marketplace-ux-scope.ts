export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "accessibility-review",
  "support-handoff",
  "launch-claim-review",
]);

const REQUIRED_LISTING_STATES = [
  "not-visible",
  "preview-only",
  "limited-beta",
  "installable",
  "blocked-by-policy",
  "deprecated",
  "yanked",
];

const REQUIRED_EVIDENCE = [
  "browse-taxonomy-fixture",
  "installability-outcome-matrix",
  "trust-warning-copy-register",
  "org-catalog-filter-fixture",
  "accessibility-usability-checklist",
  "support-handoff-export",
  "scope-boundary-register",
];

const REQUIRED_OUTCOMES = [
  "not-shown",
  "preview-with-warning",
  "installable-with-evidence",
  "blocked-by-policy",
  "deprecated-with-guidance",
  "yanked-support-route",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /live storefront/i,
  /storefront implementation/i,
  /install runtime/i,
  /install service/i,
  /registry storage/i,
  /live registry/i,
  /ratings? ranking/i,
  /recommendation algorithm/i,
  /paid placement/i,
  /monetization/i,
  /payout/i,
  /revenue/i,
  /publisher portal ui/i,
  /publisher onboarding/i,
  /artifact signing/i,
  /policy engine/i,
  /rbac runtime/i,
  /scanner integration/i,
  /support tooling/i,
];

export const MARKETPLACE_UX_SCOPE = {
  issue: "HOBO-421",
  project: "Marketplace UX",
  phase: "M0",
  goal:
    "Define Marketplace UX productization scope so browse, search, installability, trust warnings, org-catalog visibility, accessibility, support, and launch-claim evidence are accepted before M1 design and contract proof work begins.",
  personas: [
    {
      role: "app developer",
      need: "Discover approved capabilities and understand whether a listing is preview-only, installable, blocked, deprecated, or yanked before acting.",
    },
    {
      role: "workspace administrator",
      need: "See which marketplace entries are allowed by org catalog and policy without granting Marketplace UX authority over approvals.",
    },
    {
      role: "marketplace operator",
      need: "Present listing state, trust tier, warnings, and limitation copy without overstating installability or registry guarantees.",
    },
    {
      role: "security reviewer",
      need: "Confirm installability wording depends on review, provenance, conformance, and policy evidence rather than ratings or popularity.",
    },
    {
      role: "support operator",
      need: "Route blocked, deprecated, yanked, and unsupported listings to customer-safe next actions and named owner lanes.",
    },
  ],
  scopeIn: [
    "Marketplace browse, search, detail, warning, and install-intent information architecture for v1 launch surfaces.",
    "Listing state vocabulary for hidden, preview-only, limited-beta, installable, policy-blocked, deprecated, and yanked entries.",
    "Customer-safe trust, review, org-catalog, security, conformance, deprecation, yank, and support wording requirements.",
    "Installability outcome matrix that names owner route, evidence source, and customer message before any visible install claim.",
    "Accessibility and usability evidence expectations for marketplace install, trust, warning, and review flows.",
    "M1-ready evidence checklist for browse taxonomy, outcome fixtures, warning copy, org-catalog filters, accessibility checks, support handoff, and scope boundaries.",
  ],
  scopeOut: [
    "No live storefront, browse/search implementation, marketplace service, or install runtime.",
    "No Registry storage, artifact signing, package hosting, resolver, or install-time verification implementation.",
    "No rating ranking, recommendation algorithm, paid placement, monetization, payout, revenue-share, or commercial marketplace policy.",
    "No publisher portal UI, publisher onboarding, evidence upload, maintainer workflow, or submission tooling.",
    "No policy engine, RBAC runtime, security scanner integration, conformance runner, or approval service implementation.",
    "No support tooling, notification delivery, incident communication, or public launch-site implementation.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace Capability Review & Approval, marketplace publisher trust evidence, or org catalog ownership.",
    "Build a customer-facing marketplace UI or implementation runtime.",
    "Make unreviewed listings installable through popularity, ratings, publisher identity, or signed provenance alone.",
    "Create downstream execution issues before M0 acceptance is recorded.",
  ],
  boundaries: {
    service:
      "Marketplace UX M0 defines information architecture, listing states, visible outcome semantics, and evidence handoffs; it does not build marketplace services, Registry storage, resolver, or install runtime.",
    ux:
      "UX scope is accepted surface contract, copy, state, and accessibility evidence for later screens; no browse, search, detail, install, badge, or publisher workflow is implemented here.",
    security:
      "Security scope requires trust, provenance, conformance, review, policy, and owner evidence before visible installability claims; scanners, policy engines, RBAC, and approval runtime stay elsewhere.",
    support:
      "Support receives customer-safe blocked, deprecated, yanked, unsupported, and escalation wording with owner routes; queues, SLAs, notifications, and incident communications remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/marketplace-publisher-trust-evidence.md",
      reason: "Defines publisher trust tiers, required evidence, warning text, and launch limitations consumed by marketplace presentation.",
    },
    {
      source: "docs/design/capability-review-approval.md",
      reason: "Defines review states, approval outcomes, yanking, escalation, and installability evidence consumed before UX can show install claims.",
    },
    {
      source: "docs/design/org-catalogs.md",
      reason: "Defines approved catalog kinds, entry states, org visibility, policy pins, and support handoffs consumed by marketplace filters.",
    },
    {
      source: "docs/design/accessibility-usability-launch-baseline.md",
      reason: "Names Marketplace UX as the owner for install, trust, warning, and review flow accessibility evidence.",
    },
    {
      source: "docs/design/product-notifications-lifecycle.md",
      reason: "Defines marketplace and publisher lifecycle notification ownership and support-visible delivery evidence for later communication work.",
    },
    {
      source: "docs/design/launch-messaging-claims.md",
      reason: "Requires launch claims to have evidence owner, source, risk, and state before public publication.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0062",
      reason: "Pins Registry distribution as signed, certified artifacts; Marketplace UX may present trust state but cannot replace registry guarantees.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins org governance and mandatory policy rules as dependencies for visibility and installability decisions.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Marketplace UX",
      consumes: "Owns accepted browse taxonomy, visible listing states, installability wording, warning copy, evidence checklist, and follow-up gate.",
      scopeBoundary: "This issue defines M0 scope and acceptance; it does not build marketplace screens or services.",
    },
    {
      owner: "Capability Review & Approval",
      consumes: "Provides review state, approval outcome, yanking, escalation, and customer-warning evidence before visible installability claims.",
      scopeBoundary: "Review queues, approval policy, and review service behavior remain Capability Review & Approval.",
    },
    {
      owner: "Marketplace Publisher Trust Evidence",
      consumes: "Provides trust tier, publisher identity, provenance, conformance, security review, and warning evidence.",
      scopeBoundary: "Trust evidence records and publisher review evidence remain outside Marketplace UX.",
    },
    {
      owner: "Org Catalogs",
      consumes: "Provides approved entry state, scope, policy, version pin, and support handoff for workspace-visible marketplace filtering.",
      scopeBoundary: "Catalog storage, approval workflow, registry handoff, and policy enforcement stay in Org Catalogs.",
    },
    {
      owner: "Publisher Portal",
      consumes: "Uses marketplace warning and listing-state language for later publisher-facing submission and remediation flows.",
      scopeBoundary: "Publisher onboarding, evidence upload, maintainer administration, and portal UI stay in Publisher Portal.",
    },
    {
      owner: "Registry Distribution",
      consumes: "Provides signed artifact, certification, provenance, version, deprecation, and yank evidence consumed by marketplace presentation.",
      scopeBoundary: "Registry storage, artifact pull/publish, signatures, resolver, and install verification remain Registry-owned.",
    },
    {
      owner: "Accessibility & Usability Quality",
      consumes: "Provides required keyboard, focus, semantic, contrast, responsive, reduced-motion, screen-reader, state, and copy checks for marketplace surfaces.",
      scopeBoundary: "Accessibility baseline defines evidence and severity; it does not own every Marketplace UX remediation.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses blocked, deprecated, yanked, unsupported, and escalation messages with owner routes and customer-safe next actions.",
      scopeBoundary: "Support queues, SLAs, ticket automation, incident communications, and notification delivery stay outside this issue.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses accepted M0 scope to decide when M1-M4 follow-up issues and public marketplace claims can be created.",
      scopeBoundary: "Release go/no-go, cutline decisions, launch-site copy, and downstream issue creation remain release-program scope.",
    },
  ],
  listingStates: [...REQUIRED_LISTING_STATES],
  installabilityOutcomes: [
    {
      id: "not-shown",
      customerVisible: false,
      ownerRoute: "Capability Review & Approval",
      evidenceSource: "docs/design/capability-review-approval.md#review-queue-states",
      customerMessage: "Listing is not visible until required review and catalog evidence exists.",
    },
    {
      id: "preview-with-warning",
      customerVisible: true,
      ownerRoute: "Marketplace Publisher Trust Evidence",
      evidenceSource: "docs/design/marketplace-publisher-trust-evidence.md#launch-limitations",
      customerMessage: "Listing is preview-only and cannot be presented as installable.",
    },
    {
      id: "installable-with-evidence",
      customerVisible: true,
      ownerRoute: "Capability Review & Approval",
      evidenceSource: "docs/design/capability-review-approval.md#approval-outcomes",
      customerMessage: "Listing is installable only with required provenance, conformance, security review, catalog, and policy evidence.",
    },
    {
      id: "blocked-by-policy",
      customerVisible: true,
      ownerRoute: "Org Catalogs",
      evidenceSource: "docs/design/org-catalogs.md#entry-states",
      customerMessage: "Listing is blocked for this org or workspace by catalog, policy, trust, or approval state.",
    },
    {
      id: "deprecated-with-guidance",
      customerVisible: true,
      ownerRoute: "Registry Distribution",
      evidenceSource: "docs/design/org-catalogs.md#entry-states",
      customerMessage: "Listing remains visible only for migration guidance and existing-use explanation.",
    },
    {
      id: "yanked-support-route",
      customerVisible: true,
      ownerRoute: "Support Workflow",
      evidenceSource: "docs/design/capability-review-approval.md#review-queue-states",
      customerMessage: "Listing is yanked from new selection and routed to support or migration guidance.",
    },
  ],
  m1Evidence: [
    {
      kind: "browse-taxonomy-fixture",
      owner: "marketplace operator",
      proofMode: "reference-fixture",
      source: "docs/design/marketplace-ux.md#marketplace-listing-states",
      proves: "Browse/search/detail surfaces can distinguish preview, installable, blocked, deprecated, and yanked listings.",
    },
    {
      kind: "installability-outcome-matrix",
      owner: "marketplace operator",
      proofMode: "contract-test",
      source: "docs/design/marketplace-ux.md#installability-outcomes",
      proves: "Visible install claims require owner route, evidence source, and customer-safe wording.",
    },
    {
      kind: "trust-warning-copy-register",
      owner: "security reviewer",
      proofMode: "launch-claim-review",
      source: "docs/design/marketplace-publisher-trust-evidence.md#launch-limitations",
      proves: "Trust, review, rating, and launch-limit wording cannot overstate security or installability.",
    },
    {
      kind: "org-catalog-filter-fixture",
      owner: "workspace administrator",
      proofMode: "reference-fixture",
      source: "docs/design/org-catalogs.md#required-entry-evidence",
      proves: "Workspace marketplace visibility consumes org catalog scope, policy, version, and support evidence.",
    },
    {
      kind: "accessibility-usability-checklist",
      owner: "Accessibility & Usability Quality",
      proofMode: "accessibility-review",
      source: "docs/design/accessibility-usability-launch-baseline.md#required-checks",
      proves: "Marketplace install, trust, warning, and review flows name required accessibility and usability checks.",
    },
    {
      kind: "support-handoff-export",
      owner: "support operator",
      proofMode: "support-handoff",
      source: "docs/design/product-notifications-lifecycle.md#required-notification-classes",
      proves: "Blocked, deprecated, yanked, unsupported, and lifecycle messages have owner and support-visible evidence.",
    },
    {
      kind: "scope-boundary-register",
      owner: "release owner",
      proofMode: "design-record",
      source: "docs/design/marketplace-ux.md#scope-out-and-non-goals",
      proves: "Live marketplace UI, install runtime, registry, monetization, publisher portal, scanner, policy, and support tooling stay out.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this Marketplace UX scope record is accepted.",
  },
};

export function canCreateMarketplaceUxFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validateMarketplaceUxScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-421") {
    errors.push("issue must be HOBO-421");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("marketplace ux")) {
    errors.push("goal must name Marketplace UX");
  }
  if (!scope.goal?.toLowerCase().includes("browse")) {
    errors.push("goal must name browse");
  }
  if (!scope.goal?.toLowerCase().includes("install")) {
    errors.push("goal must name install");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 6) {
    errors.push("scope out must have at least six entries");
  }

  for (const key of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }

  for (const entry of scope.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  const requiredSources = [
    "docs/design/marketplace-publisher-trust-evidence.md",
    "docs/design/capability-review-approval.md",
    "docs/design/org-catalogs.md",
    "docs/design/accessibility-usability-launch-baseline.md",
    "docs/design/product-notifications-lifecycle.md",
    "docs/design/launch-messaging-claims.md",
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/02-identity-security.md#adr-0074",
  ];
  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(requiredSources)) {
    errors.push("design dependencies must map to marketplace trust, review, org catalog, accessibility, notifications, launch claims, registry, and governance sources");
  }

  if ((scope.initiativeDependencies ?? []).length < 9) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const state of REQUIRED_LISTING_STATES) {
    if (!(scope.listingStates ?? []).includes(state)) {
      errors.push(`listing state missing: ${state}`);
    }
  }

  for (const outcome of REQUIRED_OUTCOMES) {
    if (!(scope.installabilityOutcomes ?? []).some((entry) => entry.id === outcome)) {
      errors.push(`installability outcome missing: ${outcome}`);
    }
  }

  for (const outcome of scope.installabilityOutcomes ?? []) {
    if (outcome.customerVisible && (!outcome.customerMessage || !outcome.ownerRoute || !outcome.evidenceSource)) {
      errors.push(`customer-visible installability outcome ${outcome.id ?? "<unknown>"} must name customer message, owner route, and evidence source`);
    }
  }

  for (const evidenceKind of REQUIRED_EVIDENCE) {
    if (!(scope.m1Evidence ?? []).some((evidence) => evidence.kind === evidenceKind)) {
      errors.push(`m1 evidence missing: ${evidenceKind}`);
    }
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves || !evidence.source) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner, source, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if (!scope.followUpGate?.allowedAfter || !scope.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
