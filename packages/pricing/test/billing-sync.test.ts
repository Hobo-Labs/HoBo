import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	ActualChargeSchema,
	MoneySchema,
} from "../src/_generated/pricing_pb.js";
import {
	isJsonObject,
	type JsonValue,
	parseJson,
	stableHash,
} from "../src/json.js";
import {
	type BillingSyncInput,
	fixtureProviderPort,
	runBillingSync,
} from "../src/sync/billing-sync.js";
import {
	createSyntheticProviderCredentials,
	type FocusBillingRow,
	parseFocusBillingRow,
} from "../src/sync/provider-port.js";

const AT = "2026-02-01T12:00:00Z";
const PERIOD_START = "2026-01-01T00:00:00Z";
const PERIOD_END = "2026-01-31T23:59:59Z";

function parseFixtureRow(value: JsonValue): FocusBillingRow {
	const parsed = parseFocusBillingRow(value);
	if (parsed === undefined) throw new Error("invalid FOCUS fixture row");
	return parsed;
}

function parseFixtureRowList(value: JsonValue | undefined): FocusBillingRow[] {
	if (!Array.isArray(value)) throw new Error("fixture row list missing");
	return value.map(parseFixtureRow);
}

const fixtureRaw = parseJson(
	readFileSync(
		join(import.meta.dirname, "fixtures/focus-provider-billing.json"),
		"utf8",
	),
);
if (!isJsonObject(fixtureRaw))
	throw new Error("FOCUS fixture root must be object");
const fixture = {
	completeRows: parseFixtureRowList(fixtureRaw.completeRows),
	partialRow: parseFixtureRow(fixtureRaw.partialRow),
	duplicateRow: parseFixtureRow(fixtureRaw.duplicateRow),
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
	expect(result.reconciliation.reconciliationHash).toBe(
		stableHash({
			eventId: result.reconciliation.eventId,
			occurredAt: result.reconciliation.occurredAt,
			reservationId: result.reconciliation.reservationId,
			actualCharges: result.reconciliation.actualCharges.map((charge) =>
				toJson(ActualChargeSchema, charge, { alwaysEmitImplicit: true }),
			),
		}),
	);
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
	const [completeRow] = fixture.completeRows;
	if (completeRow === undefined)
		throw new Error("fixture has no complete rows");
	const result = await runBillingSync({
		syncAt: AT,
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		reservationId: "reservation-1",
		eventId: "evt-reconcile-3",
		quotedIncrementalBilled: quotedIncremental("1.25"),
		port: fixtureProviderPort([completeRow, completeRow]),
		credentials: createSyntheticProviderCredentials(),
	});
	expect("code" in result).toBe(false);
	if ("code" in result) return;
	expect(result.snapshot.imported).toHaveLength(1);
	expect(
		result.snapshot.variances.filter(
			(fact) => fact.kind === "duplicate-suppressed",
		),
	).toHaveLength(1);
	expect(result.reconciliation.actualCharges).toHaveLength(1);
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

function sync(overrides: Partial<BillingSyncInput> = {}) {
	return runBillingSync({
		syncAt: AT,
		periodStart: PERIOD_START,
		periodEnd: PERIOD_END,
		reservationId: "reservation-1",
		eventId: "event-1",
		quotedIncrementalBilled: quotedIncremental("1.25"),
		port: fixtureProviderPort(fixture.completeRows),
		credentials: createSyntheticProviderCredentials(),
		...overrides,
	});
}

it("rejects currency mismatches between the quote and provider charges", async () => {
	await expect(
		sync({
			quotedIncrementalBilled: create(MoneySchema, {
				decimal: "1",
				currency: "EUR",
			}),
		}),
	).resolves.toMatchObject({ code: "CROSS_CURRENCY" });

	const [first, second] = fixture.completeRows;
	if (!first || !second) throw new Error("fixture requires two charges");
	await expect(
		sync({
			port: fixtureProviderPort([first, { ...second, currency: "EUR" }]),
		}),
	).resolves.toMatchObject({ code: "CROSS_CURRENCY" });
});

it("uses the quote currency when no charges are imported", async () => {
	const result = await sync({
		quotedIncrementalBilled: create(MoneySchema, {
			decimal: "1",
			currency: "EUR",
		}),
		port: fixtureProviderPort([]),
	});
	if ("code" in result) throw new Error(result.message);
	expect(result.snapshot.variances).toContainEqual({
		kind: "billed-vs-quoted",
		providerChargeId: "aggregate",
		quotedDecimal: "1",
		actualDecimal: "0",
		deltaDecimal: "-1",
		currency: "EUR",
	});
});

it.each([
	"providerChargeId",
	"agreementId",
	"chargeId",
	"chargePeriodStart",
	"chargePeriodEnd",
	"billedCostDecimal",
	"currency",
	"category",
] as const)("rejects a provider row with a missing %s", async (field) => {
	const [row] = fixture.completeRows;
	if (!row) throw new Error("fixture requires a charge");
	await expect(
		sync({ port: fixtureProviderPort([{ ...row, [field]: "" }]) }),
	).resolves.toMatchObject({ code: "INVALID_SYNC_INPUT" });
});

it("rejects invalid dates, quotes, and incomplete duplicate rows", async () => {
	const [row] = fixture.completeRows;
	if (!row) throw new Error("fixture requires a charge");
	await expect(sync({ periodStart: "invalid" })).resolves.toMatchObject({
		code: "INVALID_SYNC_INPUT",
	});
	await expect(sync({ syncAt: "2026-02-30T12:00:00Z" })).resolves.toMatchObject(
		{
			code: "INVALID_SYNC_INPUT",
		},
	);
	await expect(
		sync({ syncAt: "2026-02-01T12:00:00+00:00" }),
	).resolves.toMatchObject({
		code: "INVALID_SYNC_INPUT",
	});
	await expect(
		sync({ periodStart: PERIOD_END, periodEnd: PERIOD_START }),
	).resolves.toMatchObject({ code: "INVALID_SYNC_INPUT" });
	await expect(
		sync({ quotedIncrementalBilled: quotedIncremental("invalid") }),
	).resolves.toMatchObject({ code: "INVALID_SYNC_INPUT" });
	await expect(
		sync({
			quotedIncrementalBilled: create(MoneySchema, {
				decimal: "1",
				currency: "usd",
			}),
		}),
	).resolves.toMatchObject({ code: "INVALID_SYNC_INPUT" });
	await expect(
		sync({
			port: fixtureProviderPort([{ ...row, chargePeriodEnd: "invalid" }]),
		}),
	).resolves.toMatchObject({ code: "INVALID_SYNC_INPUT" });
	await expect(
		sync({
			port: fixtureProviderPort([row, { ...row, chargeId: "" }]),
		}),
	).resolves.toMatchObject({ code: "INVALID_SYNC_INPUT" });
});

it("reconciles retries against all previously recorded charges", async () => {
	const first = await sync();
	if ("code" in first) throw new Error(first.message);
	const repeated = await sync({
		syncAt: "2026-02-02T12:00:00Z",
		knownActualCharges: first.reconciliation.actualCharges,
	});
	if ("code" in repeated) throw new Error(repeated.message);
	expect(repeated.reconciliation.actualCharges).toHaveLength(0);
	expect(
		repeated.snapshot.variances.filter(
			(fact) => fact.kind === "duplicate-suppressed",
		),
	).toHaveLength(2);
	expect(
		repeated.snapshot.variances.some(
			(fact) => fact.kind === "billed-vs-quoted",
		),
	).toBe(false);
});

it("includes earlier charges when reconciling a later adjustment", async () => {
	const [usage, adjustment] = fixture.completeRows;
	if (!usage || !adjustment) throw new Error("fixture requires two charges");
	const first = await sync({ port: fixtureProviderPort([usage]) });
	if ("code" in first) throw new Error(first.message);
	const next = await sync({
		knownActualCharges: first.reconciliation.actualCharges,
		port: fixtureProviderPort([adjustment]),
	});
	if ("code" in next) throw new Error(next.message);
	expect(next.reconciliation.actualCharges.map((charge) => charge.id)).toEqual([
		adjustment.providerChargeId,
	]);
	expect(
		next.snapshot.variances.some((fact) => fact.kind === "billed-vs-quoted"),
	).toBe(false);
	expect(
		next.snapshot.variances.some((fact) => fact.kind === "negative-adjustment"),
	).toBe(true);
});

it("rejects a provider charge ID reused with different contents", async () => {
	const [usage] = fixture.completeRows;
	if (!usage) throw new Error("fixture requires a charge");
	await expect(
		sync({ port: fixtureProviderPort([usage, fixture.duplicateRow]) }),
	).resolves.toMatchObject({
		code: "DUPLICATE_PROVIDER_CHARGE",
	});
	const first = await sync({ port: fixtureProviderPort([usage]) });
	if ("code" in first) throw new Error(first.message);
	await expect(
		sync({
			knownActualCharges: first.reconciliation.actualCharges,
			port: fixtureProviderPort([{ ...usage, billedCostDecimal: "9" }]),
		}),
	).resolves.toMatchObject({ code: "DUPLICATE_PROVIDER_CHARGE" });
});

it("rejects repeated or cross-currency prior charges", async () => {
	const first = await sync();
	if ("code" in first) throw new Error(first.message);
	const [charge] = first.reconciliation.actualCharges;
	if (!charge) throw new Error("fixture requires a charge");
	await expect(
		sync({ knownActualCharges: [charge, charge] }),
	).resolves.toMatchObject({
		code: "DUPLICATE_PROVIDER_CHARGE",
	});
	await expect(
		sync({
			knownActualCharges: [charge],
			quotedIncrementalBilled: create(MoneySchema, {
				decimal: "1",
				currency: "EUR",
			}),
		}),
	).resolves.toMatchObject({ code: "CROSS_CURRENCY" });
});

it("binds snapshot and reconciliation hashes to charge contents", async () => {
	const [first, second] = fixture.completeRows;
	if (!first || !second) throw new Error("fixture requires two charges");
	const original = await sync();
	const changed = await sync({
		port: fixtureProviderPort([
			{ ...first, billedCostDecimal: "1.75" },
			{ ...second, billedCostDecimal: "-0.50" },
		]),
	});
	if ("code" in original || "code" in changed) throw new Error("sync failed");
	expect(changed.snapshot.snapshotHash).not.toBe(
		original.snapshot.snapshotHash,
	);
	expect(changed.reconciliation.reconciliationHash).not.toBe(
		original.reconciliation.reconciliationHash,
	);
});
