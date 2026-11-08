import { create } from "@bufbuild/protobuf";
import {
	type ActualCharge,
	ActualChargeSchema,
	type Money,
	MoneySchema,
} from "../_generated/pricing_pb.js";
import { formatDecimal, parseDecimal } from "../decimal.js";
import type { FocusBillingRow } from "./provider-port.js";

export type FocusImportRejection = Readonly<{
	code: "INCOMPLETE_PROVIDER_BILLING" | "INVALID_SYNC_INPUT" | "CROSS_CURRENCY";
	message: string;
}>;

export type FocusImportResult = ActualCharge | FocusImportRejection;

function money(decimal: string, currency: string): Money | undefined {
	const parsed = parseDecimal(decimal);
	if (parsed === undefined) return undefined;
	return create(MoneySchema, { decimal: formatDecimal(parsed), currency });
}

function reject(
	code: FocusImportRejection["code"],
	message: string,
): FocusImportRejection {
	return { code, message };
}

export function importFocusRow(
	row: FocusBillingRow,
	syncAt: string,
): FocusImportResult {
	if (row.completeness === "partial") {
		return reject(
			"INCOMPLETE_PROVIDER_BILLING",
			`provider charge ${row.providerChargeId} is marked partial`,
		);
	}
	if (
		!row.providerChargeId ||
		!row.agreementId ||
		!row.billedCostDecimal ||
		!row.currency
	) {
		return reject(
			"INVALID_SYNC_INPUT",
			"FOCUS row missing provider id, agreement, billed cost, or currency",
		);
	}
	const billed = money(row.billedCostDecimal, row.currency);
	if (billed === undefined) {
		return reject(
			"INVALID_SYNC_INPUT",
			`invalid billed cost for ${row.providerChargeId}`,
		);
	}
	let effective: Money | undefined;
	if (row.effectiveCostDecimal !== undefined) {
		effective = money(row.effectiveCostDecimal, row.currency);
		if (effective === undefined) {
			return reject(
				"INVALID_SYNC_INPUT",
				`invalid effective cost for ${row.providerChargeId}`,
			);
		}
	}
	return create(ActualChargeSchema, {
		id: row.providerChargeId,
		agreementId: row.agreementId,
		chargeId: row.chargeId,
		billedCost: billed,
		effectiveCost: effective,
		category: row.category,
		observedAt: syncAt,
	});
}
