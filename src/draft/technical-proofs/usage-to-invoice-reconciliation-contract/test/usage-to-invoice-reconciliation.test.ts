import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_FIXTURE_CASES,
  USAGE_TO_INVOICE_RECONCILIATION_CONTRACT,
  parseUsageToInvoiceReconciliationContract,
  reconcileUsageEventsToInvoiceEvidence,
  validateUsageToInvoiceReconciliationContract,
} from "../src/usage-to-invoice-reconciliation.js";

test("HOBO-490 contract maps usage events to invoice line items, corrections, late events, replay, and audit records", () => {
  const result = validateUsageToInvoiceReconciliationContract(USAGE_TO_INVOICE_RECONCILIATION_CONTRACT);

  assert.deepEqual(result.errors, []);
  assert.equal(USAGE_TO_INVOICE_RECONCILIATION_CONTRACT.issue, "HOBO-490");
  assert.equal(USAGE_TO_INVOICE_RECONCILIATION_CONTRACT.phase, "M1");
  assert.deepEqual(
    USAGE_TO_INVOICE_RECONCILIATION_CONTRACT.mappings.map((mapping) => mapping.id),
    [
      "usage-event-to-line-item",
      "correction-to-adjustment-line",
      "late-event-to-next-period-adjustment",
      "replay-to-idempotent-ledger",
      "support-audit-record",
    ],
  );
});

test("deterministic fixtures cover normal, late, duplicate, refund or credit correction, and disputed usage", () => {
  assert.deepEqual(
    USAGE_TO_INVOICE_RECONCILIATION_CONTRACT.fixtureCases.map((fixture) => fixture.id),
    REQUIRED_FIXTURE_CASES,
  );

  const parsed = parseUsageToInvoiceReconciliationContract(USAGE_TO_INVOICE_RECONCILIATION_CONTRACT);
  const output = reconcileUsageEventsToInvoiceEvidence(parsed);

  assert.deepEqual(
    output.lineItems.map((item) => item.id),
    [
      "line.compute-normal",
      "line.egress-late-adjustment",
      "line.storage-deduped",
      "line.credit-correction",
      "line.dispute-hold",
    ],
  );
  assert.equal(output.auditRecords.length, 6);
  assert.deepEqual(output.replay.idempotencyKeys, [
    "usage:compute:2026-06:run-001",
    "usage:egress:2026-05:late-001",
    "usage:storage:2026-06:bucket-001",
    "usage:storage:2026-06:bucket-001:duplicate",
    "usage:support:2026-06:credit-001",
    "usage:compute:2026-06:dispute-001",
  ]);
});

test("customer-visible usage details are redacted while support audit lineage stays replayable", () => {
  const parsed = parseUsageToInvoiceReconciliationContract(USAGE_TO_INVOICE_RECONCILIATION_CONTRACT);
  const output = reconcileUsageEventsToInvoiceEvidence(parsed);

  assert.equal(
    output.lineItems.every((item) => !JSON.stringify(item.customerVisibleUsage).includes("user@example.com")),
    true,
  );
  assert.equal(
    output.auditRecords.every((record) => record.retentionClass && record.redactedFields.length > 0),
    true,
  );
});

test("validation rejects live payment provider work, production finance integration, missing privacy, and proofless line items", () => {
  const invalid = structuredClone(USAGE_TO_INVOICE_RECONCILIATION_CONTRACT);
  invalid.scopeOut = invalid.scopeOut.filter((entry) => !/live payment provider/i.test(entry));
  invalid.providerBoundary = "Implement production finance integration with a live payment provider.";
  invalid.privacyConstraints = [];
  invalid.mappings[0] = {
    ...invalid.mappings[0],
    proof: "",
  };

  const result = validateUsageToInvoiceReconciliationContract(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live payment provider scope-out is required/);
  assert.match(result.errors.join("\n"), /production finance integration is out of scope/);
  assert.match(result.errors.join("\n"), /privacy constraints are required/);
  assert.match(result.errors.join("\n"), /usage-event-to-line-item missing proof/);
});
