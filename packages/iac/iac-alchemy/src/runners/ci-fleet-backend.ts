import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
	Agent37Runner,
	type Agent37RunnerInstanceType,
	Agent37RunnerProvider,
	type Agent37RunnerProviderOptions,
	type Agent37RunnerRegion,
} from "./agent37.js";
import {
	createInMemoryHostingerRunnerRegistry,
	HostingerRunner,
	HostingerRunnerProvider,
	type HostingerRunnerProviderOptions,
	type HostingerRunnerRegistry,
} from "./hostinger.js";
import {
	LocalRunner,
	LocalRunnerProvider,
	type LocalRunnerRegistry,
} from "./local.js";

export type AlchemyRunnerTier = "local" | "hostinger" | "agent37" | "github";

export interface RunnerProvisionInput {
	readonly jobId: string;
	readonly poolId: string;
	readonly tier: AlchemyRunnerTier;
	readonly label: string;
}

export interface RunnerReleaseInput {
	readonly runnerId: string;
	readonly tier: AlchemyRunnerTier;
}

export interface AlchemyRunnerBackendAdapter {
	readonly provisionRunner: (
		input: RunnerProvisionInput,
	) => Promise<{ readonly runnerId: string }>;
	readonly releaseRunner: (input: RunnerReleaseInput) => Promise<void>;
}

export interface AlchemyRunnerBackendOptions {
	readonly local?: {
		readonly registry: LocalRunnerRegistry;
		readonly maxConcurrency: number;
	};
	readonly hostinger?: Omit<HostingerRunnerProviderOptions, "registry"> & {
		readonly registry?: HostingerRunnerRegistry;
		readonly maxConcurrency: number;
		readonly credentialLocator: string;
		readonly apiOrigin?: string;
	};
	readonly agent37?: Agent37RunnerProviderOptions & {
		readonly template: string;
		readonly instanceType: Agent37RunnerInstanceType;
		readonly region: Agent37RunnerRegion;
		readonly cpu: number;
		readonly memoryGb: number;
		readonly credentialLocator: string;
	};
	readonly github?: {
		readonly dispatchHostedRunner: (
			input: RunnerProvisionInput,
		) => Promise<{ readonly runnerId: string }>;
	};
}

function runRunnerStack<Output, Req, LayerError>(
	stack: Alchemist.ConfiguredStack<Output, Req>,
	runtimeLayer: Layer.Layer<Alchemist.Services | Req, LayerError, never>,
	operation: "deploy" | "destroy",
) {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const plan = yield* Alchemist.plan({
					stack,
					stage: "ci",
					operation,
				});
				return yield* Alchemist.apply(plan);
			}),
		).pipe(Effect.provide(runtimeLayer)),
	);
}

export function createAlchemyRunnerBackend(
	options: AlchemyRunnerBackendOptions,
): AlchemyRunnerBackendAdapter {
	const stackStates = new Map<
		string,
		{
			readonly tier: AlchemyRunnerTier;
			readonly runnerId: string;
			readonly destroy: () => Promise<void>;
		}
	>();
	const runnerIdToJobId = new Map<string, string>();
	const hostingerRegistry =
		options.hostinger?.registry ?? createInMemoryHostingerRunnerRegistry();

	return {
		async provisionRunner(input) {
			if (input.tier === "github") {
				if (options.github === undefined) {
					throw new Error("github runner provider not configured");
				}
				return options.github.dispatchHostedRunner(input);
			}
			const state = inMemoryState();
			if (input.tier === "local") {
				if (options.local === undefined) {
					throw new Error("local runner provider not configured");
				}
				const local = options.local;
				const providers = LocalRunnerProvider(local.registry);
				const stack = Stack(
					`runner-local-${input.jobId}`,
					{ providers, state },
					Effect.gen(function* () {
						const resource = yield* LocalRunner(input.jobId, {
							machineId: input.poolId,
							jobId: input.jobId,
							labels: [input.label],
							maxConcurrency: local.maxConcurrency,
						});
						return { runnerId: resource.runnerId };
					}),
				);
				const runtimeLayer = Layer.merge(Alchemist.layer(), providers);
				const deployed = await runRunnerStack(stack, runtimeLayer, "deploy");
				const runnerId = deployed.runnerId;
				stackStates.set(input.jobId, {
					tier: "local",
					runnerId,
					destroy: async () => {
						await runRunnerStack(stack, runtimeLayer, "destroy");
					},
				});
				runnerIdToJobId.set(runnerId, input.jobId);
				return { runnerId };
			}
			if (input.tier === "hostinger") {
				if (options.hostinger === undefined) {
					throw new Error("hostinger runner provider not configured");
				}
				const hostinger = options.hostinger;
				const providers = HostingerRunnerProvider({
					...hostinger,
					registry: hostingerRegistry,
				});
				const machineId = input.poolId;
				const stack = Stack(
					`runner-hostinger-${input.jobId}`,
					{ providers, state },
					Effect.gen(function* () {
						const resource = yield* HostingerRunner(input.jobId, {
							jobId: input.jobId,
							machineId,
							hostname: `${input.poolId}.hostinger`,
							labels: [input.label],
							maxConcurrency: hostinger.maxConcurrency,
							credentialLocator: hostinger.credentialLocator,
							...(hostinger.apiOrigin !== undefined
								? { apiOrigin: hostinger.apiOrigin }
								: undefined),
						});
						return { runnerId: resource.runnerId };
					}),
				);
				const runtimeLayer = Layer.merge(Alchemist.layer(), providers);
				const deployed = await runRunnerStack(stack, runtimeLayer, "deploy");
				const runnerId = deployed.runnerId;
				stackStates.set(input.jobId, {
					tier: "hostinger",
					runnerId,
					destroy: async () => {
						await runRunnerStack(stack, runtimeLayer, "destroy");
					},
				});
				runnerIdToJobId.set(runnerId, input.jobId);
				return { runnerId };
			}
			if (options.agent37 === undefined) {
				throw new Error("agent37 runner provider not configured");
			}
			const agent37 = options.agent37;
			const providers = Agent37RunnerProvider(agent37);
			const stack = Stack(
				`runner-agent37-${input.jobId}`,
				{ providers, state },
				Effect.gen(function* () {
					const resource = yield* Agent37Runner(input.jobId, {
						name: `${input.poolId}-${input.jobId}`,
						template: agent37.template,
						instanceType: agent37.instanceType,
						region: agent37.region,
						cpu: agent37.cpu,
						memoryGb: agent37.memoryGb,
						labels: [input.label],
						credentialLocator: agent37.credentialLocator,
					});
					return { runnerId: resource.runnerId };
				}),
			);
			const runtimeLayer = Layer.merge(Alchemist.layer(), providers);
			const deployed = await runRunnerStack(stack, runtimeLayer, "deploy");
			const runnerId = deployed.runnerId;
			stackStates.set(input.jobId, {
				tier: "agent37",
				runnerId,
				destroy: async () => {
					await runRunnerStack(stack, runtimeLayer, "destroy");
				},
			});
			runnerIdToJobId.set(runnerId, input.jobId);
			return { runnerId };
		},
		async releaseRunner(input) {
			const jobId = runnerIdToJobId.get(input.runnerId);
			if (jobId === undefined) return;
			const tracked = stackStates.get(jobId);
			if (tracked === undefined) return;
			await tracked.destroy();
			stackStates.delete(jobId);
			runnerIdToJobId.delete(input.runnerId);
		},
	};
}
