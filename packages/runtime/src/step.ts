
import type { StepOptions } from "./ctx.js";
import { FatalError, RetryableError, WorkflowFailure } from "./errors.js";
import type { JsonValue } from "./json.js";

export type { StepOptions } from "./ctx.js";

export const DEFAULT_STEP_RETRIES = 3;

export interface StepDefinition<A extends JsonValue[], R> {
	readonly name: string;
	readonly options: StepOptions;
	handler(...args: A): Promise<R> | R;
}

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

export function step<A extends JsonValue[], R>(
	handler: (...args: A) => Promise<R> | R,
	options: StepOptions & { name?: string } = {},
): StepDefinition<A, R> {
	const { name, ...rest } = options;
	return defineStep(name || handler.name || "step", handler, rest);
}

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
