
import { type BudgetPolicy, parseBudgetPolicy } from "@hobo/core";
import type { Account, Lease } from "../_generated/ci_pb.js";
import { ciBudgetPolicy, ciRoutingObjective } from "../policy.js";
import { ACTIVE_STATES, shouldCountLocalUsage } from "../routing.js";
import type { FleetMemberState } from "./balance.js";
import {
	type FleetRole,
	RUNNER_FINANCIAL_MODELS,
	type RunnerFinancialModel,
} from "./models.js";
import { type RunnerCommercialState, usdToMicrosCeil } from "./pricing.js";

type OfferIdentity = Readonly<{
	provider: string;
	backend: string;
	runsOn: string;
}>;

function isIsolatedHost(offer: OfferIdentity): boolean {
	return (
		offer.provider === "hobo-box-worker" ||
		offer.backend === "isolated-container"
	);
}

export function runnerModelForOffer(
	offer: OfferIdentity,
): RunnerFinancialModel | undefined {
	if (isIsolatedHost(offer))
		return RUNNER_FINANCIAL_MODELS.find((model) => model.id === "hobo-box");
	if (offer.backend !== "" && offer.backend !== "gh-actions") return undefined;
	const provided = RUNNER_FINANCIAL_MODELS.filter(
		(model) => model.provider === offer.provider && model.binding === "label",
	);
	return provided.find((model) => model.runsOn === offer.runsOn) ?? provided[0];
}

export function fleetRoleOfOffer(offer: OfferIdentity): FleetRole | undefined {
	return runnerModelForOffer(offer)?.role;
}

export function modelledOfferTerms(model: RunnerFinancialModel) {
	const priceMicrosPerMinute = usdToMicrosCeil(model.usdPerMinute);
	if (priceMicrosPerMinute === undefined)
		throw new TypeError(`invalid modelled rate ${model.usdPerMinute}`);
	return {
		priceMicrosPerMinute,
		freeMinutes: Number(model.monthlyFreeMinutes ?? "0"),
		concurrency: model.concurrency,
		sourceUrl: model.evidence.source,
		observedAt: model.evidence.observedAt,
		validUntil: model.evidence.validUntil,
	};
}

function usdFromMicros(micros: number): string {
	if (!Number.isSafeInteger(micros) || micros < 0)
		throw new TypeError("offer rate must be whole nonnegative microdollars");
	const whole = Math.floor(micros / 1_000_000);
	const fraction = String(micros % 1_000_000).padStart(6, "0");
	return `${whole}.${fraction}`;
}

export type FleetAccountFacts = Readonly<{
	poolLabel: string;
	extraPoolLabels?: readonly string[];
	unhealthyOfferIds?: ReadonlySet<string>;
	publicRepositoryOfferIds?: ReadonlySet<string>;
}>;

export function fleetMembersFromAccount(
	account: Account,
	leases: readonly Lease[],
	facts: FleetAccountFacts,
): FleetMemberState[] {
	return account.offers.flatMap((offer) => {
		const base = runnerModelForOffer(offer);
		if (!base) return [];
		const isolated = isIsolatedHost(offer);
		const mine = leases.filter((lease) => lease.offerId === offer.id);
		const holding = mine.filter((lease) => ACTIVE_STATES.has(lease.state));
		const counted = (lease: Lease) =>
			lease.state === "completed" &&
			shouldCountLocalUsage(lease, offer.observedAt);
		const settled = mine.filter(counted);
		const payerLeases = leases.filter((lease) =>
			lease.providerAccountId
				? lease.provider === offer.provider &&
					lease.providerAccountId === offer.providerAccountId
				: lease.offerId === offer.id,
		);
		const freeUsed =
			holding.reduce((sum, lease) => sum + lease.reservedFreeMinutes, 0) +
			settled.reduce((sum, lease) => sum + lease.billedFreeMinutes, 0);
		const {
			monthlyFreeMinutes: _catalogAllowance,
			concurrency: _catalogCeiling,
			...structural
		} = base;
		const classes = RUNNER_FINANCIAL_MODELS.filter(
			(candidate) =>
				!isolated &&
				candidate.provider === base.provider &&
				candidate.binding === base.binding &&
				candidate.runsOn === base.runsOn,
		);
		const observed: RunnerFinancialModel = {
			...structural,
			eligibility: {
				...base.eligibility,
				publicRepositories: classes.some(
					(candidate) => candidate.eligibility.publicRepositories === "yes",
				)
					? "yes"
					: base.eligibility.publicRepositories,
				privateRepositories:
					base.eligibility.privateRepositories ||
					classes.some(
						(candidate) => candidate.eligibility.privateRepositories,
					),
			},
			id: offer.id,
			binding: isolated ? "inject" : base.binding,
			runsOn: isolated ? facts.poolLabel : offer.runsOn,
			usdPerMinute: usdFromMicros(offer.priceMicrosPerMinute),
			evidence: {
				...base.evidence,
				source: offer.sourceUrl || base.evidence.source,
				observedAt: offer.observedAt,
				validUntil: offer.validUntil,
			},
		};
		const hasAllowance = offer.freeMinutes > 0;
		const model: RunnerFinancialModel = hasAllowance
			? { ...observed, monthlyFreeMinutes: String(offer.freeMinutes) }
			: observed;
		const commercial: RunnerCommercialState = hasAllowance
			? {
					subscribed: true,
					allowanceRemainingMinutes: String(
						Math.max(0, offer.freeMinutes - freeUsed),
					),
				}
			: { subscribed: true };
		return [
			{
				model,
				enabled: offer.enabled,
				concurrency: offer.concurrency,
				activeJobs: payerLeases.filter((lease) =>
					ACTIVE_STATES.has(lease.state),
				).length,
				healthy: facts.unhealthyOfferIds?.has(offer.id) !== true,
				commercial,
				publicRepositoriesEnabled:
					facts.publicRepositoryOfferIds?.has(offer.id) === true,
				payer: offer.providerAccountId,
				payerExposureMicros:
					offer.spentMicros +
					payerLeases
						.filter((lease) => ACTIVE_STATES.has(lease.state))
						.reduce((sum, lease) => sum + lease.reservedPaidMicros, 0) +
					payerLeases
						.filter(counted)
						.reduce((sum, lease) => sum + lease.paidMicros, 0),
				payerBudgetMicros: offer.budgetMicros,
				servesLabels: isolated ? (facts.extraPoolLabels ?? []) : [],
			},
		];
	});
}

export function fleetBudgetPolicy(account: Account): BudgetPolicy {
	return (
		ciBudgetPolicy(account) ??
		parseBudgetPolicy({
			schemaVersion: "hobo.budget-policy/v1",
			tenantId: account.id,
			budgetId: "ci-account",
			periodId: "legacy",
			revision: "legacy",
			workloads: ["ci"],
			currency: "USD",
			limitMicros: account.budgetMicros,
			objective: ciRoutingObjective(account.routingStrategy),
			enforcement: "conservative",
			periodKind: "manual",
			constraints: [],
		})
	);
}

export function fleetAccountExposure(
	account: Account,
	leases: readonly Lease[],
) {
	const mine = leases.filter((lease) => lease.accountId === account.id);
	const holding = mine.filter((lease) => ACTIVE_STATES.has(lease.state));
	return {
		exposureMicros:
			account.spentMicros +
			holding.reduce((sum, lease) => sum + lease.reservedPaidMicros, 0) +
			mine
				.filter(
					(lease) =>
						lease.state === "completed" &&
						(!account.usageObservedAt ||
							shouldCountLocalUsage(lease, account.usageObservedAt)),
				)
				.reduce((sum, lease) => sum + lease.paidMicros, 0),
		activeWork: holding.length,
		ceilingMicros: account.budgetMicros,
	};
}
