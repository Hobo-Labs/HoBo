import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { GhRelayRouteFacts } from "../domain/index.js";

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
