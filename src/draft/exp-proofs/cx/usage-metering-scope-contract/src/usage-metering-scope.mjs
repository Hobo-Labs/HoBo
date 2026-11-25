export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "audit-fixture",
  "support-handoff",
  "privacy-review",
]);

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /invoice generation/i,
  /live invoice/i,
  /payment/i,
  /refund/i,
  /billing provider/i,
  /provider billing sync/i,
  /entitlement enforcement/i,
  /dispatcher/i,
  /cost routing/i,
  /credit ledger/i,
  /production metering pipeline/i,
  /live customer usage/i,
  /tax/i,
  /chargeback/i,
];

export const USAGE_METERING_SCOPE = {
  issue: "HOBO-417",
  project: "Usage Metering",
  phase: "M0",
  goal:
    "Define Usage Metering productization scope so usage facts, metering dimensions, showback evidence, reconciliation inputs, and support/audit boundaries are accepted before M1 design and contract proof work begins.",
  personas: [
    {
      role: "finops owner",
      need: "Explain tenant, project, run, resource, and generation usage as showback evidence without depending on live billing.",
    },
    {
      role: "platform engineer",
      need: "Know which event families and dimensions downstream metering designs can rely on before building projections.",
    },
    {
      role: "billing/support operator",
      need: "Trace disputed usage from invoice-adjacent summaries back to replayable facts and support handoff evidence.",
    },
    {
      role: "security/compliance reviewer",
      need: "Confirm usage evidence preserves privacy, redaction, retention, and audit boundaries before customer exposure.",
    },
  ],
  scopeIn: [
    "Canonical usage fact classes for control-plane operations, runtime compute, storage, egress, generation runs, and support adjustments.",
    "Attribution dimension matrix for tenant, workspace, project, environment, Camp, Bindle, run, agent, team, resource, and reporting period.",
    "Metering event evidence contract naming source event family, idempotency key, deduplication key, replay sequence, and redaction requirement.",
    "Reconciliation handoff from usage facts to billing launch policy and support dispute evidence without generating invoices.",
    "M1-ready evidence checklist for meter event catalog, dimension matrix, reconciliation fixtures, privacy/redaction policy, and support dispute handoff.",
  ],
  scopeOut: [
    "No invoice generation, payment collection, refund application, credit application, or tax calculation.",
    "No entitlement enforcement, hard quota gate, rate limit, abuse response, or fraud response.",
    "No Dispatcher/CreditLedger routing, reservation compare-and-swap, or maximize-credits selection.",
    "No live provider billing API sync, provider credential storage, or production metering pipeline.",
    "No live customer usage data, customer-visible bill, or final legal/compliance launch claim.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace the existing cost-signal contract.",
    "Build the MeteringView projection or event ingestion runtime.",
    "Settle financial account balances or prepaid credit ledgers.",
    "Approve launch pricing, packaging, taxes, or customer billing terms.",
  ],
  boundaries: {
    service:
      "Usage Metering M0 defines accepted facts, dimensions, evidence, and ownership boundaries; it does not build the projection service, event ingestion, or persistence layer.",
    ux:
      "UX scope is the future information contract for showback, reconciliation, and support evidence, not a customer-visible bill or dashboard implementation.",
    security:
      "Usage facts must name retention, privacy, redaction, and replay/audit requirements without exposing live customer usage or provider billing credentials.",
    support:
      "Support receives dispute-ready fact lineage, adjustment classes, and reconciliation handoff rules; ticket routing, SLAs, and payment corrections remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/reliability-observability-cost.md#plan-05",
      reason: "Defines MeteringView, usage dimensions, showback, quota, and cost-signal concepts consumed by this M0 scope.",
    },
    {
      source: "docs/design/data-plane.md#plan-11",
      reason: "Defines event-log and replay behavior that metering evidence must preserve without building a new runtime.",
    },
    {
      source: "docs/design/billing-launch-policy.md",
      reason: "Defines launch billing boundaries consumed as reconciliation handoff, while invoice/payment work remains out of scope.",
    },
    {
      source: "docs/design/tax-currency-receipt-obligations.md",
      reason: "Defines legal/tax boundaries that metering must not silently absorb inside M0.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0039",
      reason: "Separates showback and quota policy from billing-engine implementation.",
    },
    {
      source: "docs/design/adr/01-architecture-core.md#adr-0071",
      reason: "Pins Dispatcher/CreditLedger cost signals as a dependency, not usage metering scope.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Usage Metering",
      consumes: "Owns accepted usage fact classes, attribution dimensions, evidence checklist, and follow-up gate.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build the metering projection.",
    },
    {
      owner: "Billing & Credits",
      consumes: "Uses reconciled usage facts as invoice-adjacent evidence and dispute support.",
      scopeBoundary: "Invoice generation, payment, refund, credit application, and tax remain in Billing & Credits.",
    },
    {
      owner: "Entitlements & Plan Limits",
      consumes: "Uses usage categories and counts for later plan-limit policy design.",
      scopeBoundary: "Entitlement enforcement, quota gates, and abuse handling stay in Entitlements & Plan Limits.",
    },
    {
      owner: "Compliance Evidence Pack",
      consumes: "Uses retention, privacy, redaction, and replay/audit summaries for assurance evidence.",
      scopeBoundary: "Legal approval, formal compliance claims, and customer assurance packets stay in Compliance Evidence Pack.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses fact lineage, reconciliation fixtures, and adjustment evidence for disputes.",
      scopeBoundary: "Support queues, SLAs, escalation, and payment correction workflows stay in Support Workflow.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses the accepted M0 record to decide when M1-M4 follow-up issues may be created.",
      scopeBoundary: "Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope.",
    },
  ],
  meteringFactClasses: [
    {
      id: "control-plane-operation",
      owner: "platform engineer",
      sourceEventFamily: "deployment.*",
      sensitive: false,
    },
    {
      id: "runtime-compute-second",
      owner: "platform engineer",
      sourceEventFamily: "run.*",
      sensitive: false,
    },
    {
      id: "storage-gb-month",
      owner: "finops owner",
      sourceEventFamily: "resource.*",
      sensitive: false,
    },
    {
      id: "egress-gb",
      owner: "finops owner",
      sourceEventFamily: "resource.*",
      sensitive: false,
    },
    {
      id: "generation-run",
      owner: "platform engineer",
      sourceEventFamily: "gen.*",
      sensitive: true,
    },
    {
      id: "support-adjustment",
      owner: "billing/support operator",
      sourceEventFamily: "meter.*",
      sensitive: true,
    },
  ],
  requiredDimensions: [
    "tenant",
    "workspace",
    "project",
    "environment",
    "camp",
    "bindle",
    "run",
    "agent",
    "team",
    "resource",
    "period",
  ],
  m1Evidence: [
    {
      kind: "meter-event-fact-catalog",
      owner: "platform engineer",
      proofMode: "design-record",
      source: "docs/design/usage-metering.md#metering-fact-classes",
      proves: "Each accepted usage fact class names owner, source event family, sensitivity, and excluded implementation scope.",
    },
    {
      kind: "usage-dimension-matrix",
      owner: "finops owner",
      proofMode: "reference-fixture",
      source: "docs/design/usage-metering.md#usage-dimension-matrix",
      proves: "Showback dimensions cover tenant, project, run, resource, team, Camp, Bindle, and reporting period attribution.",
    },
    {
      kind: "reconciliation-fixture",
      owner: "billing/support operator",
      proofMode: "contract-test",
      source: "docs/design/usage-metering.md#evidence-required-for-m1",
      proves: "Usage facts can reconcile into billing-policy/support evidence without generating invoices.",
    },
    {
      kind: "privacy-redaction-policy",
      owner: "security/compliance reviewer",
      proofMode: "privacy-review",
      source: "docs/design/usage-metering.md#service-ux-security-and-support-boundaries",
      proves: "Usage evidence declares retention, redaction, replay, and live-data exclusion boundaries.",
    },
    {
      kind: "support-dispute-handoff",
      owner: "billing/support operator",
      proofMode: "support-handoff",
      source: "docs/design/usage-metering.md#owning-initiative-dependencies",
      proves: "Support can trace disputed usage to fact lineage and adjustment evidence without owning billing corrections.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this Usage Metering scope record is accepted.",
  },
};

export function canCreateUsageMeteringFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validateUsageMeteringScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-417") {
    errors.push("issue must be HOBO-417");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("usage metering")) {
    errors.push("goal must name usage metering");
  }
  if (!scope.goal?.toLowerCase().includes("showback")) {
    errors.push("goal must name showback");
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
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/data-plane.md#plan-11",
    "docs/design/billing-launch-policy.md",
    "docs/design/tax-currency-receipt-obligations.md",
    "docs/design/adr/02-identity-security.md#adr-0039",
    "docs/design/adr/01-architecture-core.md#adr-0071",
  ];
  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(requiredSources)) {
    errors.push("design dependencies must map to cost, data-plane, billing, tax, showback, and credit-ledger sources");
  }

  if ((scope.initiativeDependencies ?? []).length < 6) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  if ((scope.meteringFactClasses ?? []).length < 5) {
    errors.push("metering fact classes must include control-plane, runtime, storage, egress, and generation facts");
  }

  for (const dimension of ["tenant", "project", "run", "resource", "period"]) {
    if (!(scope.requiredDimensions ?? []).includes(dimension)) {
      errors.push(`required dimension missing: ${dimension}`);
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
