// Parse boundary for a fan-out (D21): a recorded PlacementDecisionRecord plus
// a FanoutRecord become one FanoutPlan with every limit resolved to a count
// against the decision's size. Nothing downstream re-reads the wire records,
// so an unresolved percent, an unknown mandatory group or a Camp in two
// groups cannot reach the scheduler (parse, don't validate).
import {
	type FanoutRecord,
	FanoutStrategy,
	type PlacementDecisionRecord,
	type ReasonRecord,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type { Outcome } from "../ports.js";
import { reason } from "./journal.js";

export type FanoutStrategyName =
	| "ALL"
	| "PROGRESSIVE"
	| "PROGRESSIVE_PER_GROUP";

export type FanoutGroup = Readonly<{
	name: string;
	campIds: readonly string[];
	mandatory: boolean;
}>;

/** A fan-out with every limit resolved to a count. */
export type FanoutPlan = Readonly<{
	strategy: FanoutStrategyName;
	/** ≥ 1. Camps in flight at once, never exceeded (I20). */
	maxConcurrency: number;
	/** Failures tolerated; one more halts (I20). */
	maxFailures: number;
	minSuccessMs: number;
	progressDeadlineMs: number;
	rollbackOnHalt: boolean;
	/** Run order: mandatory groups first, then the rest, each in decision order. */
	groups: readonly FanoutGroup[];
	/** Every Camp in run order. */
	campIds: readonly string[];
}>;

export const FANOUT_REASON = Object.freeze({
	invalid: "fanout-invalid",
	emptyDecision: "fanout-empty-decision",
	decisionMismatch: "fanout-decision-mismatch",
	unknownMandatoryGroup: "fanout-mandatory-group-unknown",
	duplicateCamp: "fanout-duplicate-camp",
	freightUnusable: "fanout-freight-unusable",
	notFound: "fanout-not-found",
	wrongState: "fanout-wrong-state",
	operatorHalt: "fanout-halted-by-operator",
	proposalOnly: "proposal-only",
	budgetExceeded: "fanout-failure-budget-exceeded",
	mandatoryFailed: "fanout-mandatory-group-failed",
	progressDeadline: "fanout-progress-deadline",
	promotionFailed: "fanout-promotion-failed",
	promotionRefused: "fanout-promotion-refused",
	superseded: "fanout-superseded",
	awaitingSupersede: "fanout-awaiting-supersede",
	campTainted: "camp-tainted",
	campUnreachable: "camp-unreachable",
	campStatusUnknown: "camp-status-unknown",
	campNotManaged: "camp-not-managed",
	windowClosed: "window-closed",
	rollbackRefused: "fanout-rollback-refused",
	departureRefused: "fanout-departure-refused",
} as const);

function percentOf(total: number, percent: number): number {
	return Math.ceil((total * percent) / 100);
}

function strategyName(strategy: FanoutStrategy): FanoutStrategyName {
	switch (strategy) {
		case FanoutStrategy.ALL:
			return "ALL";
		case FanoutStrategy.PROGRESSIVE:
			return "PROGRESSIVE";
		default:
			return CD_DEFAULTS.fanoutStrategy;
	}
}

function invalid(
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return reason(FANOUT_REASON.invalid, message, remediation, subject);
}

/** Selected Camps of a decision grouped in decision order (one implicit group when none). */
function decisionGroups(
	decision: PlacementDecisionRecord,
	mandatoryNames: ReadonlySet<string>,
): FanoutGroup[] {
	if (decision.groups.length > 0) {
		return [...decision.groups]
			.sort((a, b) => a.index - b.index)
			.map((group) => ({
				name: group.name,
				campIds: [...group.campIds],
				mandatory: group.mandatory || mandatoryNames.has(group.name),
			}));
	}
	const selected = decision.candidates
		.filter((candidate) => candidate.selected)
		.map((candidate) => candidate.campId);
	return [{ name: "all", campIds: selected, mandatory: false }];
}

export function parseFanoutPlan(
	input: Readonly<{
		pipeline: string;
		node: string;
		decision: PlacementDecisionRecord;
		fanout: FanoutRecord;
	}>,
): Outcome<FanoutPlan> {
	const { decision, fanout } = input;
	if (decision.pipeline !== input.pipeline || decision.node !== input.node) {
		return {
			ok: false,
			reasons: [
				reason(
					FANOUT_REASON.decisionMismatch,
					`decision ${decision.decisionId} is for ${decision.pipeline}/${decision.node}, not ${input.pipeline}/${input.node}`,
					"start the fan-out with the placement decision recorded for this node",
					decision.decisionId,
				),
			],
		};
	}
	const problems: ReasonRecord[] = [];
	if (fanout.maxConcurrency > 0 && fanout.maxConcurrencyPercent > 0)
		problems.push(
			invalid(
				"max_concurrency and max_concurrency_percent are both set",
				"set a count or a percent, not both",
				"max_concurrency",
			),
		);
	if (fanout.maxFailures > 0 && fanout.maxFailuresPercent > 0)
		problems.push(
			invalid(
				"max_failures and max_failures_percent are both set",
				"set a count or a percent, not both",
				"max_failures",
			),
		);
	if (fanout.maxConcurrencyPercent > 100 || fanout.maxFailuresPercent > 100)
		problems.push(
			invalid("a percent exceeds 100", "use a percent in 0..100", "percent"),
		);
	const mandatoryNames = new Set(fanout.mandatoryGroups);
	const groups = decisionGroups(decision, mandatoryNames);
	const known = new Set(groups.map((group) => group.name));
	for (const name of [...mandatoryNames].sort()) {
		if (!known.has(name))
			problems.push(
				reason(
					FANOUT_REASON.unknownMandatoryGroup,
					`mandatory group "${name}" is not a group of decision ${decision.decisionId}`,
					"name a group the placement declares, or remove it from mandatory_groups",
					name,
				),
			);
	}
	const seen = new Set<string>();
	for (const group of groups) {
		for (const campId of group.campIds) {
			if (seen.has(campId))
				problems.push(
					reason(
						FANOUT_REASON.duplicateCamp,
						`Camp ${campId} appears in more than one group`,
						"re-decide the placement; a Camp belongs to exactly one group",
						campId,
					),
				);
			seen.add(campId);
		}
	}
	if (seen.size === 0)
		problems.push(
			reason(
				FANOUT_REASON.emptyDecision,
				`decision ${decision.decisionId} selects no Camp`,
				"widen the placement or bind more Camp sets to the Rail",
				decision.decisionId,
			),
		);
	if (problems.length > 0) return { ok: false, reasons: problems };

	const ordered = [
		...groups.filter((group) => group.mandatory),
		...groups.filter((group) => !group.mandatory),
	];
	const total = seen.size;
	// "concurrency = group size" (I.9): the decision's largest group, else the
	// default group size (10% of the decision).
	const groupSize = Math.max(
		1,
		decision.groups.length > 0
			? Math.max(...groups.map((group) => group.campIds.length))
			: percentOf(total, CD_DEFAULTS.fanoutGroupSizePercent),
	);
	const maxConcurrency =
		fanout.maxConcurrency > 0
			? fanout.maxConcurrency
			: fanout.maxConcurrencyPercent > 0
				? Math.max(1, percentOf(total, fanout.maxConcurrencyPercent))
				: strategyName(fanout.strategy) === "ALL"
					? total
					: groupSize;
	const maxFailures =
		fanout.maxFailures > 0
			? fanout.maxFailures
			: Math.floor(
					(total *
						(fanout.maxFailuresPercent > 0
							? fanout.maxFailuresPercent
							: CD_DEFAULTS.fanoutMaxFailuresPercent)) /
						100,
				);
	return {
		ok: true,
		value: {
			strategy: strategyName(fanout.strategy),
			maxConcurrency,
			maxFailures,
			minSuccessMs:
				fanout.minSuccessMs > 0n
					? Number(fanout.minSuccessMs)
					: CD_DEFAULTS.fanoutMinSuccessMs,
			progressDeadlineMs:
				fanout.progressDeadlineMs > 0n
					? Number(fanout.progressDeadlineMs)
					: CD_DEFAULTS.fanoutProgressDeadlineMs,
			rollbackOnHalt: fanout.rollbackOnHalt,
			groups: ordered,
			campIds: ordered.flatMap((group) => group.campIds),
		},
	};
}
