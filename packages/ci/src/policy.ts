import { type create, fromJsonString } from "@bufbuild/protobuf";
import {
	type DesiredCiPolicy,
	DesiredCiPolicySchema,
} from "./_generated/policy_pb.js";

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
	"kubernetes",
	"hobo-box-worker",
	"local",
	"vercel",
	"azure-devops",
]);

/** Parse a data manifest; provider/Station authority is resolved by the host. */
export function parseCiPolicy(json: string): ParsedCiPolicy {
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
		policy.routing?.strategy !== "lowest-total-incremental-cost" ||
		policy.routing.noEligibleProvider !== "queue" ||
		policy.routing.unknownAllocation !== "zero"
	)
		throw new Error("unsupported CI routing strategy");
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
			(provider.kind === "local" && provider.runsOn !== "hobo-local-host")
		)
			throw new Error("invalid CI provider declaration");
		ids.add(provider.id);
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
	account: import("./_generated/ci_pb.js").Account,
	policy: ParsedCiPolicy,
): import("./_generated/ci_pb.js").Account {
	if (account.id !== policy.accountId)
		throw new Error("policy belongs to another account");
	const threshold = [...policy.thresholds]
		.sort((left, right) => right.fraction - left.fraction)
		.find(
			(entry) =>
				account.routingSignalCrossed[
					`broker:${policy.tenantId}:${entry.fraction}`
				] === true,
		);
	const allowed = threshold ? new Set(threshold.allow) : undefined;
	return {
		...account,
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
