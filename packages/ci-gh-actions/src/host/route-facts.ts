import { create } from "@bufbuild/protobuf";
import { RunnerRouteRequestSchema } from "@hobo/ci";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { GhRelayRouteFacts } from "../domain/index.js";
import {
	StoreRouteFacts,
	type StoreRouteFactsDeps,
} from "../relay-answer/store-facts.js";

export type GhRelayRouteFactsService = Layer.Success<
	ReturnType<typeof GhRelayRouteFacts.toLayer>
>;

export const GhRelayRouteFactsFailClosed = GhRelayRouteFacts.toLayer(
	Effect.succeed({
		loadFacts: () =>
			Effect.succeed({
				fleet: null,
				ownerCanRead: false,
			}),
	}),
);

export const createGhRelayRouteFactsFromStore = (
	deps: StoreRouteFactsDeps,
): Layer.Layer<GhRelayRouteFactsService> =>
	GhRelayRouteFacts.toLayer(
		Effect.succeed({
			loadFacts: (args) => {
				const store = new StoreRouteFacts(deps);
				return Effect.gen(function* () {
					const nowMs = Date.now();
					const routeRequest = create(RunnerRouteRequestSchema, {
						repository: args.repository,
						private: true,
						event: "workflow_dispatch",
						fork: false,
						runId: 1n,
						runAttempt: 1,
						job: "relay",
						inputs: [{ key: "github", labels: ["hobo"] }],
					});
					const loaded = yield* Effect.promise(() =>
						store.facts(routeRequest, nowMs),
					);
					const readers = deps.readers;
					const readersSayOwner =
						readers === undefined
							? false
							: yield* Effect.promise(() =>
									readers(args.repository).then((set) =>
										set.has(String(args.actorId)),
									),
								);
					const ownerCanRead =
						readersSayOwner ||
						loaded.machines.some(
							(machine) =>
								machine.ownerId === args.actorId && machine.ownerCanRead,
						);
					return {
						fleet: loaded.fleet ?? null,
						ownerCanRead,
					};
				});
			},
		}),
	);
