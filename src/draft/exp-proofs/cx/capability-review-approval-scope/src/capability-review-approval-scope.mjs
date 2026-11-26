export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "security-review",
  "support-handoff",
]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /marketplace review ui/i,
  /publisher portal ui/i,
  /storefront/i,
  /install-flow ux/i,
  /paid publisher/i,
  /payout/i,
  /monetization/i,
  /revenue/i,
  /live registry/i,
  /registry storage/i,
  /security scanner/i,
  /scanner integration/i,
  /policy engine/i,
  /approval service implementation/i,
  /trust[- ]badge/i,
];

export const CAPABILITY_REVIEW_APPROVAL_SCOPE = {
  issue: "HOBO-423",
  project: "Capability Review & Approval",
  phase: "M0",
  goal:
    "Define Capability Review & Approval productization scope so review queue states, approval policy, trust tiers, security/conformance checks, rating-signal boundaries, yanking, and escalation evidence are accepted before M1 design and contract proof work begins.",
  personas: [
    {
      role: "marketplace operator",
      need: "Run review intake, triage, approval, rejection, and yanking without unclear policy ownership.",
    },
    {
      role: "security reviewer",
      need: "Require security and conformance evidence before any installability or curated trust claim is made.",
    },
    {
      role: "platform engineer",
      need: "Know which Registry, curated catalog, policy, and capability-spec contracts downstream implementation consumes.",
    },
    {
      role: "publisher owner",
      need: "Understand what evidence a publisher must supply and why identity or ratings alone do not grant installability.",
    },
    {
      role: "support operator",
      need: "Trace approval, rejection, yank, and escalation decisions to customer-safe support evidence.",
    },
  ],
  scopeIn: [
    "Canonical review queue states from submission through triage, evidence requests, approval, rejection, yank, and escalation.",
    "Approval policy matrix distinguishing limited-beta, installable, rejected, yanked, and escalated outcomes.",
    "Trust-tier evidence requirements for publisher identity, artifact provenance, conformance, security review, customer warning, and deprecation/yank behavior.",
    "Security and conformance checklist handoffs to Registry distribution, SBOM/vulnerability evidence, curated catalogs, org catalogs, and support.",
    "Rating-signal boundary that records ratings as advisory only, never as security, conformance, provenance, or curation proof.",
    "M1-ready evidence checklist for review state model, approval matrix, trust-tier fixtures, security/conformance checklist, yanking, escalation, and rating-signal boundaries.",
  ],
  scopeOut: [
    "No marketplace review UI, publisher portal UI, storefront, install-flow UX, or support tooling implementation.",
    "No monetization, paid publisher tier, payout, revenue-share, or commercial marketplace behavior.",
    "No live Registry storage, artifact signing, provider-backed catalog storage, or package hosting implementation.",
    "No security scanner integration, vulnerability feed integration, or conformance runner implementation.",
    "No policy engine enforcement, approval service implementation, RBAC runtime, or customer-facing trust badge renderer.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace the existing marketplace publisher trust evidence contract.",
    "Build Registry distribution, curated catalog policy, trust-tier policy, or org catalog enforcement.",
    "Approve paid marketplace or payout claims for v1.",
    "Create downstream execution issues before M0 acceptance is recorded.",
  ],
  boundaries: {
    service:
      "Capability Review & Approval M0 defines accepted review states, approval evidence, handoffs, and ownership boundaries; it does not build the review service, Registry storage, scanner integration, or policy runtime.",
    ux:
      "UX scope is the future information contract for review states, outcomes, and customer warnings, not marketplace screens, publisher flows, storefronts, or install UI.",
    security:
      "Security scope names mandatory security/conformance review evidence and fail-closed installability boundaries without implementing scanners, conformance runners, RBAC, or policy engines.",
    support:
      "Support receives decision lineage, rejection/yank reasons, escalation routes, and customer-safe limitation wording; support queues, SLA, and incident workflows remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/marketplace-publisher-trust-evidence.md",
      reason: "Defines publisher trust tiers, required review evidence, unsupported claims, and customer-visible launch limitations consumed by this M0 scope.",
    },
    {
      source: "docs/design/sbom-vulnerability-notice-evidence.md",
      reason: "Defines SBOM, vulnerability, provenance, and notice evidence classes for marketplace/capability bundles.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0062",
      reason: "Pins Registry distribution as signed, certified artifacts rather than ad hoc marketplace installability.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins org governance and mandatory policy as dependencies for approval decisions without implementing policy enforcement here.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0075",
      reason: "Defines interface stability tiers and capability-spec evidence consumed by review decisions.",
    },
    {
      source: "src/draft/technical-proofs/curated-catalog-policy-contract/README.md",
      reason: "Defines curated catalog approval/revoke behavior consumed as downstream enforcement, not owned by this scope record.",
    },
    {
      source: "src/draft/technical-proofs/trust-tier-policy-contract/README.md",
      reason: "Defines minimum trust-tier can-deploy policy consumed by review outcomes without making ratings sufficient for safety.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Capability Review & Approval",
      consumes: "Owns accepted review states, approval outcomes, evidence checklist, and follow-up gate.",
      scopeBoundary: "This issue defines M0 scope and acceptance; it does not build the review service.",
    },
    {
      owner: "Publisher Portal",
      consumes: "Uses evidence requirements and rejection/yank reasons for later publisher submission flows.",
      scopeBoundary: "Publisher onboarding, submission UI, and maintainer administration stay in Publisher Portal.",
    },
    {
      owner: "Marketplace UX",
      consumes: "Uses customer warning, trust-tier display, and installability outcome language.",
      scopeBoundary: "Marketplace browse/search/install UX and trust badge rendering stay in Marketplace UX.",
    },
    {
      owner: "Org Catalogs",
      consumes: "Uses approved/yanked outcomes to decide what org-approved catalogs may include.",
      scopeBoundary: "Catalog inheritance, policy enforcement, and org approval workflows stay in Org Catalogs.",
    },
    {
      owner: "Registry Distribution",
      consumes: "Uses certification, provenance, and listing lifecycle requirements from review outcomes.",
      scopeBoundary: "Registry storage, artifact pull/publish, signatures, and version resolution remain Registry-owned.",
    },
    {
      owner: "Security Verification",
      consumes: "Uses mandatory security/conformance evidence and escalation classes.",
      scopeBoundary: "Scanner integration, threat review execution, and vulnerability exceptions stay in Security Verification.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses rejection, yank, escalation, and customer-warning lineage for triage and handoff.",
      scopeBoundary: "Support queues, SLAs, escalation workflows, and incident communications stay outside this issue.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses accepted M0 scope to decide when M1-M4 follow-up issues can be created.",
      scopeBoundary: "Release go/no-go and downstream issue creation remain release-program scope.",
    },
  ],
  reviewStates: [
    "submitted",
    "triage",
    "evidence-required",
    "approved-limited-beta",
    "approved-installable",
    "rejected",
    "yanked",
    "escalated",
  ],
  approvalOutcomes: [
    {
      id: "limited-beta",
      customerVisible: true,
      ownerRoute: "Capability Review & Approval",
      customerMessage: "Capability is limited-beta until security, conformance, and curation evidence are complete.",
    },
    {
      id: "installable",
      customerVisible: true,
      ownerRoute: "Capability Review & Approval",
      customerMessage: "Capability is installable only with required provenance, conformance, security review, and catalog approval.",
    },
    {
      id: "rejected",
      customerVisible: false,
      ownerRoute: "Security Verification",
      customerMessage: "Rejected capability is not presented as installable.",
    },
    {
      id: "yanked",
      customerVisible: true,
      ownerRoute: "Registry Distribution",
      customerMessage: "Yanked capability is removed from new selection and routed to support or migration guidance.",
    },
    {
      id: "escalated",
      customerVisible: false,
      ownerRoute: "Support Workflow",
      customerMessage: "Escalated capability review requires a named owner before customer-facing claims change.",
    },
  ],
  m1Evidence: [
    {
      kind: "review-queue-state-model",
      owner: "marketplace operator",
      proofMode: "design-record",
      source: "docs/design/capability-review-approval.md#review-queue-states",
      proves: "Review states and allowed transitions are explicit before service implementation begins.",
    },
    {
      kind: "approval-policy-matrix",
      owner: "marketplace operator",
      proofMode: "reference-fixture",
      source: "docs/design/capability-review-approval.md#approval-outcomes",
      proves: "Limited-beta, installable, rejected, yanked, and escalated outcomes map to owners and customer wording.",
    },
    {
      kind: "trust-tier-evidence-fixture",
      owner: "publisher owner",
      proofMode: "contract-test",
      source: "docs/design/marketplace-publisher-trust-evidence.md",
      proves: "Publisher identity, provenance, conformance, security review, deprecation/yank, and warnings are present.",
    },
    {
      kind: "security-conformance-checklist",
      owner: "security reviewer",
      proofMode: "security-review",
      source: "docs/design/sbom-vulnerability-notice-evidence.md",
      proves: "Installability claims are blocked until security and conformance evidence exists.",
    },
    {
      kind: "yank-escalation-handoff",
      owner: "support operator",
      proofMode: "support-handoff",
      source: "src/draft/technical-proofs/curated-catalog-policy-contract/README.md",
      proves: "Yank, revoke, and escalation outcomes have support and catalog handoff evidence.",
    },
    {
      kind: "rating-signal-boundary",
      owner: "platform engineer",
      proofMode: "design-record",
      source: "src/draft/technical-proofs/trust-tier-policy-contract/README.md",
      proves: "Ratings are advisory and cannot substitute for identity, provenance, conformance, security review, or curation.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this Capability Review & Approval scope record is accepted.",
  },
};

export function canCreateCapabilityReviewFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validateCapabilityReviewApprovalScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-423") {
    errors.push("issue must be HOBO-423");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("capability review")) {
    errors.push("goal must name capability review");
  }
  if (!scope.goal?.toLowerCase().includes("approval")) {
    errors.push("goal must name approval");
  }
  if ((scope.personas ?? []).length < 4) {
    errors.push("at least four personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 5) {
    errors.push("scope out must have at least five entries");
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
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0075",
    "src/draft/technical-proofs/curated-catalog-policy-contract/README.md",
    "src/draft/technical-proofs/trust-tier-policy-contract/README.md",
  ];
  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(requiredSources)) {
    errors.push("design dependencies must map to marketplace trust, SBOM, registry, governance, stability, curated catalog, and trust-tier policy sources");
  }

  if ((scope.initiativeDependencies ?? []).length < 8) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const state of [
    "submitted",
    "triage",
    "evidence-required",
    "approved-limited-beta",
    "approved-installable",
    "rejected",
    "yanked",
    "escalated",
  ]) {
    if (!(scope.reviewStates ?? []).includes(state)) {
      errors.push(`review state missing: ${state}`);
    }
  }

  for (const outcome of ["limited-beta", "installable", "rejected", "yanked", "escalated"]) {
    if (!(scope.approvalOutcomes ?? []).some((entry) => entry.id === outcome)) {
      errors.push(`approval outcome missing: ${outcome}`);
    }
  }

  for (const evidence of [
    "review-queue-state-model",
    "approval-policy-matrix",
    "trust-tier-evidence-fixture",
    "security-conformance-checklist",
    "yank-escalation-handoff",
    "rating-signal-boundary",
  ]) {
    if (!(scope.m1Evidence ?? []).some((entry) => entry.kind === evidence)) {
      errors.push(`m1 evidence missing: ${evidence}`);
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

  for (const outcome of scope.approvalOutcomes ?? []) {
    if (outcome.customerVisible && (!outcome.customerMessage || !outcome.ownerRoute)) {
      errors.push(`customer-visible approval outcome ${outcome.id ?? "<unknown>"} must name customer message and owner route`);
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
