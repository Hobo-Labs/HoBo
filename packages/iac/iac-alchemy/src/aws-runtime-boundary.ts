import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import {
	type BoundaryBox,
	createBoundaryDeferred,
	raceBoundary,
} from "./async-boundary.js";

export const AWS_RUNTIME_MAX_IN_FLIGHT = 32;
export const AWS_RUNTIME_DEADLINE_MS = 10_000;
const schedule = setTimeout;
const cancel = clearTimeout;
const freeze = Object.freeze;
const runCallback = Effect.runCallback;
const isSuccess = Exit.isSuccess;

/** One host-authorized bounded transport per store. A timeout does not release its slot. */
export function createAwsRuntimeBoundary<Operation extends string>(options: {
	readonly layer: Layer.Layer<Credentials | HttpClient.HttpClient>;
	readonly authorize: (operation: Operation, key: string) => boolean;
	readonly denied: () => Error;
	readonly capacity: () => Error;
	readonly unavailable: (operation: Operation) => Error;
}) {
	let inFlight = 0;
	const beforeReturn = (operation: Operation, key: string) => {
		if (!options.authorize(operation, key))
			throw options.unavailable(operation);
	};
	const run = async <T>(
		operation: Operation,
		key: string,
		effect: Effect.Effect<T, unknown, Credentials | HttpClient.HttpClient>,
	): Promise<BoundaryBox<T>> => {
		if (!options.authorize(operation, key)) throw options.denied();
		if (inFlight >= AWS_RUNTIME_MAX_IN_FLIGHT) throw options.capacity();
		inFlight++;
		const completion = createBoundaryDeferred<T>();
		const deadline = createBoundaryDeferred<T>();
		try {
			runCallback(effect.pipe(Effect.provide(options.layer)), {
				onExit(exit) {
					inFlight--;
					if (isSuccess(exit)) completion.resolve(exit.value);
					else completion.reject(undefined);
				},
			});
		} catch {
			// The effect may have started before observer registration failed.
			// Retain its slot because its completion cannot be established.
			throw options.unavailable(operation);
		}
		// A deadline is not evidence that the provider stopped the request.
		const timer = schedule(
			() => deadline.reject(undefined),
			AWS_RUNTIME_DEADLINE_MS,
		);
		try {
			const result = await raceBoundary(completion.promise, deadline.promise);
			beforeReturn(operation, key);
			return result;
		} catch {
			throw options.unavailable(operation);
		} finally {
			cancel(timer);
		}
	};
	return freeze({ run, beforeReturn });
}
