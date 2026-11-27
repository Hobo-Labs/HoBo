import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	GhAccountId,
	GhActorId,
	GhRelayRouteFacts,
	GhRepoSlug,
} from "../src/domain/index.js";
import {
	createGhRelayRouteFactsFromStore,
	GhRelayRouteFactsFailClosed,
} from "../src/host/route-facts.js";
import type { StoreRouteFactsDeps } from "../src/relay-answer/store-facts.js";

const loadArgs = {
	accountId: GhAccountId.make("acct-1"),
	repository: GhRepoSlug.make("octo/app"),
	actorId: GhActorId.make("42"),
};

const storeDeps = {
	accountId: "acct-1",
	fleet: undefined,
	machines: undefined,
	readers: async () => new Set(["42"]),
	spend: undefined,
	health: undefined,
	minutes: undefined,
	onWarning: undefined,
} satisfies StoreRouteFactsDeps;

describe("@hobo/ci-gh-actions host route facts store", () => {
	it("fail-closed adapter returns empty facts", async () => {
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const run = yield* GhRelayRouteFacts;
				return yield* run.loadFacts(loadArgs);
			}).pipe(Effect.provide(GhRelayRouteFactsFailClosed)),
		);
		expect(loaded).toEqual({ fleet: null, ownerCanRead: false });
	});

	it("store adapter maps fleet and ownerCanRead from readers", async () => {
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const run = yield* GhRelayRouteFacts;
				return yield* run.loadFacts(loadArgs);
			}).pipe(Effect.provide(createGhRelayRouteFactsFromStore(storeDeps))),
		);
		expect(loaded.ownerCanRead).toBe(true);
		expect(loaded.fleet).toBeNull();
	});
});
