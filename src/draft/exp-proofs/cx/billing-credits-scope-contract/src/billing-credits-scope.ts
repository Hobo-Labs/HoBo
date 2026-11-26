import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;

const REQUIRED_DEPENDENCIES = [
  "docs/design/reliability-observability-cost.md#plan-05",
  "docs/design/contracts-policy-flags.md#plan-29",
  "docs/design/governance-planes.md#plan-46",
  "docs/design/adr/04-governance-verification.md#adr-0039",
  "HOBO-417",
  "HOBO-489",
  "HOBO-490",
  "HOBO-513",
] as const;

const REQUIRED_M1_EVIDENCE = [
  "commercial-scope-map",
  "billing-lifecycle-state-model",
  "credit-ledger-and-entitlement-boundary",
  "usage-to-invoice-reconciliation-inputs",
  "customer-visible-billing-limitations",
  "support-and-audit-handoff",
] as const;

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "support-handoff",
  "legal-review",
  "audit-record",
]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /\bimplement\b.*\b(live|stripe|payment|checkout|tax|metering|quota|entitlement|pricing|invoice)\b/i,
  /live\s+(stripe|payment|checkout|billing)\s+provider/i,
  /\bstripe\b/i,
  /\bpayment\s+provider\b/i,
  /\btax\s+(engine|calculation|filing|collection)\b/i,
  /\bvat\b/i,
  /\busage\s+metering\s+(pipeline|implementation|service)\b/i,
  /\bmeter\s+usage\s+events\b/i,
  /\bquota\s+enforcement\b/i,
  /\bentitlement\s+enforcement\b/i,
  /\bfinal\s+pricing\b/i,
  /\bpricing\s+pages?\b/i,
  /\binvoice\s+rendering\b/i,
  /\bcharge\s+customers?\b/i,
  /\bstore\s+payment\s+credentials?\b/i,
];

type BoundaryKey = (typeof REQUIRED_BOUNDARIES)[number];
type ProofMode =
  | "design-record"
  | "contract-test"
  | "reference-fixture"
  | "support-handoff"
  | "legal-review"
  | "audit-record";

type TextRecord = {
  id?: string;
  owner?: string;
  message?: string;
  source?: string;
  reason?: string;
  role?: string;
  need?: string;
  consumes?: string;
  scopeBoundary?: string;
  kind?: string;
  proofMode?: ProofMode;
  proves?: string;
};

export type BillingCreditsScope = {
  issue: string;
  project: string;
  phase: string;
  goal: string;
  personas: Array<Required<Pick<TextRecord, "role" | "need">>>;
  scopeIn: string[];
  scopeOut: string[];
  nonGoals: string[];
  boundaries: Record<BoundaryKey, string>;
  dependencies: Array<Required<Pick<TextRecord, "source" | "reason">>>;
  initiativeDependencies: Array<Required<Pick<TextRecord, "owner" | "consumes" | "scopeBoundary">>>;
  customerVisibleLimitations: Array<Required<Pick<TextRecord, "id" | "message" | "owner">>>;
  m1Evidence: Array<Required<Pick<TextRecord, "kind" | "owner" | "proofMode" | "source" | "proves">>>;
  followUpGate: {
    allowedAfter: string;
    blockedBefore: string;
  };
};

export type BillingCreditsDecisionClassification = {
  owner: string;
  inScope: boolean;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export type ParsedBillingCreditsScope = BillingCreditsScope & {
  readonly parsed: true;
};

export const BILLING_CREDITS_SCOPE: BillingCreditsScope = {
  issue: "HOBO-418",
  project: "Billing & Credits",
  phase: "M0",
  goal:
    "Define Billing & Credits productization scope so commercial launch decisions, credit behavior, billing lifecycle evidence, and customer-visible limits are explicit before M1 design and contract proof begins.",
  personas: [
    {
      role: "workspace owner",
      need: "Understand which billing modes, credit limits, invoices, payment states, and visible limitations can affect a workspace before paid launch.",
    },
    {
      role: "platform engineer",
      need: "Know which commercial boundaries are platform-owned and which usage, entitlement, tax, support, or legal surfaces must remain outside this M0 record.",
    },
    {
      role: "billing operator",
      need: "Trace billing lifecycle states, credit corrections, invoice evidence, and support-safe audit records without relying on provider dashboards.",
    },
    {
      role: "support engineer",
      need: "Route payment, invoice, credit, tax, and entitlement questions to the owning initiative with customer-safe messages and evidence references.",
    },
    {
      role: "security and compliance reviewer",
      need: "Verify that payment credentials, tax posture, legal approvals, audit evidence, and customer-visible limitations are not hidden behind implementation claims.",
    },
  ],
  scopeIn: [
    "Accepted commercial scope map for trial, paid plan, manual invoice, prepaid credit, correction, and suspension states.",
    "Boundary record for where Billing & Credits owns launch policy versus Usage Metering, Entitlements, Tax/Currency/Receipts, Support, Legal/Privacy, and Release Cutline ownership.",
    "M1 evidence checklist for billing lifecycle state model, customer-visible limitations, credit/entitlement handoff, invoice reconciliation inputs, and audit/support handoff.",
    "Customer-visible limitation table for no-charge beta, paid GA prerequisites, manual invoicing, prepaid credits, and unsupported commercial states.",
    "Follow-up gate that blocks M1-M4 billing, credit, provider, tax, metering, or entitlement implementation until M0 scope and acceptance are recorded.",
  ],
  scopeOut: [
    "No live payment provider, checkout, webhook, invoice rendering, payout, refund, charge, or settlement integration.",
    "No usage metering pipeline, metering source-of-truth, invoice line-item computation, or provider billing reconciliation.",
    "No entitlement enforcement, quota enforcement, plan-limit runtime gate, or deployment-time policy execution.",
    "No tax engine, VAT/sales-tax calculation, currency expansion, receipt delivery, filing, or jurisdiction decisioning.",
    "No final pricing page, public price list, sales packaging, launch marketing copy, or customer contract terms.",
    "No storage or handling of payment credentials, tax identifiers, or live customer billing data.",
    "No M1-M4 design or implementation issue creation before this M0 record is accepted.",
  ],
  nonGoals: [
    "Replace HOBO-489 billing launch policy details.",
    "Replace HOBO-490 usage-to-invoice reconciliation contract.",
    "Replace HOBO-513 tax, currency, receipt, and unsupported-jurisdiction obligations.",
    "Approve paid GA, tax collection, or live payment processing without cutline and legal evidence.",
  ],
  boundaries: {
    service:
      "Billing & Credits M0 defines accepted commercial lifecycle scope, handoff records, and evidence requirements; it does not build payment, invoice, tax, metering, entitlement, or provider services.",
    ux:
      "UX scope is customer-visible billing state, limitation, and support message shape, not final pricing pages, checkout screens, invoice rendering, or marketing copy.",
    security:
      "Security scope records credential, tax identifier, audit, and provider assumptions; no payment credentials, tax identifiers, live provider secrets, or customer billing data are stored here.",
    support:
      "Support receives owner routes, customer-safe messages, audit evidence pointers, and limitation categories; support queues, SLAs, refunds, and escalation execution remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/reliability-observability-cost.md#plan-05",
      reason: "Connects billing and credits to cost, quota, and spend-governance posture without taking runtime enforcement scope.",
    },
    {
      source: "docs/design/contracts-policy-flags.md#plan-29",
      reason: "Pins policy-decision and entitlement boundaries that billing may inform but does not execute in M0.",
    },
    {
      source: "docs/design/governance-planes.md#plan-46",
      reason: "Supplies audit, governance, and customer-visible evidence expectations for commercial decisions.",
    },
    {
      source: "docs/design/adr/04-governance-verification.md#adr-0039",
      reason: "Records billing, quota, and cost governance as a verified launch concern.",
    },
    {
      source: "HOBO-417",
      reason: "Usage Metering owns source usage facts and metering boundaries consumed by future invoice evidence.",
    },
    {
      source: "HOBO-489",
      reason: "Billing launch policy owns concrete plans, lifecycle states, provider assumptions, refunds, and credits.",
    },
    {
      source: "HOBO-490",
      reason: "Usage-to-invoice reconciliation owns line item mapping, late events, corrections, disputes, and audit records.",
    },
    {
      source: "HOBO-513",
      reason: "Tax, currency, receipt, and unsupported-jurisdiction obligations must gate paid launch claims.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Billing & Credits",
      consumes: "Owns the accepted commercial scope map, lifecycle state families, credit boundary, customer-visible limitations, and follow-up gate.",
      scopeBoundary: "This issue defines M0 scope and acceptance; live billing implementation waits for later accepted issues.",
    },
    {
      owner: "Usage Metering",
      consumes: "Provides source usage facts and metering evidence for later invoices and credits.",
      scopeBoundary: "Meter collection, aggregation, dedupe, and invoiceable quantity computation remain outside Billing & Credits M0.",
    },
    {
      owner: "Entitlements & Plan Limits",
      consumes: "Uses billing and credit state as inputs to future runtime gates.",
      scopeBoundary: "Quota, plan-limit, and deployment-time enforcement behavior stays outside this M0 record.",
    },
    {
      owner: "Tax, Currency & Receipt Obligations",
      consumes: "Defines customer-visible tax, receipt, currency, and jurisdiction blockers for paid launch.",
      scopeBoundary: "Tax calculation, receipt delivery, currency expansion, and legal review remain outside this M0 record.",
    },
    {
      owner: "Support Workflow",
      consumes: "Receives customer-safe billing state, owner route, audit pointer, and safe next action.",
      scopeBoundary: "Support queues, refund execution, SLA policy, and escalation process stay in Support Workflow.",
    },
    {
      owner: "V1 Legal, Privacy & Terms Readiness",
      consumes: "Provides terms, refund, privacy, and billing-data obligations required before paid launch claims.",
      scopeBoundary: "Legal approvals, contract terms, privacy notices, and tax/legal decisions are not authored here.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses accepted scope, blockers, limitations, and evidence gaps to decide beta and GA readiness.",
      scopeBoundary: "Release go/no-go, customer launch claims, and risk acceptance remain release-program scope.",
    },
  ],
  customerVisibleLimitations: [
    {
      id: "limitation.no-live-provider",
      message: "This M0 record does not enable live checkout, payment, invoice, refund, or payout behavior.",
      owner: "Billing & Credits",
    },
    {
      id: "limitation.no-tax-claim",
      message: "Paid launch cannot claim tax, VAT, receipt, or currency readiness until HOBO-513 evidence is accepted.",
      owner: "Tax, Currency & Receipt Obligations",
    },
    {
      id: "limitation.no-metered-invoice-claim",
      message: "Metered invoice claims require accepted usage-metering and usage-to-invoice evidence before customer use.",
      owner: "Usage Metering",
    },
    {
      id: "limitation.entitlement-handoff-only",
      message: "Billing state may inform future entitlements but does not enforce quota or plan limits here.",
      owner: "Entitlements & Plan Limits",
    },
  ],
  m1Evidence: [
    {
      kind: "commercial-scope-map",
      owner: "Billing & Credits",
      proofMode: "design-record",
      source: "docs/design/billing-credits.md#commercial-scope-map",
      proves: "Trial, paid plan, manual invoice, prepaid credit, correction, suspension, and unsupported commercial states have owners and boundaries.",
    },
    {
      kind: "billing-lifecycle-state-model",
      owner: "Billing & Credits",
      proofMode: "contract-test",
      source: "src/draft/exp-proofs/cx/billing-launch-policy-contract",
      proves: "Billing lifecycle states carry customer message, support action, audit evidence, and entitlement impact.",
    },
    {
      kind: "credit-ledger-and-entitlement-boundary",
      owner: "Entitlements & Plan Limits",
      proofMode: "contract-test",
      source: "src/draft/technical-proofs/credit-ledger-view-contract",
      proves: "Credits and entitlement gates have explicit handoff fields without hidden runtime enforcement in Billing & Credits M0.",
    },
    {
      kind: "usage-to-invoice-reconciliation-inputs",
      owner: "Usage Metering",
      proofMode: "reference-fixture",
      source: "HOBO-490",
      proves: "Usage facts, late events, duplicates, disputes, and corrections are named before invoice evidence is promised.",
    },
    {
      kind: "customer-visible-billing-limitations",
      owner: "Billing & Credits",
      proofMode: "legal-review",
      source: "HOBO-513",
      proves: "Paid launch limitations name unsupported tax/currency/receipt states and customer-safe wording owners.",
    },
    {
      kind: "support-and-audit-handoff",
      owner: "Support Workflow",
      proofMode: "support-handoff",
      source: "docs/design/governance-planes.md#plan-46",
      proves: "Support receives safe owner routing, evidence references, and audit pointers for billing and credit states.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 billing, credit, payment-provider, usage-metering, entitlement, tax, support, and release follow-up issues must wait until this scope record is accepted.",
  },
};

export function canCreateBillingCreditsFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}): boolean {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function classifyBillingCreditsDecision(text: string): BillingCreditsDecisionClassification {
  const normalized = text.toLowerCase();

  if (/\b(meter|usage|invoiceable|line item|reconciliation)\b/.test(normalized)) {
    return { owner: "Usage Metering", inScope: false };
  }
  if (/\b(quota|entitlement|plan limit|deployment time|enforce)\b/.test(normalized)) {
    return { owner: "Entitlements & Plan Limits", inScope: false };
  }
  if (/\b(tax|vat|currency|receipt|jurisdiction)\b/.test(normalized)) {
    return { owner: "Tax, Currency & Receipt Obligations", inScope: false };
  }
  if (/\b(legal|terms|privacy|contract)\b/.test(normalized)) {
    return { owner: "V1 Legal, Privacy & Terms Readiness", inScope: false };
  }
  if (/\b(support|ticket|refund execution|escalation)\b/.test(normalized)) {
    return { owner: "Support Workflow", inScope: false };
  }
  return { owner: "Billing & Credits", inScope: true };
}

export function parseBillingCreditsScope(input: JsonValue): ParsedBillingCreditsScope {
  const result = validateBillingCreditsScope(input);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  // SAFETY: `return Object.freeze({ ...(input as BillingCreditsScope), parsed: true as const ` is required at this I/O or test boundary.
  return Object.freeze({ ...(input as BillingCreditsScope), parsed: true as const });
}

export function validateBillingCreditsScope(input: JsonValue): ValidationResult {
  const errors: string[] = [];

  if (!input || !isJsonObject(input)) {
    return { ok: false, errors: ["billing and credits scope record is required"] };
  }

  // SAFETY: `const record = input as BillingCreditsScope;` is required at this I/O or test boundary.
  const record = input as BillingCreditsScope;
  if (record.issue !== "HOBO-418") {
    errors.push("issue must be HOBO-418");
  }
  if (record.project !== "Billing & Credits") {
    errors.push("project must be Billing & Credits");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!/billing/i.test(record.goal ?? "") || !/credits/i.test(record.goal ?? "")) {
    errors.push("goal must name Billing & Credits");
  }
  if ((record.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((record.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((record.scopeOut ?? []).length < 6) {
    errors.push("scope out must have at least six entries");
  }
  if ((record.nonGoals ?? []).length < 4) {
    errors.push("non-goals must have at least four entries");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!record.boundaries?.[boundary]) {
      errors.push(`missing ${boundary} boundary`);
    }
  }

  for (const entry of record.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  const dependencies = new Set((record.dependencies ?? []).map((dependency) => dependency.source));
  for (const required of REQUIRED_DEPENDENCIES) {
    if (!dependencies.has(required)) {
      errors.push(`missing dependency ${required}`);
    }
  }

  if ((record.initiativeDependencies ?? []).length < 7) {
    errors.push("owning initiative dependencies must cover billing, metering, entitlements, tax, support, legal, and release");
  }
  for (const dependency of record.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`${dependency.owner ?? "<missing>"} must name owner, consumes, and scopeBoundary`);
    }
  }

  if ((record.customerVisibleLimitations ?? []).length === 0) {
    errors.push("customer-visible billing limitations are required");
  }
  for (const limitation of record.customerVisibleLimitations ?? []) {
    if (!limitation.id || !limitation.message || !limitation.owner) {
      errors.push(`${limitation.id ?? "<missing>"} must name id, message, and owner`);
    }
  }

  const evidenceKinds = new Set((record.m1Evidence ?? []).map((evidence) => evidence.kind));
  for (const required of REQUIRED_M1_EVIDENCE) {
    if (!evidenceKinds.has(required)) {
      errors.push(`missing M1 evidence ${required}`);
    }
  }
  for (const evidence of record.m1Evidence ?? []) {
    for (const field of ["kind", "owner", "proofMode", "source", "proves"] as const) {
      if (!evidence[field]) {
        errors.push(`${evidence.kind ?? "<missing>"} missing ${field}`);
      }
    }
    if (evidence.proofMode && !VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`${evidence.kind ?? "<missing>"} has invalid proof mode`);
    }
  }

  if (!record.followUpGate?.allowedAfter || !record.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must name allowedAfter and blockedBefore");
  }

  return { ok: errors.length === 0, errors };
}
