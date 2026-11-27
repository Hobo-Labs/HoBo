import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class LocalRunnerError extends Data.TaggedError("LocalRunnerError")<{
	readonly code:
		| "LOCAL_MACHINE_INVALID"
		| "LOCAL_RUNNER_FAILED"
		| "LOCAL_CONCURRENCY_EXCEEDED";
	readonly message: string;
}> {}

export interface LocalRunnerRegistry {
	readonly registerSlot: (input: {
		readonly machineId: string;
		readonly jobId: string;
		readonly labels: readonly string[];
		readonly maxConcurrency: number;
	}) => Promise<{ readonly runnerId: string; readonly status: "online" }>;
	readonly releaseSlot: (runnerId: string) => Promise<void>;
}

export interface LocalRunnerProps {
	readonly machineId: string;
	readonly jobId: string;
	readonly labels: readonly string[];
	readonly maxConcurrency: number;
}

export interface LocalRunnerAttr {
	readonly runnerId: string;
	readonly tier: "local";
	readonly machineId: string;
	readonly jobId: string;
	readonly labels: readonly string[];
	readonly maxConcurrency: number;
	readonly status: "online";
}

export type LocalRunner = Resource<
	"Hobo.LocalRunner",
	LocalRunnerProps,
	LocalRunnerAttr
>;

export const LocalRunner = Resource<LocalRunner>("Hobo.LocalRunner");

export function createInMemoryLocalRunnerRegistry(): LocalRunnerRegistry & {
	readonly activeRunnerIds: () => readonly string[];
} {
	const active = new Map<string, string>();
	const slotsByMachine = new Map<string, Set<string>>();
	return {
		async registerSlot(input) {
			const slots = slotsByMachine.get(input.machineId) ?? new Set<string>();
			if (slots.size >= input.maxConcurrency) {
				throw new LocalRunnerError({
					code: "LOCAL_CONCURRENCY_EXCEEDED",
					message: `local runner pool ${input.machineId} exceeded maxConcurrency ${input.maxConcurrency}`,
				});
			}
			const runnerId = `local:${input.jobId}`;
			active.set(runnerId, input.machineId);
			slots.add(runnerId);
			slotsByMachine.set(input.machineId, slots);
			return { runnerId, status: "online" as const };
		},
		async releaseSlot(runnerId) {
			const machineId = active.get(runnerId);
			active.delete(runnerId);
			if (machineId !== undefined) {
				const slots = slotsByMachine.get(machineId);
				slots?.delete(runnerId);
				if (slots !== undefined && slots.size === 0) {
					slotsByMachine.delete(machineId);
				}
			}
		},
		activeRunnerIds() {
			return [...active.keys()].sort();
		},
	};
}

export function LocalRunnerProvider(registry: LocalRunnerRegistry) {
	return Provider.succeed(LocalRunner, {
		reconcile: ({ news }) =>
			Effect.gen(function* () {
				if (
					news.machineId.trim().length === 0 ||
					news.jobId.trim().length === 0 ||
					news.maxConcurrency < 1
				) {
					return yield* new LocalRunnerError({
						code: "LOCAL_MACHINE_INVALID",
						message:
							"local runner requires machineId, jobId, and maxConcurrency >= 1",
					});
				}
				const registered = yield* Effect.tryPromise({
					try: () =>
						registry.registerSlot({
							machineId: news.machineId,
							jobId: news.jobId,
							labels: news.labels,
							maxConcurrency: news.maxConcurrency,
						}),
					catch: (cause) =>
						cause instanceof LocalRunnerError
							? cause
							: new LocalRunnerError({
									code: "LOCAL_RUNNER_FAILED",
									message:
										cause instanceof Error
											? cause.message
											: "local runner registration failed",
								}),
				});
				return {
					runnerId: registered.runnerId,
					tier: "local" as const,
					machineId: news.machineId,
					jobId: news.jobId,
					labels: [...news.labels],
					maxConcurrency: news.maxConcurrency,
					status: registered.status,
				};
			}),
		delete: ({ output }) =>
			output === undefined
				? Effect.void
				: Effect.tryPromise({
						try: () => registry.releaseSlot(output.runnerId),
						catch: (cause) =>
							new LocalRunnerError({
								code: "LOCAL_RUNNER_FAILED",
								message:
									cause instanceof Error
										? cause.message
										: "local runner release failed",
							}),
					}),
	});
}
