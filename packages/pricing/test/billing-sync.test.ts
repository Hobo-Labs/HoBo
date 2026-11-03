import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { MoneySchema } from "../src/_generated/pricing_pb.js";
import {
	fixtureProviderPort,
	runBillingSync,
} from "../src/sync/billing-sync.js";
import {
	createSyntheticProviderCredentials,
	type FocusBillingRow,
} from "../src/sync/provider-port.js";

const AT = "2026-02-01T12:00:00Z";
const PERIOD_START = "2026-01-01T00:00:00Z";
const PERIOD_END = "2026-01-31T23:59:59Z";

const fixture = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "fixtures/focus-provider-billing.json"),
		"utf8",
	),
) as {
	completeRows: FocusBillingRow[];
	partialRow: FocusBillingRow;
	duplicateRow: FocusBillingRow;
};

function quotedIncremental(decimal: string) {
	return create(MoneySchema, { decimal, currency: "USD" });
}

it("§12 Phase 5 live billing sync produces dated snapshot and variance against quote", async () => {
	const credentials = createSyntheticProviderCredentials();
	expect(credentials.authorization).toMatch(/^Bearer synth-/);
	const result = await runBillingSync({
		syncAt: AT,
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		reservationId: "reservation-1",
		eventId: "evt-reconcile-1",
		quotedIncrementalBilled: quotedIncremental("1.00"),
		port: fixtureProviderPort(fixture.completeRows),
		credentials,
	});
	expect("code" in result).toBe(false);
	if ("code" in result) return;
	expect(result.snapshot.schema).toBe("hobo.pricing.billing-sync.snapshot/v1");
	expect(result.snapshot.syncAt).toBe(AT);
	expect(result.snapshot.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(result.snapshot.completeness).toBe("complete");
	expect(result.snapshot.imported).toHaveLength(2);
	const aggregateVariance = result.snapshot.variances.find(
		(fact) => fact.kind === "billed-vs-quoted",
	);
	expect(aggregateVariance?.deltaDecimal).toBe("0.25");
	expect(result.reconciliation.reconciliationHash).toMatch(
		/^sha256:[0-9a-f]{64}$/,
	);
	expect(result.reconciliation.actualCharges).toHaveLength(2);
});

it("§12 Phase 5 fails closed on incomplete provider billing data", async () => {
	const result = await runBillingSync({
		syncAt: AT,
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		reservationId: "reservation-1",
		eventId: "evt-reconcile-2",
		quotedIncrementalBilled: quotedIncremental("0"),
		port: fixtureProviderPort([fixture.partialRow]),
		credentials: createSyntheticProviderCredentials(),
	});
	expect(result).toMatchObject({
		code: "INCOMPLETE_PROVIDER_BILLING",
	});
});

it("§12 Phase 5 dedupes provider charge ids and appends reconciliation hash", async () => {
	const result = await runBillingSync({
		syncAt: AT,
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		reservationId: "reservation-1",
		eventId: "evt-reconcile-3",
		quotedIncrementalBilled: quotedIncremental("1.25"),
		port: fixtureProviderPort([
			fixture.completeRows[0]!,
			fixture.duplicateRow,
		]),
		credentials: createSyntheticProviderCredentials(),
		knownActualIds: new Set(["prov-charge-usage-1"]),
	});
	expect("code" in result).toBe(false);
	if ("code" in result) return;
	expect(result.snapshot.imported).toHaveLength(0);
	expect(
		result.snapshot.variances.filter(
			(fact) => fact.kind === "duplicate-suppressed",
		),
	).toHaveLength(2);
	expect(result.reconciliation.actualCharges).toHaveLength(0);
});

it("§12 Phase 5 records negative adjustment variance without rewriting history", async () => {
	const result = await runBillingSync({
		syncAt: AT,
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		reservationId: "reservation-1",
		eventId: "evt-reconcile-4",
		quotedIncrementalBilled: quotedIncremental("1.25"),
		port: fixtureProviderPort(fixture.completeRows),
		credentials: createSyntheticProviderCredentials(),
	});
	expect("code" in result).toBe(false);
	if ("code" in result) return;
	expect(
		result.snapshot.variances.some(
			(fact) => fact.kind === "negative-adjustment",
		),
	).toBe(true);
});
