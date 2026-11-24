import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class LocalRunnerError extends Data.TaggedError("LocalRunnerError")<{
	readonly code: "LOCAL_MACHINE_INVALID" | "LOCAL_RUNNER_FAILED";
	readonly message: string;
}> {}

export interface LocalRunnerRegistry {
	readonly registerSlot: (input: {
		readonly machineId: string;
		readonly labels: readonly string[];
		readonly maxConcurrency: number;
	}) => Promise<{ readonly runnerId: string; readonly status: "online" }>;
	readonly releaseSlot: (runnerId: string) => Promise<void>;
}

export interface LocalRunnerProps {
	readonly machineId: string;
	readonly labels: readonly string[];
	readonly maxConcurrency: number;
}

export interface LocalRunnerAttr {
	readonly runnerId: string;
	readonly tier: "local";
	readonly machineId: string;
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
	return {
		async registerSlot(input) {
			const runnerId = `local:${input.machineId}`;
			active.set(runnerId, input.machineId);
			return { runnerId, status: "online" as const };
		},
		async releaseSlot(runnerId) {
			active.delete(runnerId);
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
				if (news.machineId.trim().length === 0 || news.maxConcurrency < 1) {
					return yield* new LocalRunnerError({
						code: "LOCAL_MACHINE_INVALID",
						message:
							"local runner requires machineId and maxConcurrency >= 1",
					});
				}
				const registered = yield* Effect.tryPromise({
					try: () =>
						registry.registerSlot({
							machineId: news.machineId,
							labels: news.labels,
							maxConcurrency: news.maxConcurrency,
						}),
					catch: (cause) =>
						new LocalRunnerError({
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
