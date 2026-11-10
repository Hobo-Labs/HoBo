import {
	type create,
	fromJsonString,
	type JsonObject,
} from "@bufbuild/protobuf";
import {
	type BudgetPolicy,
	budgetScopeIdentityKey,
	budgetThresholdSignalKey,
	canonicalBudgetPolicyJson,
	parseBudgetPolicy,
	parseBudgetPolicyDocumentJson,
} from "@hobo/core";
import type { Account, BudgetSignal } from "./_generated/ci_pb.js";
import {
	type CiPolicyProvider,
	type DesiredCiPolicy,
	DesiredCiPolicySchema,
} from "./_generated/policy_pb.js";
import { isGithubLatestLabel } from "./fleet-overflow.js";

declare const parsedCiPolicy: unique symbol;
/** Generated authored intent, parsed and frozen before publishing. */
export type ParsedCiPolicy = DesiredCiPolicy & {
	readonly [parsedCiPolicy]: true;
};

const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const connectionPattern = /^[A-Za-z0-9_.:/-]{1,200}$/;
const labelPattern = /^[A-Za-z0-9_.-]{1,100}$/;
const providers = new Set([
	"github",
	"blacksmith",
	"depot",
	"warpbuild",
	"jog",
	"boat",
	"lizard",
	"kubernetes",
	"hobo-box-worker",
	"local",
	"vercel",
	"azure-devops",
	"dagger",
	"cloudflare",
]);

const kubernetesName = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const vercelLocations = new Set(["vercel", "local", "remote"]);

/**
 * Kind-specific fields are closed: only kubernetes carries a scale set or an
 * engine, only vercel carries a location. An empty vercel location is the
 * protobuf default of policies persisted before locations existed; authored
 * `.hobo/ci.json` requires it.
 */
function providerKindFieldsAllowed(provider: CiPolicyProvider): boolean {
	const { capacity } = provider;
	if (capacity.case !== undefined && provider.kind !== "kubernetes")
		return false;
	if (capacity.case === "scaleSet") {
		const scaleSet = capacity.value;
		if (
			!kubernetesName.test(scaleSet.name) ||
			!kubernetesName.test(scaleSet.namespace) ||
			!Number.isInteger(scaleSet.maxRunners) ||
			scaleSet.maxRunners < 1 ||
			scaleSet.maxRunners > 1000 ||
			scaleSet.minRunners > scaleSet.maxRunners
		)
			return false;
	}
	if (capacity.case === "engine" && !kubernetesName.test(capacity.value.name))
		return false;
	return provider.kind === "vercel"
		? provider.location === "" || vercelLocations.has(provider.location)
		: provider.location === "";
}

export function ciBudgetPolicy(value: {
	budgetPolicy?: JsonObject | undefined;
}): BudgetPolicy | undefined {
	return value.budgetPolicy ? parseBudgetPolicy(value.budgetPolicy) : undefined;
}

/** Exact canonical content identity; it is never a caller-supplied digest. */
export function ciBudgetPolicyJson(value?: JsonObject): string {
	return value ? canonicalBudgetPolicyJson(parseBudgetPolicy(value)) : "";
}

export function ciRoutingObjective(
	strategy: string,
): "min-cost" | "maximize-credits" {
	if (
		!strategy ||
		strategy === "min-cost" ||
		strategy === "lowest-total-incremental-cost"
	)
		return "min-cost";
	if (strategy === "maximize-credits") return "maximize-credits";
	throw new Error("unsupported CI routing strategy");
}

export function ciBudgetIdentity(
	account: { budgetPolicy?: JsonObject | undefined },
	at: string,
) {
	const common = ciBudgetPolicy(account);
	if (!common)
		return {
			budgetTenantId: "",
			budgetId: "",
			budgetPeriodId: "",
			budgetPolicyRevision: "",
			budgetPolicyDigest: "",
		};
	const now = Date.parse(at);
	if (
		!Number.isFinite(now) ||
		(common.periodKind === "fixed-window" &&
			(common.periodStartsAtMs === undefined ||
				common.periodEndsAtMs === undefined ||
				now < common.periodStartsAtMs ||
				now >= common.periodEndsAtMs))
	)
		throw new Error("CI budget period is not active");
	return {
		budgetTenantId: common.tenantId,
		budgetId: common.budgetId,
		budgetPeriodId: common.periodId,
		budgetPolicyRevision: String(common.revision),
		budgetPolicyDigest: canonicalBudgetPolicyJson(common),
	};
}

export function ciQueueBudgetMs(account: {
	budgetPolicy?: JsonObject | undefined;
}): number | undefined {
	const common = ciBudgetPolicy(account);
	const applicable =
		common?.constraints
			.filter(
				(constraint) =>
					constraint.key === "ci.queue.duration" &&
					(constraint.workload === "*" || constraint.workload === "ci") &&
					constraint.unit === "ms" &&
					!constraint.target,
			)
			.map((constraint) => constraint.maximum) ?? [];
	return applicable.length ? Math.min(...applicable) : undefined;
}

type CiSignalPolicy = {
	tenantId: string;
	budgetPolicy?: JsonObject | undefined;
	thresholds?:
		| readonly { fraction?: number; thresholdFraction?: number }[]
		| undefined;
};

export function ciBudgetSignalKey(
	policy: CiSignalPolicy,
	fraction: number,
): string {
	const common = ciBudgetPolicy(policy);
	if (common && common.tenantId !== policy.tenantId)
		throw new Error("CI signal policy tenant mismatch");
	return common
		? `broker:v2:${budgetScopeIdentityKey({ tenantId: common.tenantId, budgetId: common.budgetId, periodId: common.periodId, policyRevision: String(common.revision) })}:${fraction}`
		: `broker:${policy.tenantId}:${fraction}`;
}

/** One parser for hosted control and both Station adapters. Scoped reset cycle
 * zero maps to persisted watermark one; old keys remain in the audit state. */
export function ciBudgetSignalUpdate(
	signal: BudgetSignal,
	expected: CiSignalPolicy,
) {
	const data = signal.data;
	const common = ciBudgetPolicy(expected);
	if (
		!data ||
		data.tenantId !== expected.tenantId ||
		!Number.isFinite(data.thresholdFraction) ||
		data.thresholdFraction <= 0 ||
		data.thresholdFraction > 1 ||
		!Number.isFinite(data.budgetUsd) ||
		data.budgetUsd < 0 ||
		!Number.isFinite(data.thresholdUsd) ||
		data.thresholdUsd !==
			Number((data.thresholdFraction * data.budgetUsd).toFixed(9)) ||
		!Number.isFinite(data.netSpentUsd) ||
		!Number.isSafeInteger(data.cycle) ||
		data.cycle < 0 ||
		data.cycle > 4294967295
	)
		throw new Error("invalid or foreign CI budget signal");
	const transition =
		signal.type === "budget.StateReset"
			? "reset"
			: signal.type === "budget.ThresholdCrossed"
				? "crossed"
				: signal.type === "budget.Recovered"
					? "recovered"
					: undefined;
	if (!transition) throw new Error("unsupported CI budget signal transition");
	const crossed =
		transition === "reset" ? data.crossed : transition === "crossed";
	if (
		crossed === undefined ||
		(data.crossed !== undefined && data.crossed !== crossed) ||
		(transition !== "reset" &&
			data.netSpentUsd >= data.thresholdUsd !== crossed)
	)
		throw new Error("budget signal state disagrees with threshold");
	if (common) {
		const identity = {
			tenantId: common.tenantId,
			budgetId: common.budgetId,
			periodId: common.periodId,
			policyRevision: String(common.revision),
		};
		if (
			expected.tenantId !== common.tenantId ||
			!data.identity ||
			data.crossed === undefined ||
			budgetScopeIdentityKey(data.identity) !==
				budgetScopeIdentityKey(identity) ||
			data.budgetUsd !== common.limitMicros / 1_000_000 ||
			!/^[a-f0-9]{64}$/.test(data.policyDigest) ||
			data.signalKey !==
				budgetThresholdSignalKey(
					identity,
					data.thresholdFraction,
					transition,
					data.cycle,
				) ||
			(transition === "reset"
				? data.cycle !== 0 ||
					data.netSpentUsd !== 0 ||
					crossed !== (data.budgetUsd === 0)
				: data.cycle < 1) ||
			data.cycle >= 4294967295
		)
			throw new Error("budget signal identity, revision or reset mismatch");
		return {
			key: ciBudgetSignalKey(expected, data.thresholdFraction),
			watermark: data.cycle + 1,
			crossed,
		};
	}
	if (
		data.identity ||
		transition === "reset" ||
		data.budgetUsd <= 0 ||
		data.cycle < 1 ||
		data.signalKey !==
			`budget:${expected.tenantId}:${data.thresholdFraction}:${transition}:${data.cycle}`
	)
		throw new Error("legacy budget signal identity mismatch");
	return {
		key: ciBudgetSignalKey(expected, data.thresholdFraction),
		watermark: data.cycle,
		crossed,
	};
}

/** The core parser has established the complete policy structure beforehand. */
function freezeBudgetPolicy(value: JsonObject): void {
	Object.freeze(value.workloads);
	if (Array.isArray(value.constraints))
		for (const constraint of value.constraints) Object.freeze(constraint);
	Object.freeze(value.constraints);
	Object.freeze(value);
}

/** Parse a data manifest; provider/Station authority is resolved by the host. */
export function parseCiPolicy(json: string): ParsedCiPolicy {
	parseBudgetPolicyDocumentJson(json);
	const policy = fromJsonString(DesiredCiPolicySchema, json);
	if (!idPattern.test(policy.accountId) || !idPattern.test(policy.tenantId))
		throw new Error("invalid CI policy account or tenant");
	if (
		policy.pool?.label !== "hobo" ||
		policy.pool.os !== "linux" ||
		policy.pool.architecture !== "x64"
	)
		throw new Error("unsupported CI runner pool");
	if (
		policy.budget?.scope !== "ci-account" ||
		policy.budget.currency !== "USD" ||
		policy.budget.period !== "manual" ||
		policy.budget.timeZone !== "UTC" ||
		!Number.isSafeInteger(policy.budget.limitMicros) ||
		policy.budget.limitMicros < 0
	)
		throw new Error("invalid or unsupported CI account budget");
	if (
		!["lowest-total-incremental-cost", "min-cost", "maximize-credits"].includes(
			policy.routing?.strategy ?? "",
		) ||
		policy.routing?.noEligibleProvider !== "queue" ||
		policy.routing?.unknownAllocation !== "zero"
	)
		throw new Error("unsupported CI routing strategy");
	const common = ciBudgetPolicy(policy);
	if (
		common &&
		(common.tenantId !== policy.tenantId ||
			!common.workloads.includes("ci") ||
			common.objective !== ciRoutingObjective(policy.routing?.strategy ?? ""))
	)
		throw new Error(
			"common budget policy tenant, workload or objective disagrees with CI intent",
		);
	if (policy.budgetPolicy) freezeBudgetPolicy(policy.budgetPolicy);
	if (policy.providers.length === 0 || policy.providers.length > 100)
		throw new Error("invalid CI provider count");
	const ids = new Set<string>();
	for (const provider of policy.providers) {
		if (
			!idPattern.test(provider.id) ||
			ids.has(provider.id) ||
			!providers.has(provider.kind) ||
			!connectionPattern.test(provider.connectionRef) ||
			!labelPattern.test(provider.runsOn) ||
			provider.runsOn.toLowerCase() === "hobo" ||
			(provider.kind === "github" && isGithubLatestLabel(provider.runsOn)) ||
			(provider.kind === "local" && provider.runsOn !== "hobo-local-host") ||
			!providerKindFieldsAllowed(provider)
		)
			throw new Error("invalid CI provider declaration");
		ids.add(provider.id);
		if (provider.capacity.value) Object.freeze(provider.capacity.value);
		Object.freeze(provider.capacity);
		Object.freeze(provider);
	}
	if (policy.thresholds.length > 100) throw new Error("too many CI thresholds");
	const thresholds = new Set<number>();
	for (const threshold of policy.thresholds) {
		if (
			!Number.isFinite(threshold.fraction) ||
			threshold.fraction <= 0 ||
			threshold.fraction > 1 ||
			thresholds.has(threshold.fraction) ||
			new Set(threshold.allow).size !== threshold.allow.length ||
			threshold.allow.some((id) => !ids.has(id))
		)
			throw new Error("invalid CI threshold profile");
		thresholds.add(threshold.fraction);
		Object.freeze(threshold.allow);
		Object.freeze(threshold);
	}
	Object.freeze(policy.providers);
	Object.freeze(policy.thresholds);
	Object.freeze(policy.pool);
	Object.freeze(policy.budget);
	Object.freeze(policy.routing);
	// SAFETY: all dependent invariants are established above and the record is frozen.
	return Object.freeze(policy) as ParsedCiPolicy;
}

/** Compile deterministic SDK-authored data without resolving or calling providers. */
export function defineCiPolicy(
	input: NonNullable<
		Parameters<typeof create<typeof DesiredCiPolicySchema>>[1]
	>,
): ParsedCiPolicy {
	return parseCiPolicy(JSON.stringify(input));
}

/** Apply operator intent and active threshold gates without re-enabling runtime-disabled offers. */
export function effectiveCiAccount(
	account: Account,
	policy: ParsedCiPolicy,
): Account {
	if (account.id !== policy.accountId)
		throw new Error("policy belongs to another account");
	const previous = ciBudgetPolicy(account);
	const common = ciBudgetPolicy(policy);
	if (
		previous &&
		(!common ||
			previous.tenantId !== common.tenantId ||
			previous.budgetId !== common.budgetId)
	)
		throw new Error(
			"common CI budget authority cannot be dropped or reassigned",
		);
	const threshold = [...policy.thresholds]
		.sort((left, right) => right.fraction - left.fraction)
		.find(
			(entry) =>
				account.routingSignalCrossed[
					ciBudgetSignalKey(policy, entry.fraction)
				] === true,
		);
	const allowed = threshold ? new Set(threshold.allow) : undefined;
	return {
		...account,
		budgetMicros: Math.min(
			account.budgetMicros,
			policy.budget?.limitMicros ?? 0,
			common?.limitMicros ?? Number.MAX_SAFE_INTEGER,
		),
		routingStrategy:
			common?.objective ?? ciRoutingObjective(policy.routing?.strategy ?? ""),
		budgetPolicy: policy.budgetPolicy,
		offers: account.offers.map((offer) => {
			const intended = policy.providers.find((entry) => entry.id === offer.id);
			return {
				...offer,
				enabled:
					offer.enabled &&
					!!intended &&
					intended.enabled &&
					intended.kind === offer.provider &&
					intended.connectionRef === offer.providerAccountId &&
					intended.runsOn === offer.runsOn &&
					(!allowed || allowed.has(offer.id)),
			};
		}),
	};
}
