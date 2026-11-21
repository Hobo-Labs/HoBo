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

export function stepKey(step: RunnerOrderStep): RunnerStepKey | undefined {
	return runnerStepKey(step.key);
}

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

function frozen(order: ParsedRunnerOrder): ParsedRunnerOrder {
	for (const step of order.steps) Object.freeze(step);
	Object.freeze(order.steps);
	if (order.retry) Object.freeze(order.retry);
	return Object.freeze(order);
}

function assertRunnerOrderValid(
	order: RunnerOrder,
): asserts order is ParsedRunnerOrder {
	const problem = orderProblem(order);
	if (problem) throw new Error(`invalid runner order: ${problem}`);
}

export function defineRunnerOrder(order: RunnerOrder): ParsedRunnerOrder {
	assertRunnerOrderValid(order);
	return frozen(order);
}

export function parseRunnerOrder(json: string): ParsedRunnerOrder {
	return defineRunnerOrder(fromJsonString(RunnerOrderSchema, json));
}

export const DEFAULT_RUNNER_ORDER: ParsedRunnerOrder = defineRunnerOrder(
	create(RunnerOrderSchema, {
		steps: [{ key: "fleet" }, { key: "machine" }, { key: "github" }],
	}),
);

export function runnerOrderOrDefault(
	json: string | undefined,
): ParsedRunnerOrder {
	if (json === undefined || json.trim().length === 0)
		return DEFAULT_RUNNER_ORDER;
	return parseRunnerOrder(json);
}

export function skipsUnhealthy(order: ParsedRunnerOrder): boolean {
	return order.skipUnhealthy ?? true;
}

export function orderAutoSize(order: ParsedRunnerOrder): RunnerAutoSize {
	return runnerAutoSize(order.autoSizeVcpus) ?? DEFAULT_RUNNER_AUTO_SIZE;
}

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
	return defineRunnerOrder(
		create(RunnerOrderSchema, {
			...order,
			steps: steps.map((step) => create(RunnerOrderStepSchema, step)),
		}),
	);
}

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
