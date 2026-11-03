import { create } from "@bufbuild/protobuf";
import {
	type ActualCharge,
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
import { stableHash, type JsonValue } from "../json.js";
import {
	importFocusRow,
	type FocusImportRejection,
} from "./focus-import.js";
import type {
	FocusBillingRow,
	ProviderBillingFetchRequest,
	ProviderBillingPort,
	SyntheticProviderCredentials,
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
	allowPartialSnapshot?: boolean;
}>;

function reject(
	code: BillingSyncRejectionCode,
	message: string,
): BillingSyncRejection {
	return { code, message };
}

function sumBilled(actuals: readonly ActualCharge[]): Money | BillingSyncRejection {
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
		currency: currency ?? "USD",
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
	let snapshotCompleteness: "complete" | "partial" = "complete";

	for (const row of rows) {
		if (row.completeness === "partial" && !input.allowPartialSnapshot) {
			return reject(
				"INCOMPLETE_PROVIDER_BILLING",
				`sync refused partial provider row ${row.providerChargeId}`,
			);
		}
		if (row.completeness === "partial") {
			snapshotCompleteness = "partial";
		}
		if (seen.has(row.providerChargeId)) {
			variances.push({
				kind: "duplicate-suppressed",
				providerChargeId: row.providerChargeId,
				currency: row.currency,
			});
			continue;
		}
		const mapped = importFocusRow(row, input.syncAt);
		if ("code" in mapped) return mapped;
		seen.add(mapped.id);
		imported.push(mapped);
	}

	if (
		snapshotCompleteness === "partial" &&
		!input.allowPartialSnapshot
	) {
		return reject(
			"INCOMPLETE_PROVIDER_BILLING",
			"snapshot completeness is partial",
		);
	}

	const total = sumBilled(imported);
	if ("code" in total) return total;

	variances.push(
		...varianceAgainstQuote(total, input.quotedIncrementalBilled, imported),
	);

	const snapshotBody: JsonValue = {
		schema: "hobo.pricing.billing-sync.snapshot/v1",
		syncAt: input.syncAt,
		completeness: snapshotCompleteness,
		period: { start: input.periodStart, end: input.periodEnd },
		importedIds: imported.map((charge) => charge.id).sort(),
		variances,
	};
	const snapshotHash = stableHash(snapshotBody);
	const reconciliationPayload: JsonValue = {
		eventId: input.eventId,
		occurredAt: input.syncAt,
		reservationId: input.reservationId,
		actualChargeIds: imported.map((charge) => charge.id).sort(),
	};
	const reconciliationHash = stableHash(reconciliationPayload);

	const reconciliation = create(ReconciliationRecordedSchema, {
		eventId: input.eventId,
		occurredAt: input.syncAt,
		reservationId: input.reservationId,
		actualCharges: [...imported],
		reconciliationHash,
	});

	return {
		snapshot: {
			schema: "hobo.pricing.billing-sync.snapshot/v1",
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
		rows: input.rows as unknown as JsonValue,
	};
}
