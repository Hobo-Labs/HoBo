/**
 * The walk: one relay job's question answered against a runner order.
 *
 * The order is walked top to bottom and the job takes the first step that can
 * run it now. A step is passed over, with a recorded reason, when the relay
 * did not name it, when a rule forbids it (a public repository on someone's
 * machine, a limit that has been reached, a runner type that stopped
 * starting jobs) or when it has nothing free.
 *
 * What happens when no step takes the job depends on why:
 *
 * - A hosted runner type passed over only for being unhealthy takes the job
 *   after all. A slow runner beats no runner.
 * - Otherwise, a step that would have taken the job but is busy (a full
 *   machine, a full fleet) is waited on: the job is given that step's label
 *   and queues on GitHub, as it would on any self-hosted runner.
 * - Otherwise nothing can take it, and the answer is a reason. The relay job
 *   fails with that reason instead of leaving a job queued for a runner that
 *   will never come.
 *
 * The answer is a `RunnerRouteDecision` record: where the job goes, and every
 * step that was passed over on the way, so "why did this run there" can be
 * read back later without replaying anything.
 *
 * Pure functions: no clock, network or store.
 */
import { create } from "@bufbuild/protobuf";
import {
	type RunnerOrderStep,
	type RunnerRouteDecision,
	RunnerRouteDecisionSchema,
	type RunnerRouteRequest,
	type RunnerRouteSkip,
	RunnerRouteSkipSchema,
} from "../_generated/runner_route_pb.js";
import { providerHealthKey } from "./health.js";
import {
	isUnresolvedAuto,
	type RelayInputs,
	relayInputs,
	resolveAutoInputs,
} from "./inputs.js";
import { type MinutesUsage, minutesVerdict, spendVerdict } from "./limits.js";
import { chooseMachine, type MachineCandidate } from "./machines.js";
import {
	orderAutoSize,
	type ParsedRunnerOrder,
	preferFirst,
	type RunnerRetryTarget,
	retryOrder,
	skipsUnhealthy,
	stepKey,
} from "./order.js";
import {
	type HostedRunnerProvider,
	isProviderLabel,
	RUNNER_PROVIDER_CATALOG,
	type RunnerStepKey,
} from "./providers.js";

// public-contract: every reason the walk gives for passing over a step.
export const RUNNER_SKIP_REASONS = [
	"not_configured",
	"public_repository",
	"fork_pull_request",
	"needs_isolation",
	"no_size",
	"too_many_labels",
	"not_provider_label",
	"minutes_limit",
	"minutes_runway",
	"spend_limit",
	"provider_unhealthy",
	"fleet_off",
	"fleet_full",
	"no_machine",
	"machine_paused",
	"machine_not_shared",
	"machine_full",
] as const;
export type RunnerSkipReason = (typeof RUNNER_SKIP_REASONS)[number];

/** What the HoBo fleet can do for this repository right now. */
export type FleetState = Readonly<{
	/** The fleet serves this repository. */
	enabled: boolean;
	/** It has room for one more job now. */
	taking: boolean;
	/**
	 * Every job gets a machine nothing else shares, discarded afterwards, and
	 * the owner has acknowledged running untrusted code there. Required for a
	 * public repository or a fork's pull request.
	 */
	isolated: boolean;
}>;

/** A job being run again after a failure outside its own steps. */
export type RouteRetry = Readonly<{
	target: RunnerRetryTarget;
	failedStep: RunnerStepKey | undefined;
	failedMachineId: string | undefined;
}>;

/** Everything the walk needs to know that the order and the relay do not say. */
export type RouteFacts = Readonly<{
	fleet: FleetState | undefined;
	machines: readonly MachineCandidate[];
	/** The account's Actions minutes. Absent when not measured. */
	minutes: MinutesUsage | undefined;
	/** US dollars spent this month, per hosted provider. A missing entry is unmeasured. */
	spendUsd: ReadonlyMap<HostedRunnerProvider, number>;
	/** Runner types currently tripped, as `providerHealthKey` values. */
	unhealthy: ReadonlySet<string>;
	/** Providers the owner has turned on for public repositories at the provider. */
	publicOptIn: ReadonlySet<HostedRunnerProvider>;
	/** One job told to try a runner type first. */
	first: RunnerStepKey | undefined;
	retry: RouteRetry | undefined;
}>;

/** Facts for a repository about which nothing has been measured. */
export const NO_ROUTE_FACTS: RouteFacts = {
	fleet: undefined,
	machines: [],
	minutes: undefined,
	spendUsd: new Map(),
	unhealthy: new Set(),
	publicOptIn: new Set(),
	first: undefined,
	retry: undefined,
};

type Target = Readonly<{
	step: RunnerStepKey;
	runner: string;
	machineId: string;
}>;

type StepResult =
	| Readonly<{ kind: "take"; target: Target }>
	| Readonly<{
			kind: "skip";
			reason: RunnerSkipReason;
			detail: string;
			/** The step would have taken the job but is busy: its label can be waited on. */
			busy: Target | undefined;
			/** The step was passed over only for being unhealthy. */
			unhealthy: Target | undefined;
	  }>;

function skip(reason: RunnerSkipReason, detail = ""): StepResult {
	return {
		kind: "skip",
		reason,
		detail,
		busy: undefined,
		unhealthy: undefined,
	};
}

function take(step: RunnerStepKey, runner: string, machineId = ""): StepResult {
	return { kind: "take", target: { step, runner, machineId } };
}

type OneLabel = Readonly<{ label: string }> | Readonly<{ refused: StepResult }>;

/** The one label a step that takes a single label was given, or the reason there is none. */
function singleLabel(labels: readonly string[]): OneLabel {
	if (isUnresolvedAuto(labels)) return { refused: skip("no_size") };
	const label = labels[0];
	if (labels.length !== 1 || !label)
		return { refused: skip("too_many_labels", labels.join(", ")) };
	return { label };
}

function fleetStep(
	labels: readonly string[],
	request: RunnerRouteRequest,
	facts: RouteFacts,
): StepResult {
	if (!facts.fleet?.enabled) return skip("fleet_off");
	if ((!request.private || request.fork) && !facts.fleet.isolated)
		return skip("needs_isolation");
	const one = singleLabel(labels);
	if ("refused" in one) return one.refused;
	const { label } = one;
	if (facts.fleet.taking) return take("fleet", label);
	return {
		kind: "skip",
		reason: "fleet_full",
		detail: "",
		busy: { step: "fleet", runner: label, machineId: "" },
		unhealthy: undefined,
	};
}

function machineStep(
	labels: readonly string[],
	request: RunnerRouteRequest,
	facts: RouteFacts,
): StepResult {
	if (!request.private) return skip("public_repository");
	if (request.fork) return skip("fork_pull_request");
	const choice = chooseMachine(facts.machines, {
		labels,
		repository: request.repository,
		starterId: request.actorId || undefined,
		triggeredById: request.triggeringActorId || undefined,
		preferMachineId:
			facts.retry?.target === "same" ? facts.retry.failedMachineId : undefined,
		avoidMachineId:
			facts.retry?.target === "other" ? facts.retry.failedMachineId : undefined,
	});
	if (choice.kind === "machine")
		return take("machine", choice.machine.runsOn, choice.machine.id);
	const about = choice.machine;
	return {
		kind: "skip",
		reason: choice.reason,
		detail: about?.name ?? labels.join(", "),
		busy:
			choice.reason === "machine_full" && about
				? { step: "machine", runner: about.runsOn, machineId: about.id }
				: undefined,
		unhealthy: undefined,
	};
}

function githubStep(
	step: RunnerOrderStep,
	labels: readonly string[],
	facts: RouteFacts,
): StepResult {
	const one = singleLabel(labels);
	if ("refused" in one) return one.refused;
	const { label } = one;
	if (step.minutesLimitPercent > 0) {
		const verdict = minutesVerdict(step.minutesLimitPercent, facts.minutes);
		if (!verdict.allowed) return skip(verdict.reason, verdict.detail);
	}
	return take("github", label);
}

function hostedStep(
	key: HostedRunnerProvider,
	step: RunnerOrderStep,
	labels: readonly string[],
	context: Readonly<{
		order: ParsedRunnerOrder;
		request: RunnerRouteRequest;
		facts: RouteFacts;
	}>,
): StepResult {
	const { order, request, facts } = context;
	const stance = RUNNER_PROVIDER_CATALOG.get(key)?.publicRepositories;
	if (!request.private && stance === "opt-in" && !facts.publicOptIn.has(key))
		return skip("public_repository");
	const one = singleLabel(labels);
	if ("refused" in one) return one.refused;
	const { label } = one;
	if (!isProviderLabel(key, label)) return skip("not_provider_label", label);
	if (step.spendLimitUsd > 0) {
		const verdict = spendVerdict(step.spendLimitUsd, facts.spendUsd.get(key));
		if (!verdict.allowed) return skip(verdict.reason, verdict.detail);
	}
	if (
		skipsUnhealthy(order) &&
		facts.unhealthy.has(providerHealthKey(key, label))
	)
		return {
			kind: "skip",
			reason: "provider_unhealthy",
			detail: label,
			busy: undefined,
			unhealthy: { step: key, runner: label, machineId: "" },
		};
	return take(key, label);
}

function skipRecord(
	key: RunnerStepKey,
	result: Extract<StepResult, { kind: "skip" }>,
): RunnerRouteSkip {
	return create(RunnerRouteSkipSchema, {
		key,
		reason: result.reason,
		detail: result.detail,
	});
}

/** The labels each step was given, with `auto` turned into the order's size. */
export function effectiveRelayInputs(
	order: ParsedRunnerOrder,
	request: RunnerRouteRequest,
): RelayInputs {
	return resolveAutoInputs(
		relayInputs(request.inputs),
		orderAutoSize(order),
		request.runId,
	);
}

/** Steps the relay named that the order leaves out. They are never tried. */
function namedButNotOrdered(
	order: ParsedRunnerOrder,
	request: RunnerRouteRequest,
): readonly RunnerStepKey[] {
	const ordered = new Set(order.steps.map(stepKey));
	return [...relayInputs(request.inputs).keys()].filter(
		(key) => !ordered.has(key),
	);
}

const SKIP_TEXT: ReadonlyMap<RunnerSkipReason, string> = new Map<
	RunnerSkipReason,
	string
>([
	["not_configured", "the relay did not name it"],
	["public_repository", "the repository is public"],
	["fork_pull_request", "the run comes from a fork"],
	[
		"needs_isolation",
		"the repository is public or the run comes from a fork, and the fleet is not set up to isolate such jobs",
	],
	["no_size", "it has no machine of the size auto asks for"],
	["too_many_labels", "it takes exactly one label"],
	["not_provider_label", "the label is not one of its own"],
	["minutes_limit", "the included-minutes limit is reached"],
	["minutes_runway", "the included minutes are about to run out"],
	["spend_limit", "the monthly spend limit is reached"],
	["provider_unhealthy", "it has stopped starting jobs"],
	["fleet_off", "the fleet does not serve this repository"],
	["fleet_full", "the fleet is full"],
	["no_machine", "no connected machine has those labels"],
	["machine_paused", "the machine is paused"],
	["machine_not_shared", "no machine is shared with whoever started this run"],
	["machine_full", "every machine is busy"],
]);

/** One passed-over step as a clause: `github: the included-minutes limit is reached (…)`. */
export function describeSkip(skipped: RunnerRouteSkip): string {
	const text =
		SKIP_TEXT.get(
			RUNNER_SKIP_REASONS.find((reason) => reason === skipped.reason) ??
				"not_configured",
		) ?? skipped.reason;
	return skipped.detail.length > 0
		? `${skipped.key}: ${text} (${skipped.detail})`
		: `${skipped.key}: ${text}`;
}

/**
 * Why nothing took the job, as one sentence a person can act on. Steps the
 * relay simply did not name are left out unless they are all there is.
 */
export function noRunnerReason(
	skipped: readonly RunnerRouteSkip[],
	notInOrder: readonly string[],
): string {
	const named = skipped.filter((entry) => entry.reason !== "not_configured");
	const clauses = (named.length > 0 ? named : skipped).map(describeSkip);
	const outside =
		notInOrder.length > 0
			? ` Not in the runner order, so never tried: ${notInOrder.join(", ")}.`
			: "";
	const why =
		clauses.length > 0
			? clauses.join("; ")
			: "the runner order and the relay name no step in common";
	return `No runner available. ${why}.${outside}`;
}

/**
 * Answer one relay job. `order` is the account's or the repository's runner
 * order, `request` what the relay asked, `facts` what is known right now.
 */
export function decideRunnerRoute(
	order: ParsedRunnerOrder,
	request: RunnerRouteRequest,
	facts: RouteFacts = NO_ROUTE_FACTS,
): RunnerRouteDecision {
	const inputs = effectiveRelayInputs(order, request);
	const walked = retryOrder(
		preferFirst(order, facts.first),
		facts.retry?.failedStep,
		facts.retry?.target ?? "any",
	);
	const notInOrder = [...namedButNotOrdered(order, request)];
	const skipped: RunnerRouteSkip[] = [];
	let busy: Target | undefined;
	let unhealthy: Target | undefined;
	for (const step of walked.steps) {
		const key = stepKey(step);
		const labels = inputs.get(key);
		const result: StepResult = !labels
			? skip("not_configured")
			: key === "fleet"
				? fleetStep(labels, request, facts)
				: key === "machine"
					? machineStep(labels, request, facts)
					: key === "github"
						? githubStep(step, labels, facts)
						: hostedStep(key, step, labels, { order, request, facts });
		if (result.kind === "take")
			return create(RunnerRouteDecisionSchema, {
				outcome: "routed",
				runner: result.target.runner,
				step: result.target.step,
				machineId: result.target.machineId,
				skipped,
				notInOrder,
			});
		skipped.push(skipRecord(key, result));
		busy ??= result.busy;
		unhealthy ??= result.unhealthy;
	}
	if (unhealthy)
		return create(RunnerRouteDecisionSchema, {
			outcome: "routed",
			runner: unhealthy.runner,
			step: unhealthy.step,
			skipped,
			notInOrder,
			unhealthyFallback: true,
		});
	if (busy)
		return create(RunnerRouteDecisionSchema, {
			outcome: "waiting",
			runner: busy.runner,
			step: busy.step,
			machineId: busy.machineId,
			skipped,
			notInOrder,
		});
	return create(RunnerRouteDecisionSchema, {
		outcome: "none",
		reason: noRunnerReason(skipped, notInOrder),
		skipped,
		notInOrder,
	});
}

/** One line for a log or a job summary: where the job goes, or why nowhere. */
export function describeDecision(decision: RunnerRouteDecision): string {
	if (decision.outcome === "none") return decision.reason;
	const where = `${decision.runner} (${decision.step})`;
	if (decision.outcome === "waiting")
		return `Queued on ${where}: every runner that fits is busy.`;
	return decision.unhealthyFallback
		? `Routed to ${where}, which has been failing to start jobs; nothing else could take it.`
		: `Routed to ${where}.`;
}
