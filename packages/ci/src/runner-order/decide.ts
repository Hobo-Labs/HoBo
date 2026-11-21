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
	RUNNER_INPUT_AUTO,
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
	isGithubHostedLabel,
	isProviderLabel,
	RUNNER_PROVIDER_CATALOG,
	RUNNER_STEP_KEYS,
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

export type FleetState = Readonly<{
	enabled: boolean;
	taking: boolean;
	isolated: boolean;
}>;

export type RouteRetry = Readonly<{
	target: RunnerRetryTarget;
	failedStep: RunnerStepKey | undefined;
	failedMachineId: string | undefined;
}>;

export type RouteFacts = Readonly<{
	fleet: FleetState | undefined;
	machines: readonly MachineCandidate[];
	minutes: MinutesUsage | undefined;
	spendUsd: ReadonlyMap<HostedRunnerProvider, number>;
	unhealthy: ReadonlySet<string>;
	publicOptIn: ReadonlySet<HostedRunnerProvider>;
	first: RunnerStepKey | undefined;
	retry: RouteRetry | undefined;
}>;

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
			busy: Target | undefined;
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
	if (!isGithubHostedLabel(label)) return skip("not_provider_label", label);
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
	if (!request.private && stance !== "yes" && !facts.publicOptIn.has(key))
		return skip("public_repository");
	if (request.fork) return skip("fork_pull_request");
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

export function effectiveRelayInputs(
	order: ParsedRunnerOrder,
	request: RunnerRouteRequest,
): RelayInputs {
	const inputs = relayInputs(request.inputs);
	if (request.inputs.length > 0 && inputs.size === 0) return inputs;
	const requested =
		request.inputs.length === 0
			? new Map<RunnerStepKey, readonly string[]>(
					RUNNER_STEP_KEYS.map((key) => [key, [RUNNER_INPUT_AUTO]] as const),
				)
			: inputs;
	return resolveAutoInputs(requested, orderAutoSize(order), request.runId);
}

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

export function decideRunnerRoute(
	order: ParsedRunnerOrder,
	request: RunnerRouteRequest,
	facts: RouteFacts = NO_ROUTE_FACTS,
): RunnerRouteDecision {
	if (request.fork === undefined)
		return create(RunnerRouteDecisionSchema, {
			outcome: "none",
			reason:
				"No runner available. The fork fact is required: RunnerRouteRequest.fork is unset, so whether the run comes from a fork is unknown and routing cannot be decided safely.",
			skipped: [],
			notInOrder: [],
		});
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
		if (!key) throw new Error(`unknown runner step "${step.key}"`);
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
	if (busy)
		return create(RunnerRouteDecisionSchema, {
			outcome: "waiting",
			runner: busy.runner,
			step: busy.step,
			machineId: busy.machineId,
			skipped,
			notInOrder,
		});
	if (unhealthy)
		return create(RunnerRouteDecisionSchema, {
			outcome: "routed",
			runner: unhealthy.runner,
			step: unhealthy.step,
			skipped,
			notInOrder,
			unhealthyFallback: true,
		});
	return create(RunnerRouteDecisionSchema, {
		outcome: "none",
		reason: noRunnerReason(skipped, notInOrder),
		skipped,
		notInOrder,
	});
}

export function describeDecision(decision: RunnerRouteDecision): string {
	if (decision.outcome === "none") return decision.reason;
	const where = `${decision.runner} (${decision.step})`;
	if (decision.outcome === "waiting")
		return `Queued on ${where}: every runner that fits is busy.`;
	return decision.unhealthyFallback
		? `Routed to ${where}, which has been failing to start jobs; nothing else could take it.`
		: `Routed to ${where}.`;
}
