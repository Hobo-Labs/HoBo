import type { Account } from "@hobo/ci";

export function commonBudget(periodId = "period-a", limitMicros = 1_000_000) {
	const constraints: {
		key: string;
		workload: string;
		unit: string;
		maximum: number;
		target?: string;
	}[] = [];
	return {
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "tenant-a",
		budgetId: "shared-budget",
		periodId,
		revision: "revision-a",
		workloads: ["ci", "hosting"],
		currency: "USD",
		limitMicros,
		objective: "min-cost",
		enforcement: "conservative",
		periodKind: "manual",
		constraints,
	};
}

export function commonCiIntent(
	account: Account,
	budgetPolicy = commonBudget(),
) {
	return {
		accountId: account.id,
		tenantId: budgetPolicy.tenantId,
		pool: { label: "hobo", os: "linux", architecture: "x64" },
		providers: account.offers.map((offer) => ({
			id: offer.id,
			kind: offer.provider,
			connectionRef: offer.providerAccountId,
			runsOn: offer.runsOn,
			enabled: true,
		})),
		budget: {
			scope: "ci-account",
			currency: "USD",
			limitMicros: budgetPolicy.limitMicros,
			period: "manual",
			timeZone: "UTC",
		},
		routing: {
			strategy: "min-cost",
			noEligibleProvider: "queue",
			unknownAllocation: "zero",
		},
		thresholds: [{ fraction: 1, allow: [] }],
		budgetPolicy,
	};
}
