import { randomUUID } from "node:crypto";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: FOCUS billing rows are parsed once at the provider billing JSON boundary. */

/**
 * Provider billing port — lives outside the pure quote/rating path (§12 Phase 5).
 * Implementations must not perform live network I/O in unit tests; use fixture ports.
 */

export type SyntheticProviderCredentials = Readonly<{
	authorization: string;
}>;

export type FocusBillingRow = Readonly<{
	providerChargeId: string;
	agreementId: string;
	chargeId: string;
	chargePeriodStart: string;
	chargePeriodEnd: string;
	billedCostDecimal: string;
	currency: string;
	effectiveCostDecimal?: string;
	category: string;
	completeness: "complete" | "partial";
	focusVersion?: string;
}>;

export type ProviderBillingFetchRequest = Readonly<{
	syncAt: string;
	periodStart: string;
	periodEnd: string;
	credentials: SyntheticProviderCredentials;
}>;

export interface ProviderBillingPort {
	fetchFocusRows(
		request: ProviderBillingFetchRequest,
	): Promise<readonly FocusBillingRow[]>;
}

export function createSyntheticProviderCredentials(): SyntheticProviderCredentials {
	return {
		authorization: `Bearer synth-${randomUUID()}`,
	};
}

function requiredString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseFocusBillingRow(
	value: JsonValue,
): FocusBillingRow | undefined {
	if (!isJsonObject(value)) return undefined;
	const completeness = value.completeness;
	if (completeness !== "complete" && completeness !== "partial") {
		return undefined;
	}
	const providerChargeId = requiredString(value.providerChargeId);
	const agreementId = requiredString(value.agreementId);
	const chargeId = requiredString(value.chargeId);
	const chargePeriodStart = requiredString(value.chargePeriodStart);
	const chargePeriodEnd = requiredString(value.chargePeriodEnd);
	const billedCostDecimal = requiredString(value.billedCostDecimal);
	const currency = requiredString(value.currency);
	const category = requiredString(value.category);
	if (
		providerChargeId === undefined ||
		agreementId === undefined ||
		chargeId === undefined ||
		chargePeriodStart === undefined ||
		chargePeriodEnd === undefined ||
		billedCostDecimal === undefined ||
		currency === undefined ||
		category === undefined
	) {
		return undefined;
	}
	const row: FocusBillingRow = {
		providerChargeId,
		agreementId,
		chargeId,
		chargePeriodStart,
		chargePeriodEnd,
		billedCostDecimal,
		currency,
		category,
		completeness,
	};
	let parsed: FocusBillingRow = row;
	if (typeof value.effectiveCostDecimal === "string") {
		parsed = { ...parsed, effectiveCostDecimal: value.effectiveCostDecimal };
	}
	if (typeof value.focusVersion === "string") {
		parsed = { ...parsed, focusVersion: value.focusVersion };
	}
	return parsed;
}

export function focusBillingRowToJson(row: FocusBillingRow): JsonObject {
	const out: JsonObject = {
		providerChargeId: row.providerChargeId,
		agreementId: row.agreementId,
		chargeId: row.chargeId,
		chargePeriodStart: row.chargePeriodStart,
		chargePeriodEnd: row.chargePeriodEnd,
		billedCostDecimal: row.billedCostDecimal,
		currency: row.currency,
		category: row.category,
		completeness: row.completeness,
	};
	if (row.effectiveCostDecimal !== undefined) {
		out.effectiveCostDecimal = row.effectiveCostDecimal;
	}
	if (row.focusVersion !== undefined) {
		out.focusVersion = row.focusVersion;
	}
	return out;
}

export function focusBillingRowsToJson(
	rows: readonly FocusBillingRow[],
): JsonValue {
	return rows.map(focusBillingRowToJson);
}
