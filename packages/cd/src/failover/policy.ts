// Parse boundary and pure rules for failover (D23, I21): Rail permission with
// its defaults, the node's purge policy, NO_RUN toleration, and the
// `failover-unsafe` data check. Nothing here reads a clock or the journal.
import {
	type FailoverPolicyRecord,
	PurgeMode,
	type RailDeliveryRecord,
	type ReasonRecord,
	type TaintRecord,
	TaintEffect,
	type TolerationRecord,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, FAILOVER_UNSAFE } from "../events.js";
import { msOf, reason } from "../fanout/journal.js";

export const FAILOVER_REASON = Object.freeze({
	unsafe: FAILOVER_UNSAFE,
	notTainted: "failover-not-tainted",
	noPlacedNode: "failover-no-placed-node",
	noQualifiedFreight: "failover-no-qualified-freight",
	handoverMissing: "failover-handover-missing",
	placementContextMissing: "placement-context-missing",
	noReplacement: "failover-no-replacement",
	residency: "failover-residency-failed",
	promotionRefused: "failover-promotion-refused",
	replacementFailed: "failover-replacement-failed",
	graceExpired: "failover-grace-expired",
	trafficUnrealized: "failover-traffic-unrealized",
	immediatePurgeNotPermitted: "failover-immediate-purge-not-permitted",
	purgeRefused: "failover-purge-refused",
	notFound: "failover-not-found",
	wrongState: "failover-wrong-state",
	proposalOnly: "proposal-only",
	awaitingApproval: "failover-awaiting-approval",
	awaitingBudget: "failover-awaiting-concurrency",
	rebalanceNoPlacement: "rebalance-node-not-placed",
} as const);

/** Rail `delivery.failover` with every unset field at its default (R13). */
export type RailFailover = Readonly<{
	automatic: boolean;
	maxConcurrent: number;
	allowImmediatePurge: boolean;
}>;

export function railFailover(rail: RailDeliveryRecord | undefined): RailFailover {
	const declared = rail?.failover;
	return {
		automatic: declared?.automatic ?? CD_DEFAULTS.failoverAutomatic,
		maxConcurrent:
			declared !== undefined && declared.maxConcurrent > 0
				? declared.maxConcurrent
				: CD_DEFAULTS.failoverMaxConcurrent,
		allowImmediatePurge: declared?.allowImmediatePurge ?? false,
	};
}

/** The node's failover policy with defaults: GRACEFUL, 30-minute grace. */
export type NodeFailover = Readonly<{
	purge: PurgeMode;
	graceMs: number;
	handoverOutputs: readonly string[];
}>;

export function nodeFailover(policy: FailoverPolicyRecord | undefined): NodeFailover {
	return {
		purge:
			policy === undefined || policy.purge === PurgeMode.UNSPECIFIED
				? PurgeMode.GRACEFUL
				: policy.purge,
		graceMs:
			policy !== undefined && policy.graceMs > 0n
				? Number(policy.graceMs)
				: CD_DEFAULTS.failoverGraceMs,
		handoverOutputs: [...(policy?.handoverOutputs ?? [])].sort(),
	};
}

function tolerates(toleration: TolerationRecord, taint: TaintRecord): boolean {
	if (toleration.key !== taint.key) return false;
	if (toleration.value !== "" && toleration.value !== taint.value) return false;
	return (
		toleration.effect === TaintEffect.UNSPECIFIED ||
		toleration.effect === TaintEffect.NO_RUN
	);
}

/**
 * True once a NO_RUN taint has outlived what the node's tolerations cover:
 * a matching toleration with `toleration_ms` 0 tolerates forever; otherwise
 * the longest matching toleration, else CD_DEFAULTS.noRunTolerationMs.
 */
export function noRunDue(
	taint: TaintRecord,
	tolerations: readonly TolerationRecord[],
	nowMs: number,
): boolean {
	if (taint.effect !== TaintEffect.NO_RUN) return false;
	const matching = tolerations.filter((toleration) => tolerates(toleration, taint));
	if (matching.some((toleration) => toleration.tolerationMs === 0n)) return false;
	const graceMs =
		matching.length > 0
			? Math.max(...matching.map((toleration) => Number(toleration.tolerationMs)))
			: CD_DEFAULTS.noRunTolerationMs;
	return nowMs >= msOf(taint.addedAt) + graceMs;
}

/** Failover moves compute only (I21): any data resource in the source refuses it. */
export function failoverUnsafe(
	input: Readonly<{ fromCampId: string; dataResources: readonly string[] }>,
): readonly ReasonRecord[] | undefined {
	if (input.dataResources.length === 0) return undefined;
	return [
		reason(
			FAILOVER_REASON.unsafe,
			`Camp ${input.fromCampId} holds the Bindle's data resources (${input.dataResources.join(", ")}); failover moves compute only`,
			"run a Trails replica handover first: expand a replica of each data resource reachable from the replacement, cut over, then contract; retry the failover once no data lives in the failing Camp",
			input.fromCampId,
		),
	];
}

export function unreachableData(
	fromCampId: string,
	toCampId: string,
): readonly ReasonRecord[] {
	return [
		reason(
			FAILOVER_REASON.unsafe,
			`the Bindle's data resources are not reachable from replacement Camp ${toCampId} over a Junction`,
			"declare a Junction from the replacement to the data's Camp, or run a Trails replica handover; data never moves",
			fromCampId,
		),
	];
}
