export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;

type Boundary = (typeof REQUIRED_BOUNDARIES)[number];

type ProofMode =
  | "design-record"
  | "contract-test"
  | "reference-fixture"
  | "security-review"
  | "support-handoff"
  | "release-gate";

interface Persona {
  role: string;
  need: string;
}

interface Dependency {
  source: string;
  reason: string;
}

interface InitiativeDependency {
  owner: string;
  consumes: string;
  scopeBoundary: string;
}

interface EvidenceItem {
  kind: string;
  owner: string;
  proofMode: ProofMode;
  source?: string;
  proves: string;
}

interface CustomerVisibleStatus {
  id: string;
  customerVisible: boolean;
  ownerRoute?: string;
  customerMessage?: string;
  proofSource?: string;
}

interface FollowUpGate {
  allowedAfter: string;
  blockedBefore: string;
}

interface PublisherPortalScope {
  issue: string;
  project: string;
  phase: string;
  goal: string;
  personas: Persona[];
  scopeIn: string[];
  scopeOut: string[];
  nonGoals: string[];
  boundaries: Record<Boundary, string>;
  dependencies: Dependency[];
  initiativeDependencies: InitiativeDependency[];
  portalStates: string[];
  customerVisibleStatuses: CustomerVisibleStatus[];
  m1Evidence: EvidenceItem[];
  followUpGate: FollowUpGate;
}

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const VALID_PROOF_MODES = new Set<ProofMode>([
  "design-record",
  "contract-test",
  "reference-fixture",
  "security-review",
  "support-handoff",
  "release-gate",
]);

const REQUIRED_DEPENDENCIES = [
  "docs/design/marketplace-publisher-trust-evidence.md",
  "docs/design/capability-review-approval.md",
  "docs/design/marketplace-payout-hooks.md",
  "docs/design/org-catalogs.md",
  "docs/design/billing-launch-policy.md",
  "docs/design/launch-support-escalation.md",
  "docs/design/adr/07-portability-extensibility.md#adr-0062",
  "docs/design/adr/02-identity-security.md#adr-0074",
  "docs/design/adr/07-portability-extensibility.md#adr-0064",
];

const REQUIRED_PORTAL_STATES = [
  "draft-profile",
  "identity-pending",
  "evidence-required",
  "ready-for-review",
  "limited-beta-visible",
  "installable-visible",
  "rejected",
  "yanked",
  "payout-readiness-blocked",
  "support-escalated",
] as const;

const REQUIRED_M1_EVIDENCE = [
  "publisher-profile-fixture",
  "maintainer-permission-matrix",
  "submission-evidence-envelope",
  "review-status-projection",
  "payout-readiness-handoff",
  "support-escalation-handoff",
  "scope-boundary-register",
] as const;

const FORBIDDEN_SCOPE_PATTERNS = [
  /\breact\b/i,
  /\bpublisher portal ui\b/i,
  /\bportal screens?\b/i,
  /\bui implementation\b/i,
  /\breview approval service\b/i,
  /\bapproval service\b/i,
  /\bsecurity scanner\b/i,
  /\bscanner integration\b/i,
  /\blive registry\b/i,
  /\bregistry storage\b/i,
  /\bpublish\/pull runtime\b/i,
  /\bmarketplace storefront\b/i,
  /\binstall-flow ux\b/i,
  /\btrust[- ]badge\b/i,
  /\bpayout provider\b/i,
  /\bpayout integration\b/i,
  /\bbank account\b/i,
  /\btax document\b/i,
  /\brevenue[- ]share\b/i,
  /\bbilling dashboard\b/i,
  /\binvoice\b/i,
  /\bpayment provider\b/i,
  /\bsupport ticket\b/i,
  /\bticket automation\b/i,
];

export const PUBLISHER_PORTAL_SCOPE: PublisherPortalScope = {
  issue: "HOBO-422",
  project: "Publisher Portal",
  phase: "M0",
  goal:
    "Define Publisher Portal productization scope so publisher identity, maintainer administration, listing submission evidence, review status, payout-readiness handoffs, support wording, and launch limitations are accepted before M1 design and contract proof work begins.",
  personas: [
    {
      role: "publisher owner",
      need: "Know which publisher profile, organization identity, listing evidence, and maintainer responsibilities must exist before a portal workflow is designed.",
    },
    {
      role: "publisher maintainer",
      need: "Understand which listing draft, evidence upload, review status, and yank/rejection messages are visible without gaining approval authority.",
    },
    {
      role: "marketplace operator",
      need: "Route publisher submissions into review, catalog, payout-readiness, and support owners without the portal becoming the decision engine.",
    },
    {
      role: "security reviewer",
      need: "Require provenance, conformance, SBOM, vulnerability, and security-review evidence before installability or trust claims are visible.",
    },
    {
      role: "support operator",
      need: "Explain rejected, yanked, escalated, and payout-blocked states with customer-safe owner routes and limitation wording.",
    },
    {
      role: "release owner",
      need: "Block publisher portal launch claims and follow-up issue fan-out until the accepted M0 record and proof requirements exist.",
    },
  ],
  scopeIn: [
    "Publisher profile and organization identity fields needed for future publisher onboarding, verification, support routing, and review intake.",
    "Maintainer role vocabulary for owner, maintainer, reviewer-contact, billing-contact, and support-contact responsibilities.",
    "Listing submission evidence envelope for capability metadata, artifact provenance, capability spec, SBOM/vulnerability notice, conformance report, and customer-visible warning text.",
    "Review-status projection vocabulary for submitted, evidence-required, limited-beta, installable, rejected, yanked, and escalated states consumed from Capability Review & Approval.",
    "Payout-readiness handoff fields that show eligibility, blocked reason, tax/identity owner, and unsupported payout limitations without executing payouts.",
    "Support-safe status messages, owner routes, and limitation wording for publisher, marketplace, support, and release handoff surfaces.",
    "M1-ready proof checklist for profile fixture, maintainer permission matrix, evidence envelope, review projection, payout handoff, support handoff, and scope boundary register.",
  ],
  scopeOut: [
    "No React implementation, publisher portal UI, portal screens, design system work, or frontend routing.",
    "No review approval service, security scanner integration, conformance runner implementation, or approval policy enforcement.",
    "No live Registry storage, package hosting, artifact publish/pull runtime, signing service, or Registry distribution implementation.",
    "No marketplace storefront, install-flow UX, trust-badge renderer, search, browse, or customer purchase flow.",
    "No payout provider integration, tax document collection, bank account handling, settlement, revenue-share, or money movement.",
    "No billing dashboard, invoice flow, payment-provider integration, refund handling, or commercial pricing decision.",
    "No support ticket queue, SLA automation, incident communication, or customer support console implementation.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace Capability Review & Approval or Marketplace Publisher Trust Evidence.",
    "Build marketplace UI, publisher portal UI, Registry runtime, billing, payouts, support tooling, or review decisioning.",
    "Approve paid marketplace, payout, installability, or trust-badge launch claims for v1.",
    "Create downstream execution issues before M0 acceptance is recorded.",
  ],
  boundaries: {
    service:
      "Publisher Portal M0 defines accepted publisher profile, maintainer role, listing evidence, review-status, payout-readiness, and support handoff records; it does not build portal services, approval services, Registry storage, payout execution, billing, or support tooling.",
    ux:
      "UX scope is information architecture, status vocabulary, and customer-safe wording for future publisher-facing flows, not screens, routing, forms, trust badges, storefronts, or design-system implementation.",
    security:
      "Security scope records required identity, provenance, SBOM, vulnerability, conformance, and review evidence before customer-visible claims can appear, without implementing scanners, RBAC enforcement, policy engines, or credential handling.",
    support:
      "Support receives rejection, yank, escalation, payout-blocked, and unsupported-state wording with owner routes; support queues, SLAs, incident communications, and ticket automation remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/marketplace-publisher-trust-evidence.md",
      reason: "Defines publisher trust tiers, required evidence, unsupported claims, and customer-visible limitations consumed by portal status wording.",
    },
    {
      source: "docs/design/capability-review-approval.md",
      reason: "Defines review states, approval outcomes, yanking, escalation, and rating-signal boundaries consumed by portal projections.",
    },
    {
      source: "docs/design/marketplace-payout-hooks.md",
      reason: "Defines payout-readiness states and tax/identity handoffs that the portal may show without taking payout execution scope.",
    },
    {
      source: "docs/design/org-catalogs.md",
      reason: "Defines org catalog approvals and private listing boundaries consumed by publisher listing visibility.",
    },
    {
      source: "docs/design/billing-launch-policy.md",
      reason: "Defines commercial billing boundaries so publisher portal scope does not build pricing, invoices, payment providers, or refunds.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines customer-safe support escalation and gap-routing posture for rejected, yanked, escalated, and unsupported publisher states.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0062",
      reason: "Pins Registry distribution as signed, certified artifacts rather than ad hoc portal publishing.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins org governance and mandatory policy as dependencies for publisher and maintainer authority without implementing enforcement here.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0064",
      reason: "Keeps monetization mechanics outside HoBo's meta-cloud core; this M0 record is launch-readiness scope, not commercial marketplace behavior.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Publisher Portal",
      consumes: "Owns accepted publisher profile, maintainer role, submission evidence, status projection, and follow-up gate.",
      scopeBoundary: "This issue defines M0 scope and acceptance; it does not build the portal UI or backend.",
    },
    {
      owner: "Capability Review & Approval",
      consumes: "Provides review outcomes, evidence requests, approvals, rejections, yanks, and escalation states for portal status projection.",
      scopeBoundary: "Review queues, approval service behavior, and security decisioning remain in Capability Review & Approval.",
    },
    {
      owner: "Marketplace Publisher Trust Evidence",
      consumes: "Provides trust-tier evidence and unsupported-claim wording for publisher-facing listing status.",
      scopeBoundary: "Trust-tier policy and evidence validation remain in Marketplace Publisher Trust Evidence.",
    },
    {
      owner: "Marketplace Payout Hooks",
      consumes: "Provides payout-readiness and blocked-reason handoffs for future publisher-facing display.",
      scopeBoundary: "Payout execution, tax documents, provider integration, and settlement stay outside Publisher Portal.",
    },
    {
      owner: "Org Catalogs",
      consumes: "Uses publisher and listing status when private catalog approval and org visibility decisions are later designed.",
      scopeBoundary: "Catalog approval workflow, policy enforcement, and Registry handoff remain Org Catalogs.",
    },
    {
      owner: "Billing & Credits",
      consumes: "Receives billing-contact and commercial-boundary handoffs without the portal building invoices or payments.",
      scopeBoundary: "Plans, invoices, payments, refunds, credits, and billing reconciliation remain Billing & Credits.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses rejected, yanked, escalated, unsupported, and payout-blocked owner routes for customer-safe support.",
      scopeBoundary: "Support queues, SLAs, automation, and incident communications stay outside this issue.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses accepted M0 scope to decide when M1-M4 publisher portal follow-up issues can be created.",
      scopeBoundary: "Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope.",
    },
  ],
  portalStates: [...REQUIRED_PORTAL_STATES],
  customerVisibleStatuses: [
    {
      id: "limited-beta-visible",
      customerVisible: true,
      ownerRoute: "Capability Review & Approval",
      customerMessage: "Publisher listing is visible only as limited beta until required review evidence is complete.",
      proofSource: "docs/design/capability-review-approval.md#approval-outcomes",
    },
    {
      id: "installable-visible",
      customerVisible: true,
      ownerRoute: "Capability Review & Approval",
      customerMessage: "Publisher listing can be shown as installable only with required provenance, conformance, security review, and catalog approval.",
      proofSource: "docs/design/marketplace-publisher-trust-evidence.md",
    },
    {
      id: "rejected",
      customerVisible: true,
      ownerRoute: "Security Verification",
      customerMessage: "Rejected listing is not presented as installable and routes to the review owner for remediation.",
      proofSource: "docs/design/capability-review-approval.md#approval-outcomes",
    },
    {
      id: "yanked",
      customerVisible: true,
      ownerRoute: "Registry Distribution",
      customerMessage: "Yanked listing is removed from new selection and routed to support or migration guidance.",
      proofSource: "docs/design/capability-review-approval.md#approval-outcomes",
    },
    {
      id: "payout-readiness-blocked",
      customerVisible: false,
      ownerRoute: "Marketplace Payout Hooks",
      customerMessage: "Payout readiness is blocked until required identity, tax, payout, or support evidence exists.",
      proofSource: "docs/design/marketplace-payout-hooks.md#publisher-payout-readiness-states",
    },
    {
      id: "support-escalated",
      customerVisible: false,
      ownerRoute: "Support Workflow",
      customerMessage: "Escalated publisher status requires a named owner before customer-facing claims change.",
      proofSource: "docs/design/launch-support-escalation.md",
    },
  ],
  m1Evidence: [
    {
      kind: "publisher-profile-fixture",
      owner: "publisher owner",
      proofMode: "reference-fixture",
      source: "docs/design/publisher-portal.md#publisher-profile-and-maintainer-records",
      proves: "Publisher organization identity, contacts, ownership, and support route fields are explicit before portal implementation begins.",
    },
    {
      kind: "maintainer-permission-matrix",
      owner: "publisher maintainer",
      proofMode: "design-record",
      source: "docs/design/publisher-portal.md#publisher-profile-and-maintainer-records",
      proves: "Maintainer roles are named without granting review, policy, billing, payout, or support authority.",
    },
    {
      kind: "submission-evidence-envelope",
      owner: "security reviewer",
      proofMode: "contract-test",
      source: "docs/design/publisher-portal.md#listing-submission-evidence-envelope",
      proves: "Listing submissions name provenance, capability spec, SBOM, vulnerability, conformance, warning, and support evidence.",
    },
    {
      kind: "review-status-projection",
      owner: "marketplace operator",
      proofMode: "contract-test",
      source: "docs/design/capability-review-approval.md#review-queue-states",
      proves: "Portal-visible statuses are projections of review decisions, not independent portal decisions.",
    },
    {
      kind: "payout-readiness-handoff",
      owner: "marketplace operator",
      proofMode: "design-record",
      source: "docs/design/marketplace-payout-hooks.md#publisher-payout-readiness-states",
      proves: "Payout readiness appears only as a handoff state with blocked reasons and owner route.",
    },
    {
      kind: "support-escalation-handoff",
      owner: "support operator",
      proofMode: "support-handoff",
      source: "docs/design/launch-support-escalation.md",
      proves: "Rejected, yanked, escalated, and unsupported states include customer-safe wording and support owner routes.",
    },
    {
      kind: "scope-boundary-register",
      owner: "release owner",
      proofMode: "release-gate",
      source: "docs/design/publisher-portal.md#scope-out-and-non-goals",
      proves: "Portal UI, review service, Registry storage, payout, billing, support, and follow-up scope stays blocked until M0 acceptance.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this Publisher Portal scope record is accepted.",
  },
};

export function canCreatePublisherPortalFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function validatePublisherPortalScope(scope: PublisherPortalScope) {
  const errors: string[] = [];

  if (scope.issue !== "HOBO-422") {
    errors.push("issue must be HOBO-422");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("publisher portal")) {
    errors.push("goal must name publisher portal");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 6) {
    errors.push("scope in must have at least six entries");
  }
  if ((scope.scopeOut ?? []).length < 7) {
    errors.push("scope out must have at least seven entries");
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

  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(REQUIRED_DEPENDENCIES)) {
    errors.push("design dependencies must map to marketplace trust, capability review, payout, catalogs, billing, support, registry, governance, and scope ADR sources");
  }

  if ((scope.initiativeDependencies ?? []).length < 8) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const state of REQUIRED_PORTAL_STATES) {
    if (!(scope.portalStates ?? []).includes(state)) {
      errors.push(`portal state missing: ${state}`);
    }
  }

  for (const evidenceKind of REQUIRED_M1_EVIDENCE) {
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

  for (const status of scope.customerVisibleStatuses ?? []) {
    if (status.customerVisible && (!status.customerMessage || !status.ownerRoute || !status.proofSource)) {
      errors.push(`customer-visible status ${status.id ?? "<unknown>"} must name customer message, owner route, and proof source`);
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
