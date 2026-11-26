export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "compliance-review",
  "support-handoff",
]);

const REQUIRED_STATES = [
  "not-eligible",
  "eligible-for-review",
  "tax-documents-required",
  "payout-method-required",
  "approved-for-payout",
  "payout-held",
  "payout-disabled",
] as const;

const REQUIRED_EVIDENCE = [
  "publisher-eligibility-fixture",
  "payout-state-model",
  "tax-identity-handoff",
  "billing-reconciliation-handoff",
  "support-hold-reason-export",
  "scope-boundary-register",
] as const;

const FORBIDDEN_SCOPE_PATTERNS = [
  /live payout/i,
  /payout provider/i,
  /settlement/i,
  /money movement/i,
  /tax form/i,
  /tax document/i,
  /1099/i,
  /vat/i,
  /revenue[- ]share/i,
  /payout ui/i,
  /publisher portal/i,
  /marketplace storefront/i,
  /payment provider/i,
  /kyc/i,
  /kyb/i,
  /bank account/i,
  /tax engine/i,
];

type ScopeEvidence = {
  kind: string;
  owner: string;
  proofMode: string;
  source?: string;
  proves: string;
};

type InitiativeDependency = {
  owner?: string;
  consumes?: string;
  scopeBoundary?: string;
};

type DesignDependency = {
  source: string;
  reason: string;
};

type MarketplacePayoutHooksScope = {
  issue: string;
  project: string;
  phase: string;
  goal: string;
  personas: Array<{ role: string; need: string }>;
  scopeIn: string[];
  scopeOut: string[];
  nonGoals: string[];
  boundaries: Record<string, string>;
  dependencies: DesignDependency[];
  initiativeDependencies: InitiativeDependency[];
  payoutHookStates: string[];
  m1Evidence: ScopeEvidence[];
  followUpGate: {
    allowedAfter?: string;
    blockedBefore?: string;
  };
};

export const MARKETPLACE_PAYOUT_HOOKS_SCOPE: MarketplacePayoutHooksScope = {
  issue: "HOBO-420",
  project: "Marketplace Payout Hooks",
  phase: "M0",
  goal:
    "Define Marketplace Payout Hooks productization scope so publisher payout readiness, eligibility, tax/identity handoffs, payout hold reasons, billing reconciliation, and support boundaries are accepted before M1 design and contract proof work begins.",
  personas: [
    {
      role: "marketplace operator",
      need: "Know when a listing can expose payout-readiness status without promising settlement or live money movement.",
    },
    {
      role: "publisher owner",
      need: "Understand which identity, tax, support, and catalog evidence is needed before payout commitments can be discussed.",
    },
    {
      role: "billing/compliance owner",
      need: "Receive payout-adjacent evidence while tax, receipt, provider, and settlement decisions stay in the commercial compliance lane.",
    },
    {
      role: "support operator",
      need: "Explain payout eligibility, holds, disabled states, and unsupported states from customer-safe evidence.",
    },
    {
      role: "release owner",
      need: "Block paid marketplace or payout launch claims until the accepted M0 record and follow-up evidence exist.",
    },
  ],
  scopeIn: [
    "Publisher payout-readiness vocabulary for eligibility review, required tax/identity handoff, payout method handoff, approval, hold, disabled, and unsupported states.",
    "Evidence fields for publisher identity, listing trust tier, org catalog approval, payout owner route, hold reason, support wording, and billing reconciliation handoff.",
    "State model for payout-adjacent launch readiness that can be consumed by marketplace, publisher, billing, tax, org catalog, and support follow-up work.",
    "Customer-visible limitation wording for paid marketplace and payout claims until commercial provider, legal, tax, and support evidence are accepted.",
    "M1-ready evidence checklist for publisher eligibility fixtures, state model, tax identity handoff, billing reconciliation, support export, and scope boundary register.",
  ],
  scopeOut: [
    "No live payout provider integration, payout execution, settlement, bank account handling, or money movement.",
    "No tax form generation, tax document collection, automated tax decisioning, 1099/VAT workflow, or legal advice.",
    "No final revenue-share policy, paid publisher tier, marketplace monetization model, or commercial pricing decision.",
    "No marketplace storefront, publisher portal UI, payout UI, support console, or customer billing dashboard implementation.",
    "No payment provider, billing provider, KYC/KYB provider, fraud system, or compliance vendor integration.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace Capability Review & Approval or marketplace publisher trust evidence.",
    "Build payout settlement, tax, invoice, receipt, or payment-provider machinery.",
    "Approve paid marketplace launch claims for v1.",
    "Create downstream execution issues before M0 acceptance is recorded.",
  ],
  boundaries: {
    service:
      "Marketplace Payout Hooks M0 defines payout-readiness states, evidence fields, and owner handoffs; it does not build a payout service, ledger, provider integration, or settlement runtime.",
    ux:
      "UX scope is information architecture for future payout-readiness and limitation wording, not marketplace storefront, publisher portal, payout setup, or support-console screens.",
    security:
      "Security scope records identity, trust-tier, org-catalog, tax, and compliance evidence requirements without storing payment credentials, tax documents, or bank details.",
    support:
      "Support receives customer-safe payout status, hold reason, disabled reason, unsupported-state wording, and escalation owner; support tooling and SLAs remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/marketplace-publisher-trust-evidence.md",
      reason: "Defines publisher trust tiers and explicitly keeps paid marketplace and payout claims as launch limitations until evidence exists.",
    },
    {
      source: "docs/design/capability-review-approval.md",
      reason: "Defines review states, approval outcomes, trust-tier evidence, and security/conformance handoffs consumed before payout readiness can be visible.",
    },
    {
      source: "docs/design/org-catalogs.md",
      reason: "Defines private listing, catalog approval, policy, and support evidence that payout readiness must consume without taking catalog scope.",
    },
    {
      source: "docs/design/billing-launch-policy.md",
      reason: "Defines commercial billing lifecycle and provider boundaries while keeping money movement and payment providers out of this issue.",
    },
    {
      source: "docs/design/tax-currency-receipt-obligations.md",
      reason: "Defines tax, currency, receipt, invoice metadata, and marketplace payout tax-document limitations.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines customer-safe support escalation and gap-routing posture for payout holds, unsupported states, and release blockers.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0064",
      reason: "Keeps monetization mechanics outside HoBo's meta-cloud core; this M0 record is launch-readiness scope, not core platform behavior.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Marketplace Payout Hooks",
      consumes: "Owns accepted payout-readiness states, evidence checklist, and follow-up gate.",
      scopeBoundary: "This issue defines M0 scope and acceptance; it does not build payout execution.",
    },
    {
      owner: "Capability Review & Approval",
      consumes: "Provides review outcome, trust-tier, security, conformance, and yank/escalation evidence before payout readiness is visible.",
      scopeBoundary: "Review queues and approval service behavior remain in Capability Review & Approval.",
    },
    {
      owner: "Publisher Portal",
      consumes: "Uses required identity, tax, payout-method, and support wording in later publisher-facing flows.",
      scopeBoundary: "Publisher onboarding, forms, UI, and maintainer administration stay in Publisher Portal.",
    },
    {
      owner: "Billing & Credits",
      consumes: "Receives billing reconciliation, payment-provider, credit, refund, and invoice-adjacent handoff requirements.",
      scopeBoundary: "Billing plans, invoices, payment providers, refunds, and credit application remain Billing & Credits.",
    },
    {
      owner: "Tax, Currency, Receipt Obligations",
      consumes: "Owns tax identity, currency, receipt, unsupported jurisdiction, and payout-document posture.",
      scopeBoundary: "Tax documents, legal review, provider tax flows, and compliance claims stay outside this scope record.",
    },
    {
      owner: "Org Catalogs",
      consumes: "Uses catalog approval and private-listing state as prerequisites for publisher payout readiness.",
      scopeBoundary: "Catalog storage, approval workflow, policy enforcement, and registry handoff remain Org Catalogs.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses hold reason, disabled reason, unsupported-state wording, and escalation owner for customer-safe support.",
      scopeBoundary: "Support queues, SLAs, ticket automation, and incident communications stay outside this issue.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses accepted M0 scope to decide when payout follow-up issues can be created.",
      scopeBoundary: "Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope.",
    },
  ],
  payoutHookStates: [...REQUIRED_STATES],
  m1Evidence: [
    {
      kind: "publisher-eligibility-fixture",
      owner: "marketplace operator",
      proofMode: "reference-fixture",
      source: "docs/design/marketplace-payout-hooks.md#publisher-payout-readiness-states",
      proves: "Publisher trust, catalog approval, and review state prerequisites are visible before payout readiness is claimed.",
    },
    {
      kind: "payout-state-model",
      owner: "marketplace operator",
      proofMode: "contract-test",
      source: "docs/design/marketplace-payout-hooks.md#publisher-payout-readiness-states",
      proves: "Not eligible, review, required handoff, approved, held, and disabled states are deterministic.",
    },
    {
      kind: "tax-identity-handoff",
      owner: "billing/compliance owner",
      proofMode: "compliance-review",
      source: "docs/design/tax-currency-receipt-obligations.md#launch-mode-mapping",
      proves: "Tax identity and payout-document requirements are explicit handoffs, not implemented in payout scope.",
    },
    {
      kind: "billing-reconciliation-handoff",
      owner: "billing/compliance owner",
      proofMode: "design-record",
      source: "docs/design/billing-launch-policy.md#provider-integration-boundary",
      proves: "Billing and provider assumptions are named without payout execution or settlement machinery.",
    },
    {
      kind: "support-hold-reason-export",
      owner: "support operator",
      proofMode: "support-handoff",
      source: "docs/design/launch-support-escalation.md#gap-routing",
      proves: "Support can route holds, disabled states, and unsupported claims to named owners with safe wording.",
    },
    {
      kind: "scope-boundary-register",
      owner: "release owner",
      proofMode: "design-record",
      source: "docs/design/marketplace-payout-hooks.md#scope-out-and-non-goals",
      proves: "Live payout provider, settlement, tax, UI, KYC/KYB, and revenue-share implementation work stays out.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this Marketplace Payout Hooks scope record is accepted.",
  },
};

export function canCreateMarketplacePayoutFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validateMarketplacePayoutHooksScope(scope: MarketplacePayoutHooksScope) {
  const errors: string[] = [];

  if (scope.issue !== "HOBO-420") {
    errors.push("issue must be HOBO-420");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("marketplace payout hooks")) {
    errors.push("goal must name marketplace payout hooks");
  }
  if (!scope.goal?.toLowerCase().includes("publisher payout readiness")) {
    errors.push("goal must name publisher payout readiness");
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
    "docs/design/billing-launch-policy.md",
    "docs/design/tax-currency-receipt-obligations.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
  ];
  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(requiredSources)) {
    errors.push("design dependencies must map to marketplace, approval, catalog, billing, tax, support, and scope ADR sources");
  }

  if ((scope.initiativeDependencies ?? []).length < 8) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const state of REQUIRED_STATES) {
    if (!(scope.payoutHookStates ?? []).includes(state)) {
      errors.push(`payout state missing: ${state}`);
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
