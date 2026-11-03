import { randomUUID } from "node:crypto";

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
