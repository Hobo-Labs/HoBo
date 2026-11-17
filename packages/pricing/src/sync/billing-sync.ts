import { create, toJson } from "@bufbuild/protobuf";
import {
	type ActualCharge,
	ActualChargeSchema,
	type Money,
	MoneySchema,
	type ReconciliationRecorded,
	ReconciliationRecordedSchema,
} from "../_generated/pricing_pb.js";
import {
	addDecimal,
	formatDecimal,
	parseDecimal,
	subtractDecimal,
} from "../decimal.js";
import { type JsonValue, stableHash } from "../json.js";
import { type FocusImportRejection, importFocusRow } from "./focus-import.js";
import {
	type FocusBillingRow,
	focusBillingRowsToJson,
	focusBillingRowToJson,
	type ProviderBillingFetchRequest,
	type ProviderBillingPort,
	parseFocusBillingRow,
	type SyntheticProviderCredentials,
} from "./provider-port.js";

export type BillingSyncRejectionCode =
	| FocusImportRejection["code"]
	| "DUPLICATE_PROVIDER_CHARGE"
	| "SYNC_ALREADY_PARTIAL";

export type BillingSyncRejection = Readonly<{
	code: BillingSyncRejectionCode;
	message: string;
}>;

export type VarianceFact = Readonly<{
	kind:
		| "billed-vs-quoted"
		| "duplicate-suppressed"
		| "late-adjustment"
		| "negative-adjustment";
	providerChargeId: string;
	quotedDecimal?: string;
	actualDecimal?: string;
	deltaDecimal?: string;
	currency: string;
}>;

export type BillingSyncSnapshot = Readonly<{
	schema: "hobo.pricing.billing-sync.snapshot/v1";
	hashVersion: 2;
	syncAt: string;
	snapshotHash: string;
	completeness: "complete" | "partial";
	period: Readonly<{ start: string; end: string }>;
	imported: readonly ActualCharge[];
	variances: readonly VarianceFact[];
	reconciliationHash: string;
	eventId: string;
	reservationId: string;
}>;

export type BillingSyncSuccess = Readonly<{
	snapshot: BillingSyncSnapshot;
	reconciliation: ReconciliationRecorded;
}>;

export type BillingSyncResult = BillingSyncSuccess | BillingSyncRejection;

export type BillingSyncInput = Readonly<{
	syncAt: string;
	periodStart: string;
	periodEnd: string;
	reservationId: string;
	eventId: string;
	quotedIncrementalBilled: Money;
	port: ProviderBillingPort;
	credentials: SyntheticProviderCredentials;
	knownActualIds?: ReadonlySet<string>;
}>;

function reject(
	code: BillingSyncRejectionCode,
	message: string,
): BillingSyncRejection {
	return { code, message };
}

function isUtcTimestamp(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value))
		return false;
	const timestamp = Date.parse(value);
	return (
		Number.isFinite(timestamp) &&
		new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19)
	);
}

function sumBilled(
	actuals: readonly ActualCharge[],
	defaultCurrency: string,
): Money | BillingSyncRejection {
	let currency: string | undefined;
	let total = parseDecimal("0");
	if (total === undefined) {
		return reject("INVALID_SYNC_INPUT", "decimal zero unavailable");
	}
	for (const charge of actuals) {
		const billed = charge.billedCost;
		if (billed === undefined || billed.decimal === undefined) {
			return reject(
				"INVALID_SYNC_INPUT",
				`actual ${charge.id} missing billed cost`,
			);
		}
		if (currency === undefined) currency = billed.currency;
		if (billed.currency !== currency) {
			return reject("CROSS_CURRENCY", "actual charges mix currencies");
		}
		const parsed = parseDecimal(billed.decimal);
		if (parsed === undefined) {
			return reject(
				"INVALID_SYNC_INPUT",
				`actual ${charge.id} has non-canonical billed decimal`,
			);
		}
		total = addDecimal(total, parsed);
	}
	return create(MoneySchema, {
		decimal: formatDecimal(total),
		currency: currency ?? defaultCurrency,
	});
}

function varianceAgainstQuote(
	actualTotal: Money,
	quoted: Money,
	actuals: readonly ActualCharge[],
): VarianceFact[] {
	const facts: VarianceFact[] = [];
	const quotedDecimal = quoted.decimal ?? "0";
	const actualDecimal = actualTotal.decimal ?? "0";
	const currency = quoted.currency;
	const quotedParsed = parseDecimal(quotedDecimal);
	const actualParsed = parseDecimal(actualDecimal);
	if (
		quotedParsed === undefined ||
		actualParsed === undefined ||
		quoted.currency !== actualTotal.currency
	) {
		return facts;
	}
	const delta = subtractDecimal(actualParsed, quotedParsed);
	if (delta.coefficient !== 0n) {
		facts.push({
			kind: "billed-vs-quoted",
			providerChargeId: "aggregate",
			quotedDecimal,
			actualDecimal,
			deltaDecimal: formatDecimal(delta),
			currency,
		});
	}
	for (const charge of actuals) {
		if (charge.category === "adjustment") {
			const billed = charge.billedCost?.decimal ?? "0";
			const parsed = parseDecimal(billed);
			facts.push({
				kind:
					parsed !== undefined && parsed.coefficient < 0n
						? "negative-adjustment"
						: "late-adjustment",
				providerChargeId: charge.id,
				actualDecimal: billed,
				currency: charge.billedCost?.currency ?? currency,
			});
		}
	}
	return facts;
}

export async function runBillingSync(
	input: BillingSyncInput,
): Promise<BillingSyncResult> {
	const quote = input.quotedIncrementalBilled;
	if (
		!/^[A-Z]{3}$/u.test(quote.currency) ||
		parseDecimal(quote.decimal) === undefined
	) {
		return reject("INVALID_SYNC_INPUT", "quoted amount or currency is invalid");
	}
	const periodStart = Date.parse(input.periodStart);
	const periodEnd = Date.parse(input.periodEnd);
	if (
		!input.reservationId.trim() ||
		!input.eventId.trim() ||
		!isUtcTimestamp(input.syncAt) ||
		!isUtcTimestamp(input.periodStart) ||
		!isUtcTimestamp(input.periodEnd) ||
		periodStart > periodEnd
	) {
		return reject("INVALID_SYNC_INPUT", "sync identity or period is invalid");
	}
	const fetchRequest: ProviderBillingFetchRequest = {
		syncAt: input.syncAt,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		credentials: input.credentials,
	};
	const rows = await input.port.fetchFocusRows(fetchRequest);
	const imported: ActualCharge[] = [];
	const variances: VarianceFact[] = [];
	const seen = new Set(input.knownActualIds ?? []);
	const snapshotCompleteness = "complete" as const;

	for (const row of rows) {
		const parsed = parseFocusBillingRow(focusBillingRowToJson(row));
		if (parsed === undefined) {
			return reject("INVALID_SYNC_INPUT", "provider billing row is incomplete");
		}
		if (parsed.completeness === "partial") {
			return reject(
				"INCOMPLETE_PROVIDER_BILLING",
				`sync refused partial provider row ${parsed.providerChargeId}`,
			);
		}
		const chargeStart = Date.parse(parsed.chargePeriodStart);
		const chargeEnd = Date.parse(parsed.chargePeriodEnd);
		if (
			!isUtcTimestamp(parsed.chargePeriodStart) ||
			!isUtcTimestamp(parsed.chargePeriodEnd) ||
			chargeStart > chargeEnd
		) {
			return reject("INVALID_SYNC_INPUT", "provider billing period is invalid");
		}
		if (!/^[A-Z]{3}$/u.test(parsed.currency)) {
			return reject(
				"INVALID_SYNC_INPUT",
				"provider billing currency is invalid",
			);
		}
		const mapped = importFocusRow(parsed, input.syncAt);
		if ("code" in mapped) return mapped;
		if (mapped.billedCost?.currency !== quote.currency) {
			return reject(
				"CROSS_CURRENCY",
				"actual charge and quote currencies differ",
			);
		}
		if (seen.has(parsed.providerChargeId)) {
			variances.push({
				kind: "duplicate-suppressed",
				providerChargeId: parsed.providerChargeId,
				currency: parsed.currency,
			});
			continue;
		}
		seen.add(mapped.id);
		imported.push(mapped);
	}

	const total = sumBilled(imported, quote.currency);
	if ("code" in total) return total;

	variances.push(
		...varianceAgainstQuote(total, input.quotedIncrementalBilled, imported),
	);

	const actualCharges = imported.map((charge) =>
		toJson(ActualChargeSchema, charge, { alwaysEmitImplicit: true }),
	);
	const reconciliationPayload: JsonValue = {
		hashVersion: 2,
		eventId: input.eventId,
		occurredAt: input.syncAt,
		reservationId: input.reservationId,
		actualCharges,
	};
	const reconciliationHash = stableHash(reconciliationPayload);
	const snapshotBody: JsonValue = {
		schema: "hobo.pricing.billing-sync.snapshot/v1",
		hashVersion: 2,
		syncAt: input.syncAt,
		completeness: snapshotCompleteness,
		period: { start: input.periodStart, end: input.periodEnd },
		imported: actualCharges,
		variances,
		reconciliationHash,
		eventId: input.eventId,
		reservationId: input.reservationId,
	};
	const snapshotHash = stableHash(snapshotBody);

	const reconciliation = create(ReconciliationRecordedSchema, {
		hashVersion: 2,
		eventId: input.eventId,
		occurredAt: input.syncAt,
		reservationId: input.reservationId,
		actualCharges: [...imported],
		reconciliationHash,
	});

	return {
		snapshot: {
			schema: "hobo.pricing.billing-sync.snapshot/v1",
			hashVersion: 2,
			syncAt: input.syncAt,
			snapshotHash,
			completeness: snapshotCompleteness,
			period: { start: input.periodStart, end: input.periodEnd },
			imported,
			variances,
			reconciliationHash,
			eventId: input.eventId,
			reservationId: input.reservationId,
		},
		reconciliation,
	};
}

export function fixtureProviderPort(
	rows: readonly FocusBillingRow[],
): ProviderBillingPort {
	return {
		async fetchFocusRows() {
			return rows;
		},
	};
}

export function billingSyncJsonBody(input: {
	syncAt: string;
	periodStart: string;
	periodEnd: string;
	reservationId: string;
	quotedIncrementalDecimal: string;
	currency: string;
	rows: readonly FocusBillingRow[];
}): JsonValue {
	return {
		syncAt: input.syncAt,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		reservationId: input.reservationId,
		quotedIncrementalBilled: {
			decimal: input.quotedIncrementalDecimal,
			currency: input.currency,
		},
		rows: focusBillingRowsToJson(input.rows),
	};
}
