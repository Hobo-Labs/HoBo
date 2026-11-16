/**
 * The runner order: the ordered list of runner types an account or a
 * repository prefers, and the two rearrangements a single job can ask of it.
 *
 * The order is authored data (`RunnerOrder` in `data-models/runner_route.proto`)
 * and crosses one parser, `parseRunnerOrder`. What comes out is the generated
 * record, checked and frozen, so the walk in `./decide.ts` never re-checks a
 * step.
 *
 * Pure functions: no clock, network or store.
 */
import { create, fromJsonString } from "@bufbuild/protobuf";
import {
	type RunnerOrder,
	RunnerOrderSchema,
	type RunnerOrderStep,
	RunnerOrderStepSchema,
	type RunnerRetryPolicy,
	RunnerRetryPolicySchema,
} from "../_generated/runner_route_pb.js";
import {
	DEFAULT_RUNNER_AUTO_SIZE,
	isHostedRunnerProvider,
	type RunnerAutoSize,
	type RunnerStepKey,
	runnerAutoSize,
	runnerStepKey,
} from "./providers.js";

declare const parsedRunnerOrder: unique symbol;
/** A runner order that passed `parseRunnerOrder`: every step is one the walk knows. */
export type ParsedRunnerOrder = RunnerOrder & {
	readonly [parsedRunnerOrder]: true;
};

// public-contract: the most steps one runner order may hold.
export const MAX_RUNNER_ORDER_STEPS = 16;
// public-contract: the share of included minutes a new `github` limit starts at.
export const DEFAULT_MINUTES_LIMIT_PERCENT = 80;
// public-contract: the monthly spend, in US dollars, a new provider limit starts at.
export const DEFAULT_SPEND_LIMIT_USD = 100;

export const RUNNER_RETRY_TARGETS = ["any", "same", "other"] as const;
export type RunnerRetryTarget = (typeof RUNNER_RETRY_TARGETS)[number];

/** A step's key. Total on a parsed order; `machine` stands in for a key no parser admitted. */
export function stepKey(step: RunnerOrderStep): RunnerStepKey {
	return runnerStepKey(step.key) ?? "machine";
}

/**
 * Where a step sits for uniqueness: its key, with a limited and an unlimited
 * `github` step counted apart, so "GitHub while under 80%, then machines,
 * then GitHub regardless" is one order.
 */
function stepSlot(step: RunnerOrderStep): string {
	return step.key === "github" && step.minutesLimitPercent > 0
		? "github:limited"
		: step.key;
}

function stepProblem(step: RunnerOrderStep): string | undefined {
	const key = runnerStepKey(step.key);
	if (!key) return `unknown runner step "${step.key}"`;
	if (step.minutesLimitPercent > 0) {
		if (key !== "github")
			return `a minutes limit belongs to the github step, not ${key}`;
		if (step.minutesLimitPercent > 100)
			return "a minutes limit is a percentage from 1 to 100";
	}
	if (step.spendLimitUsd > 0) {
		if (!isHostedRunnerProvider(key))
			return `a spend limit belongs to a hosted provider step, not ${key}`;
		if (step.spendLimitUsd > 100_000)
			return "a spend limit is at most 100000 US dollars";
	}
	return undefined;
}

function retryProblem(
	retry: RunnerRetryPolicy | undefined,
): string | undefined {
	if (!retry) return undefined;
	if (!RUNNER_RETRY_TARGETS.some((target) => target === retry.runner))
		return 'retry.runner is "any", "same" or "other"';
	if (retry.max !== 1 && retry.max !== 2) return "retry.max is 1 or 2";
	return undefined;
}

function orderProblem(order: RunnerOrder): string | undefined {
	if (order.steps.length === 0) return "a runner order needs at least one step";
	if (order.steps.length > MAX_RUNNER_ORDER_STEPS)
		return `a runner order holds at most ${MAX_RUNNER_ORDER_STEPS} steps`;
	const seen = new Set<string>();
	for (const step of order.steps) {
		const problem = stepProblem(step);
		if (problem) return problem;
		const slot = stepSlot(step);
		if (seen.has(slot))
			return step.key === "github"
				? "github may appear twice only as one limited and one unlimited step"
				: `the ${step.key} step appears more than once`;
		seen.add(slot);
	}
	if (order.autoSizeVcpus !== 0 && !runnerAutoSize(order.autoSizeVcpus))
		return "autoSizeVcpus is 2, 4, 8, 16 or 32";
	return retryProblem(order.retry);
}

function frozen(order: RunnerOrder): ParsedRunnerOrder {
	for (const step of order.steps) Object.freeze(step);
	Object.freeze(order.steps);
	if (order.retry) Object.freeze(order.retry);
	// SAFETY: `orderProblem` found nothing wrong, which is exactly what the brand states.
	return Object.freeze(order) as ParsedRunnerOrder;
}

/** The order, checked and frozen. Throws with the first thing wrong with it. */
export function defineRunnerOrder(order: RunnerOrder): ParsedRunnerOrder {
	const problem = orderProblem(order);
	if (problem) throw new Error(`invalid runner order: ${problem}`);
	return frozen(order);
}

/** Parse protobuf JSON for a `RunnerOrder`. Throws on an unknown field or a broken rule. */
export function parseRunnerOrder(json: string): ParsedRunnerOrder {
	return defineRunnerOrder(fromJsonString(RunnerOrderSchema, json));
}

/**
 * The order a repository gets when it has written none: the fleet it runs
 * itself, then machines people have connected, then GitHub-hosted, which is
 * always there. A job only ever takes a step its relay named, so this order
 * costs nothing a workflow did not ask for.
 */
export const DEFAULT_RUNNER_ORDER: ParsedRunnerOrder = defineRunnerOrder(
	create(RunnerOrderSchema, {
		steps: [{ key: "fleet" }, { key: "machine" }, { key: "github" }],
	}),
);

/** The stored order when it parses, the default when there is none or it does not. */
export function runnerOrderOrDefault(
	json: string | undefined,
): ParsedRunnerOrder {
	if (json === undefined || json.trim().length === 0)
		return DEFAULT_RUNNER_ORDER;
	try {
		return parseRunnerOrder(json);
	} catch {
		return DEFAULT_RUNNER_ORDER;
	}
}

/** Whether an unhealthy hosted runner type is skipped. On unless the order says otherwise. */
export function skipsUnhealthy(order: ParsedRunnerOrder): boolean {
	return order.skipUnhealthy ?? true;
}

/** The size an `auto` input asks for under this order. */
export function orderAutoSize(order: ParsedRunnerOrder): RunnerAutoSize {
	return runnerAutoSize(order.autoSizeVcpus) ?? DEFAULT_RUNNER_AUTO_SIZE;
}

/** The retry policy, off when the order holds none. */
export function orderRetryPolicy(order: ParsedRunnerOrder): RunnerRetryPolicy {
	return (
		order.retry ??
		create(RunnerRetryPolicySchema, { enabled: false, runner: "any", max: 1 })
	);
}

function reordered(
	order: ParsedRunnerOrder,
	steps: readonly RunnerOrderStep[],
): ParsedRunnerOrder {
	return frozen(
		create(RunnerOrderSchema, {
			...order,
			steps: steps.map((step) => create(RunnerOrderStepSchema, step)),
		}),
	);
}

/**
 * The same order with every step of `first` moved to the top, the rest in
 * their written order. Used when one job is told to try a runner type first.
 */
export function preferFirst(
	order: ParsedRunnerOrder,
	first: RunnerStepKey | undefined,
): ParsedRunnerOrder {
	if (!first || !order.steps.some((step) => step.key === first)) return order;
	return reordered(order, [
		...order.steps.filter((step) => step.key === first),
		...order.steps.filter((step) => step.key !== first),
	]);
}

/**
 * The order a retried job walks. `same` puts the step it failed on first,
 * `other` puts it last, `any` leaves the order as written. A failed step the
 * order no longer holds changes nothing.
 */
export function retryOrder(
	order: ParsedRunnerOrder,
	failed: RunnerStepKey | undefined,
	target: RunnerRetryTarget,
): ParsedRunnerOrder {
	if (target === "same") return preferFirst(order, failed);
	if (
		target === "any" ||
		!failed ||
		!order.steps.some((step) => step.key === failed)
	)
		return order;
	return reordered(order, [
		...order.steps.filter((step) => step.key !== failed),
		...order.steps.filter((step) => step.key === failed),
	]);
}
