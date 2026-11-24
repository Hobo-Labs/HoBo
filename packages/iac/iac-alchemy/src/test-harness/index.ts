import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import type * as Provider from "alchemy/Provider";
import type * as AlchemySecrets from "alchemy/Secrets";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { validateAlchemyStage } from "../environments/index.js";

export interface AlchemyTestHarnessOptions<
	Providers extends Provider.Provider,
> {
	readonly providers: Layer.Layer<Providers, never, never>;
	readonly state?: ReturnType<typeof inMemoryState>;
	readonly stage?: string;
	readonly secrets?: readonly AlchemySecrets.SecretsEntry[];
}

export function createAlchemyTestHarness<Providers extends Provider.Provider>(
	options: AlchemyTestHarnessOptions<Providers>,
) {
	const defaultStage = validateAlchemyStage(options.stage ?? "test-local");
	const runtimeLayer = Layer.merge(Alchemist.layer(), options.providers);
	const sharedState = options.state ?? inMemoryState();

	function executeStack<Output, Req>(
		stack: Alchemist.ConfiguredStack<Output, Req>,
		stage: string,
		operation: "deploy" | "destroy",
	) {
		const validStage = validateAlchemyStage(stage);
		return Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const plan = yield* Alchemist.plan({
						stack,
						stage: validStage,
						operation,
					});
					return yield* Alchemist.apply(plan);
				}),
			).pipe(Effect.provide(runtimeLayer)),
		);
	}

	function createProviderSession() {
		const scratchState = inMemoryState();
		return {
			stage: defaultStage,
			async deploy<Output>(
				name: string,
				program: Effect.Effect<Output, Config.ConfigError, Providers>,
				callOptions?: {
					readonly stage?: string;
					readonly secrets?: readonly AlchemySecrets.SecretsEntry[];
				},
			) {
				const stage = callOptions?.stage ?? defaultStage;
				const secrets = callOptions?.secrets ?? options.secrets;
				const stack = Stack(
					name,
					{
						providers: options.providers,
						state: scratchState,
						...(secrets !== undefined ? { secrets: [...secrets] } : undefined),
					},
					program,
				);
				const outputs = await executeStack(stack, stage, "deploy");
				return {
					outputs,
					destroy: async () => {
						await executeStack(stack, stage, "destroy");
					},
				};
			},
		};
	}

	return {
		stage: defaultStage,
		state: sharedState,
		deploy<Output>(
			stack: Alchemist.ConfiguredStack<Output, Providers>,
			callOptions?: { readonly stage?: string },
		) {
			return executeStack(stack, callOptions?.stage ?? defaultStage, "deploy");
		},
		destroy<Output>(
			stack: Alchemist.ConfiguredStack<Output, Providers>,
			callOptions?: { readonly stage?: string },
		) {
			return executeStack(stack, callOptions?.stage ?? defaultStage, "destroy");
		},
		async withProviderSession(
			run: (session: ReturnType<typeof createProviderSession>) => Promise<void>,
		): Promise<void> {
			await run(createProviderSession());
		},
	};
}
