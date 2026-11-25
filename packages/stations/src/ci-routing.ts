import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type Account,
	AccountSchema,
	type AccountState,
	BudgetRoutingPolicySchema,
	type BudgetSignal,
	BudgetSignalSchema,
	ciBudgetPolicy,
	ciBudgetPolicyJson,
	ciBudgetSignalKey,
	ciBudgetSignalUpdate,
} from "@hobo/ci";

/** The account-scoped relay client implements this port without a Station dependency. */
export interface CiBudgetRoutingClient {
	getPolicy(): Promise<AccountState>;
	getSignalState?(): Promise<AccountState>;
	publishBudgetSignal?(
		signal: BudgetSignal,
		options: { revision: number },
	): Promise<AccountState>;
	putPolicy(
		account: Account,
		options: { revision: number },
	): Promise<AccountState>;
}

export interface CiBudgetRoutingOutcome {
	changed: boolean;
	revision: number;
}

export interface CiBudgetRoutingBridge {
	/** Deliver the Broker fact's {type,data}; retry a revision conflict from the journal. */
	accept(serializedBrokerFact: string): Promise<CiBudgetRoutingOutcome>;
	/** Apply a changed routing profile to the already persisted signal state. */
	reconcile(): Promise<CiBudgetRoutingOutcome>;
}

type CiBudgetRoutingPolicyInput = NonNullable<
	Parameters<typeof create<typeof BudgetRoutingPolicySchema>>[1]
>;

function uniqueOfferIds(ids: readonly string[]): readonly string[] {
	if (
		ids.some((id) => !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) ||
		new Set(ids).size !== ids.length
	)
		throw new Error("invalid or duplicate CI routing offer identifier");
	return Object.freeze([...ids]);
}

/** Translate tenant-scoped Broker budget transitions into durable CI eligibility.
 * Monetary snapshots and active leases remain owned by the relay. Profile changes
 * affect future admissions; they never move or repeat an already admitted job.
 */
export function createCiBudgetRoutingBridge(options: {
	policy: CiBudgetRoutingPolicyInput;
	client: CiBudgetRoutingClient;
}): CiBudgetRoutingBridge {
	const policy = fromJsonString(
		BudgetRoutingPolicySchema,
		toJsonString(
			BudgetRoutingPolicySchema,
			create(BudgetRoutingPolicySchema, options.policy),
		),
	);
	if (
		!/^[a-zA-Z0-9_-]{1,80}$/.test(policy.accountId) ||
		!policy.tenantId ||
		policy.thresholds.length === 0 ||
		policy.thresholds.some(
			(rule) =>
				!Number.isFinite(rule.thresholdFraction) ||
				rule.thresholdFraction <= 0 ||
				rule.thresholdFraction > 1,
		) ||
		new Set(policy.thresholds.map((rule) => rule.thresholdFraction)).size !==
			policy.thresholds.length
	)
		throw new Error("invalid CI budget routing policy");
	const common = ciBudgetPolicy(policy);
	if (
		common &&
		(common.tenantId !== policy.tenantId || !common.workloads.includes("ci"))
	)
		throw new Error("CI budget routing policy scope is invalid");
	const accountId = policy.accountId;
	const normal = uniqueOfferIds(policy.normalOfferIds);
	const thresholds = Object.freeze(
		policy.thresholds
			.map((rule) =>
				Object.freeze({
					fraction: rule.thresholdFraction,
					offerIds: uniqueOfferIds(rule.offerIds),
				}),
			)
			.sort((left, right) => right.fraction - left.fraction),
	);
	const key = (fraction: number) => ciBudgetSignalKey(policy, fraction);

	async function state() {
		const current =
			policy.budgetPolicy && options.client.getSignalState
				? await options.client.getSignalState()
				: await options.client.getPolicy();
		if (current.account?.id !== accountId)
			throw new Error("CI routing account does not match relay policy");
		if (
			ciBudgetPolicyJson(current.account.budgetPolicy) !==
			ciBudgetPolicyJson(policy.budgetPolicy)
		)
			throw new Error("CI routing budget scope does not match relay policy");
		const account = fromJsonString(
			AccountSchema,
			toJsonString(AccountSchema, current.account),
		);
		const offers = new Set(account.offers.map((offer) => offer.id));
		if (
			[normal, ...thresholds.map((rule) => rule.offerIds)].some((ids) =>
				ids.some((id) => !offers.has(id)),
			)
		)
			throw new Error("CI routing profile references an unknown offer");
		return { account, revision: current.revision };
	}
	function eligibility(account: Account): boolean {
		const profile =
			thresholds.find(
				(rule) => account.routingSignalCrossed[key(rule.fraction)] === true,
			)?.offerIds ?? normal;
		const allowed = new Set(profile);
		let changed = false;
		for (const offer of account.offers) {
			const enabled = allowed.has(offer.id);
			if (enabled !== offer.enabled) changed = true;
			offer.enabled = enabled;
		}
		return changed;
	}
	async function write(account: Account, revision: number) {
		const saved = await options.client.putPolicy(account, { revision });
		return { changed: true, revision: saved.revision };
	}
	return Object.freeze({
		async accept(serializedBrokerFact: string) {
			const signal = fromJsonString(BudgetSignalSchema, serializedBrokerFact);
			const update = ciBudgetSignalUpdate(signal, policy);
			if (!update) throw new Error("invalid or foreign CI budget signal");
			const { account, revision } = await state();
			if (update.watermark <= (account.routingSignalCycles[update.key] ?? 0))
				return { changed: false, revision };
			if (policy.budgetPolicy) {
				if (!options.client.publishBudgetSignal)
					throw new Error("scoped CI routing requires the budget signal API");
				const saved = await options.client.publishBudgetSignal(signal, {
					revision,
				});
				return {
					changed: saved.revision !== revision,
					revision: saved.revision,
				};
			}
			account.routingSignalCycles[update.key] = update.watermark;
			account.routingSignalCrossed[update.key] = update.crossed;
			eligibility(account);
			return write(account, revision);
		},
		async reconcile() {
			const { account, revision } = await state();
			// Scoped eligibility is derived by the relay from its desired policy.
			// Publishing observations cannot rewrite provider enablement or trust.
			if (policy.budgetPolicy) return { changed: false, revision };
			return eligibility(account)
				? write(account, revision)
				: { changed: false, revision };
		},
	});
}
