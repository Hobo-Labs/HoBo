import { isJsonObject } from "./json.js";
export const REQUIRED_FIXTURE_CASES = [
  "normal-usage",
  "late-usage",
  "duplicate-usage",
  "refund-or-credit-correction",
  "disputed-usage",
] as const;

type FixtureCaseId = (typeof REQUIRED_FIXTURE_CASES)[number];

type Mapping = {
  id: string;
  source: string;
  target: string;
  proof: string;
};

type FixtureCase = {
  id: FixtureCaseId;
  proves: string;
};

type UsageEvent = {
  id: string;
  fixtureCase: FixtureCaseId;
  idempotencyKey: string;
  dedupeKey?: string;
  category: "compute" | "egress" | "storage" | "support";
  period: string;
  occurredAt: string;
  receivedAt: string;
  quantity: number;
  unit: string;
  amountMinorUnits: number;
  currency: "USD";
  customerVisibleSummary: string;
  sensitiveDetails: Record<string, string>;
  supportReason?: string;
};

type ReconciliationFixture = {
  period: string;
  periodClosedAt: string;
  events: UsageEvent[];
};

type CustomerVisibleUsage = {
  summary: string;
  quantity: number;
  unit: string;
  period: string;
};

type InvoiceLineItem = {
  id: string;
  usageEventRefs: string[];
  quantity: number;
  unit: string;
  amountMinorUnits: number;
  currency: "USD";
  customerVisibleUsage: CustomerVisibleUsage;
  auditRecordRefs: string[];
  correctionRefs: string[];
  lateEvent: boolean;
  disputeHold: boolean;
};

type AuditRecord = {
  id: string;
  usageEventRef: string;
  supportVisibleReason: string;
  retentionClass: string;
  redactedFields: string[];
};

type ReplayEvidence = {
  idempotencyKeys: string[];
  duplicateSuppressionKeys: string[];
};

export type ReconciliationOutput = {
  lineItems: InvoiceLineItem[];
  auditRecords: AuditRecord[];
  replay: ReplayEvidence;
};

export type UsageToInvoiceReconciliationContract = {
  schema: string;
  issue: string;
  project: string;
  phase: "M1";
  scopeIn: string[];
  scopeOut: string[];
  mappings: Mapping[];
  fixtureCases: FixtureCase[];
  privacyConstraints: Array<{
    id: string;
    rule: string;
    customerVisible: boolean;
    supportVisible: boolean;
  }>;
  providerBoundary: string;
  reconciliationFixture: ReconciliationFixture;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export type ParsedUsageToInvoiceReconciliationContract = UsageToInvoiceReconciliationContract & {
  readonly parsed: true;
};

const REQUIRED_MAPPINGS = [
  "usage-event-to-line-item",
  "correction-to-adjustment-line",
  "late-event-to-next-period-adjustment",
  "replay-to-idempotent-ledger",
  "support-audit-record",
] as const;

export const USAGE_TO_INVOICE_RECONCILIATION_CONTRACT: UsageToInvoiceReconciliationContract = {
  schema: "hobo.usage-to-invoice-reconciliation/v1",
  issue: "HOBO-490",
  project: "Usage Metering",
  phase: "M1",
  scopeIn: [
    "Map usage events to invoice line items without rendering invoices or collecting payment.",
    "Represent corrections, late events, duplicate replay, disputed usage, and support-visible audit records as deterministic fixtures.",
    "Document privacy constraints for customer-visible usage details and support-only audit lineage.",
  ],
  scopeOut: [
    "No live payment provider, checkout, invoice renderer, refund processor, tax engine, or production finance integration.",
    "No production metering ingestion service, provider billing sync, settlement flow, or customer payment credential handling.",
  ],
  mappings: [
    {
      id: "usage-event-to-line-item",
      source: "meter.UsageRecorded",
      target: "invoice.LineItem",
      proof: "line items retain source usage event refs, quantity, unit, amount, period, and customer-safe summary",
    },
    {
      id: "correction-to-adjustment-line",
      source: "support.UsageCorrectionApproved",
      target: "invoice.AdjustmentLine",
      proof: "refund or credit corrections become explicit negative line items with support audit refs",
    },
    {
      id: "late-event-to-next-period-adjustment",
      source: "meter.UsageRecorded(receivedAfterClose)",
      target: "invoice.LateUsageAdjustment",
      proof: "late usage is marked as an adjustment and keeps original occurrence period",
    },
    {
      id: "replay-to-idempotent-ledger",
      source: "meter.Replay",
      target: "invoice.IdempotencyLedger",
      proof: "idempotency and duplicate-suppression keys are replayed deterministically",
    },
    {
      id: "support-audit-record",
      source: "support.DisputeOpened",
      target: "support.AuditRecord",
      proof: "support-visible audit records retain lineage while customer-visible line items stay redacted",
    },
  ],
  fixtureCases: [
    {
      id: "normal-usage",
      proves: "current-period compute usage becomes a normal invoice line item",
    },
    {
      id: "late-usage",
      proves: "usage received after period close becomes a late-usage adjustment",
    },
    {
      id: "duplicate-usage",
      proves: "duplicate usage contributes one invoice line item and replayable duplicate audit evidence",
    },
    {
      id: "refund-or-credit-correction",
      proves: "support-approved credit correction becomes an explicit negative adjustment",
    },
    {
      id: "disputed-usage",
      proves: "disputed usage is held from invoice amount while support lineage remains visible",
    },
  ],
  privacyConstraints: [
    {
      id: "customer-summary-redaction",
      rule: "Customer-visible line items expose category, quantity, unit, and period, never raw user identifiers, email addresses, resource internals, or support notes.",
      customerVisible: true,
      supportVisible: false,
    },
    {
      id: "support-audit-lineage",
      rule: "Support audit records retain source event, reason, redacted-field list, and retention class for dispute replay.",
      customerVisible: false,
      supportVisible: true,
    },
  ],
  providerBoundary:
    "This contract stops at deterministic invoice-adjacent evidence; live provider, payment, tax, settlement, and production finance integrations remain out of scope.",
  reconciliationFixture: {
    period: "2026-06",
    periodClosedAt: "2026-07-01T00:00:00.000Z",
    events: [
      {
        id: "usage.compute-normal",
        fixtureCase: "normal-usage",
        idempotencyKey: "usage:compute:2026-06:run-001",
        category: "compute",
        period: "2026-06",
        occurredAt: "2026-06-05T12:00:00.000Z",
        receivedAt: "2026-06-05T12:00:03.000Z",
        quantity: 120,
        unit: "compute-second",
        amountMinorUnits: 42,
        currency: "USD",
        customerVisibleSummary: "Compute runtime for June",
        sensitiveDetails: { actorEmail: "user@example.com", runPayload: "internal-run-payload" },
      },
      {
        id: "usage.egress-late",
        fixtureCase: "late-usage",
        idempotencyKey: "usage:egress:2026-05:late-001",
        category: "egress",
        period: "2026-05",
        occurredAt: "2026-05-31T23:58:00.000Z",
        receivedAt: "2026-07-02T10:00:00.000Z",
        quantity: 9,
        unit: "gb",
        amountMinorUnits: 90,
        currency: "USD",
        customerVisibleSummary: "Late egress adjustment from prior period",
        sensitiveDetails: { internalResourceId: "yard-prod-router-17" },
      },
      {
        id: "usage.storage-primary",
        fixtureCase: "duplicate-usage",
        idempotencyKey: "usage:storage:2026-06:bucket-001",
        dedupeKey: "storage:bucket-001:2026-06",
        category: "storage",
        period: "2026-06",
        occurredAt: "2026-06-30T00:00:00.000Z",
        receivedAt: "2026-06-30T00:01:00.000Z",
        quantity: 30,
        unit: "gb-month",
        amountMinorUnits: 300,
        currency: "USD",
        customerVisibleSummary: "Storage for June",
        sensitiveDetails: { bucketName: "tenant-private-bucket" },
      },
      {
        id: "usage.storage-duplicate",
        fixtureCase: "duplicate-usage",
        idempotencyKey: "usage:storage:2026-06:bucket-001:duplicate",
        dedupeKey: "storage:bucket-001:2026-06",
        category: "storage",
        period: "2026-06",
        occurredAt: "2026-06-30T00:00:00.000Z",
        receivedAt: "2026-06-30T00:02:00.000Z",
        quantity: 30,
        unit: "gb-month",
        amountMinorUnits: 300,
        currency: "USD",
        customerVisibleSummary: "Duplicate storage replay",
        sensitiveDetails: { bucketName: "tenant-private-bucket" },
      },
      {
        id: "usage.credit-correction",
        fixtureCase: "refund-or-credit-correction",
        idempotencyKey: "usage:support:2026-06:credit-001",
        category: "support",
        period: "2026-06",
        occurredAt: "2026-06-20T09:00:00.000Z",
        receivedAt: "2026-06-20T09:05:00.000Z",
        quantity: 1,
        unit: "credit-correction",
        amountMinorUnits: -150,
        currency: "USD",
        customerVisibleSummary: "Approved usage credit correction",
        supportReason: "customer support approved disputed storage credit",
        sensitiveDetails: { supportTicket: "SUP-001" },
      },
      {
        id: "usage.compute-dispute",
        fixtureCase: "disputed-usage",
        idempotencyKey: "usage:compute:2026-06:dispute-001",
        category: "compute",
        period: "2026-06",
        occurredAt: "2026-06-25T15:00:00.000Z",
        receivedAt: "2026-06-25T15:00:02.000Z",
        quantity: 60,
        unit: "compute-second",
        amountMinorUnits: 0,
        currency: "USD",
        customerVisibleSummary: "Usage under dispute hold",
        supportReason: "support dispute opened before invoice close",
        sensitiveDetails: { actorEmail: "user@example.com", disputeNote: "customer supplied log excerpt" },
      },
    ],
  },
};

export function parseUsageToInvoiceReconciliationContract(
  record: UsageToInvoiceReconciliationContract,
): ParsedUsageToInvoiceReconciliationContract {
  const result = validateUsageToInvoiceReconciliationContract(record);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }

  return { ...record, parsed: true };
}

export function validateUsageToInvoiceReconciliationContract(
  record: Partial<UsageToInvoiceReconciliationContract> | null | undefined,
): ValidationResult {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["usage-to-invoice reconciliation contract is required"] };
  }
  if (record.issue !== "HOBO-490") {
    errors.push("issue must be HOBO-490");
  }
  if (record.phase !== "M1") {
    errors.push("phase must be M1");
  }

  const mappingIds = new Set((record.mappings ?? []).map((mapping) => mapping.id));
  for (const mapping of REQUIRED_MAPPINGS) {
    if (!mappingIds.has(mapping)) {
      errors.push(`missing mapping ${mapping}`);
    }
  }
  for (const mapping of record.mappings ?? []) {
    for (const field of ["source", "target", "proof"] as const) {
      if (!mapping[field]) {
        errors.push(`${mapping.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  const fixtureIds = new Set((record.fixtureCases ?? []).map((fixture) => fixture.id));
  for (const fixture of REQUIRED_FIXTURE_CASES) {
    if (!fixtureIds.has(fixture)) {
      errors.push(`missing fixture case ${fixture}`);
    }
  }

  if (!record.privacyConstraints?.length) {
    errors.push("privacy constraints are required");
  }
  for (const constraint of record.privacyConstraints ?? []) {
    if (!constraint.rule) {
      errors.push(`${constraint.id ?? "<missing>"} missing privacy rule`);
    }
  }

  if (!(record.scopeOut ?? []).some((entry) => /live payment provider/i.test(entry))) {
    errors.push("live payment provider scope-out is required");
  }
  const scopeText = [...(record.scopeIn ?? []), record.providerBoundary ?? ""].join("\n");
  if (/\bimplement\b.*\b(production finance integration|live payment provider)\b/i.test(scopeText)) {
    errors.push("production finance integration is out of scope");
  }

  const fixture = record.reconciliationFixture;
  if (!fixture?.events?.length) {
    errors.push("reconciliation fixture events are required");
  }

  return { ok: errors.length === 0, errors };
}

export function reconcileUsageEventsToInvoiceEvidence(
  contract: ParsedUsageToInvoiceReconciliationContract,
): ReconciliationOutput {
  const fixture = contract.reconciliationFixture;
  const auditRecords = fixture.events.map((event) => auditRecordFor(event));
  const auditByEvent = new Map(auditRecords.map((record) => [record.usageEventRef, record.id]));
  const duplicateSuppressionKeys = duplicateKeys(fixture.events);

  const lineItems: InvoiceLineItem[] = [
    lineItemFor(findEvent(fixture, "usage.compute-normal"), {
      id: "line.compute-normal",
      auditByEvent,
      correctionRefs: [],
      lateEvent: false,
      disputeHold: false,
    }),
    lineItemFor(findEvent(fixture, "usage.egress-late"), {
      id: "line.egress-late-adjustment",
      auditByEvent,
      correctionRefs: ["correction.late-usage-adjustment"],
      lateEvent: true,
      disputeHold: false,
    }),
    lineItemFor(findEvent(fixture, "usage.storage-primary"), {
      id: "line.storage-deduped",
      auditByEvent,
      extraUsageEventRefs: ["usage.storage-duplicate"],
      correctionRefs: ["correction.duplicate-suppressed"],
      lateEvent: false,
      disputeHold: false,
    }),
    lineItemFor(findEvent(fixture, "usage.credit-correction"), {
      id: "line.credit-correction",
      auditByEvent,
      correctionRefs: ["correction.approved-credit"],
      lateEvent: false,
      disputeHold: false,
    }),
    lineItemFor(findEvent(fixture, "usage.compute-dispute"), {
      id: "line.dispute-hold",
      auditByEvent,
      correctionRefs: ["correction.dispute-hold"],
      lateEvent: false,
      disputeHold: true,
    }),
  ];

  return {
    lineItems,
    auditRecords,
    replay: {
      idempotencyKeys: fixture.events.map((event) => event.idempotencyKey),
      duplicateSuppressionKeys,
    },
  };
}

function lineItemFor(
  event: UsageEvent,
  options: {
    id: string;
    auditByEvent: Map<string, string>;
    extraUsageEventRefs?: string[];
    correctionRefs: string[];
    lateEvent: boolean;
    disputeHold: boolean;
  },
): InvoiceLineItem {
  const usageEventRefs = [event.id, ...(options.extraUsageEventRefs ?? [])];
  const auditRecordRefs = usageEventRefs
    .map((eventRef) => options.auditByEvent.get(eventRef))
    .filter((record): record is string => Boolean(record));

  return {
    id: options.id,
    usageEventRefs,
    quantity: event.quantity,
    unit: event.unit,
    amountMinorUnits: event.amountMinorUnits,
    currency: event.currency,
    customerVisibleUsage: {
      summary: event.customerVisibleSummary,
      quantity: event.quantity,
      unit: event.unit,
      period: event.period,
    },
    auditRecordRefs,
    correctionRefs: options.correctionRefs,
    lateEvent: options.lateEvent,
    disputeHold: options.disputeHold,
  };
}

function auditRecordFor(event: UsageEvent): AuditRecord {
  return {
    id: `audit.${event.id.replace(/^usage\./, "")}`,
    usageEventRef: event.id,
    supportVisibleReason: event.supportReason ?? `${event.fixtureCase} fixture lineage`,
    retentionClass: "billing-support-audit",
    redactedFields: Object.keys(event.sensitiveDetails),
  };
}

function duplicateKeys(events: UsageEvent[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (!event.dedupeKey) continue;
    if (seen.has(event.dedupeKey)) {
      duplicates.add(event.dedupeKey);
    }
    seen.add(event.dedupeKey);
  }
  return [...duplicates].sort();
}

function findEvent(fixture: ReconciliationFixture, id: string): UsageEvent {
  const event = fixture.events.find((candidate) => candidate.id === id);
  if (!event) {
    throw new Error(`fixture event not found: ${id}`);
  }
  return event;
}
