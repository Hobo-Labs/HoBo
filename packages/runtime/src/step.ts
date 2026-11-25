// `step` — the side-effecting unit of a durable workflow (sdk-api.md §Layer 4).
// A step runs once; its result is journaled as `run.StepCompleted` so replay
// short-circuits it after a restart. This module holds the authoring wrapper
// plus the retry policy the workflow engine applies when a step's body throws.

import type { StepOptions } from "./ctx.js";
import {
	FatalError,
	RetryableError,
	WorkflowExecutionAborted,
	WorkflowFailure,
} from "./errors.js";
import type { JsonValue } from "./json.js";

export type { StepOptions } from "./ctx.js";

export const DEFAULT_STEP_RETRIES = 3;

/** A named, reusable step definition (`step(fn, opts?)`). */
export interface StepDefinition<A extends JsonValue[], R> {
	readonly name: string;
	readonly options: StepOptions;
	handler(...args: A): Promise<R> | R;
}

/**
 * Wrap a function as a durable step. Invoked inside a workflow via
 * `ctx.step(step.name, () => step.handler(...))`, its result is memoized in the
 * event log; a bare call outside a run just executes the body.
 */
export function defineStep<A extends JsonValue[], R>(
	name: string,
	handler: (...args: A) => Promise<R> | R,
	options: StepOptions = {},
): StepDefinition<A, R> {
	if (!name) {
		throw new TypeError("step name must be a non-empty string");
	}
	return Object.freeze({ name, options, handler });
}

/** Alias matching the sdk-api spelling `step(fn, opts)` (name derived if omitted). */
export function step<A extends JsonValue[], R>(
	handler: (...args: A) => Promise<R> | R,
	options: StepOptions & { name?: string } = {},
): StepDefinition<A, R> {
	const { name, ...rest } = options;
	// `||`, not `??`: an anonymous body has `name === ""`, and a nullish check
	// would let that empty name reach `defineStep`, which refuses it. The
	// documented fallback would then never fire.
	return defineStep(name || handler.name || "step", handler, rest);
}

/**
 * Run a step body under the retry budget. `FatalError` stops immediately;
 * `RetryableError` overrides the budget; an exhausted budget surfaces as a
 * `WorkflowFailure` the engine journals as `run.StepFailed` + `run.Failed`.
 */
export async function runWithRetries<T>(
	name: string,
	fn: () => Promise<T> | T,
	options: StepOptions = {},
): Promise<T> {
	const baseBudget = options.retries ?? DEFAULT_STEP_RETRIES;
	let attempt = 0;
	let budget = baseBudget;

	for (;;) {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof WorkflowExecutionAborted) throw error;
			if (error instanceof FatalError) {
				throw new WorkflowFailure(`step ${name} failed fatally`, {
					step: name,
					cause: error,
				});
			}
			if (error instanceof RetryableError && error.retries !== undefined) {
				budget = error.retries;
			}
			attempt += 1;
			if (attempt > budget) {
				throw new WorkflowFailure(
					`step ${name} exhausted retry budget (${budget})`,
					{
						step: name,
						cause: error instanceof Error ? error : new Error(String(error)),
					},
				);
			}
		}
	}
}
