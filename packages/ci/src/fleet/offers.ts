/**
 * Where the fleet's financial models meet the relay's runtime offers.
 *
 * An offer is what an operator connected: a provider account, a label, a
 * ceiling. A model is what that provider charges. These functions read one in
 * terms of the other, so the balancer can rank the offers an account really
 * has and an operator can seed an offer's rate from the model instead of
 * typing it.
 */

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

/** Isolated hosts are the box worker and a kubernetes isolated-container pod. */
function isIsolatedHost(offer: OfferIdentity): boolean {
	return (
		offer.provider === "hobo-box-worker" ||
		offer.backend === "isolated-container"
	);
}

/**
 * The model that prices an offer. Several machine classes can share one
 * provider; the offer's label picks the class, and the provider's first
 * label-bound model stands in for a label the catalog has no class for.
 */
export function runnerModelForOffer(
	offer: OfferIdentity,
): RunnerFinancialModel | undefined {
	if (isIsolatedHost(offer))
		return RUNNER_FINANCIAL_MODELS.find((model) => model.id === "hobo-box");
	// A Dagger engine or a Sandbox under the same provider hosts no runner a
	// job's label could reach.
	if (offer.backend !== "" && offer.backend !== "gh-actions") return undefined;
	const provided = RUNNER_FINANCIAL_MODELS.filter(
		(model) => model.provider === offer.provider && model.binding === "label",
	);
	return provided.find((model) => model.runsOn === offer.runsOn) ?? provided[0];
}

/**
 * An isolated host is always primary. Any other offer takes its model's role;
 * a provider with no model is unranked.
 */
export function fleetRoleOfOffer(offer: OfferIdentity): FleetRole | undefined {
	return runnerModelForOffer(offer)?.role;
}

/**
 * The rate fields of an offer, read from its model: what an operator posts as
 * the offer's rate observation. Balances and spend are account facts and are
 * not here.
 */
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
	/** Label injected runners serve for this account's pool, normally `hobo`. */
	poolLabel: string;
	/** Other labels the pool's runners register with, such as `hobo-trunk`. */
	extraPoolLabels?: readonly string[];
	/** Offers whose circuit breaker is open. */
	unhealthyOfferIds?: ReadonlySet<string>;
	/** Opt-in providers where the owner has turned public repositories on. */
	publicRepositoryOfferIds?: ReadonlySet<string>;
}>;

/**
 * The fleet as this account really has it: one member per connected offer the
 * catalog can price. The provider's model supplies what does not vary by
 * account (rounding, plan fee, eligibility, tier); the offer supplies what
 * the operator observed for this account (label, rate, included minutes,
 * ceiling, evidence dates), and the leases supply what is in use.
 *
 * An offer no model prices (a Vercel Sandbox, a Dagger engine) is left out:
 * it is not a runner host this balancer can compare.
 */
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
		// As in admission: usage the offer's observation already covers is in
		// its balances and is not counted a second time.
		const counted = (lease: Lease) =>
			lease.state === "completed" &&
			shouldCountLocalUsage(lease, offer.observedAt);
		const settled = mine.filter(counted);
		// One provider account can back several offers; its spend is all of them.
		const payerLeases = leases.filter((lease) =>
			lease.providerAccountId
				? lease.provider === offer.provider &&
					lease.providerAccountId === offer.providerAccountId
				: lease.offerId === offer.id,
		);
		const freeUsed =
			holding.reduce((sum, lease) => sum + lease.reservedFreeMinutes, 0) +
			settled.reduce((sum, lease) => sum + lease.billedFreeMinutes, 0);
		// The account's observed allowance replaces the catalog's, never adds to it.
		// So does its ceiling: a plan-dependent limit is whatever the operator set.
		const {
			monthlyFreeMinutes: _catalogAllowance,
			concurrency: _catalogCeiling,
			...structural
		} = base;
		// One label can be several priced classes (GitHub prices a public and a
		// private repository differently). The offer carries this account's rate,
		// so the member serves every repository any of those classes serves.
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
		// A connected offer is an account that already exists.
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
				activeJobs: holding.length,
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

/**
 * The policy the balancer evaluates for an account. An authored shared budget
 * policy is used as written. An account without one still goes through the
 * same evaluator, under a policy that says exactly what its legacy ceiling
 * said: one budget, no other constraint.
 */
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

/** Spend and held commitments against the account's whole budget. */
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
