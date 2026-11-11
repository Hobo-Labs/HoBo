/**
 * Replays `contracts/pacts/ephemeral-state-executor.pact.json` from both sides.
 *
 * Consumer: the ephemeral-state binding, driven through its port, must send
 * exactly the commands the pact lists. Provider: the in-memory engine,
 * starting with an empty script cache, must answer each of them as the pact
 * says. `ephemeral-resp.test.ts` replays the provider side against a real
 * Valkey/Redis when one is available. The REST envelope around these
 * commands is the existing `kv-redis-executor.pact.json` shape, which
 * `@hobo/provider-upstash`'s executor carries for every command alike.
 */
import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	type KvRedisExecutor,
	type RedisCommand,
} from "../src/index.js";
import {
	loadEphemeralPact,
	verifyEphemeralPactProvider,
} from "./fixtures/ephemeral-pact.js";

describe("ephemeral-state executor pact", () => {
	it("consumer: the binding sends exactly the pact's commands, in order", async () => {
		const interactions = loadEphemeralPact();
		const sent: RedisCommand[] = [];
		let next = 0;
		const replay: KvRedisExecutor = {
			async execute(command) {
				sent.push(command);
				const interaction = interactions[next];
				next += 1;
				if (interaction === undefined)
					throw new Error("binding sent more commands than the pact lists");
				return interaction.response.body;
			},
		};
		const incarnations = ["inc-1", "inc-2"];
		const state = createRedisEphemeralState({
			executor: replay,
			newIncarnation: () => incarnations.shift() ?? "unexpected",
		});
		const lease = parseEphemeralKey("pact:lease:42");
		const ttl = parseEphemeralTtlMs(60_000);

		expect(await state.putIfAbsent(lease, '{"runner":"r-1"}', ttl)).toEqual({
			applied: true,
			version: "inc-1:1",
		});
		expect(await state.putIfAbsent(lease, '{"runner":"r-2"}', ttl)).toEqual({
			applied: false,
		});
		expect(await state.get(lease)).toEqual({
			value: '{"runner":"r-1"}',
			version: "inc-1:1",
		});
		expect(await state.get(parseEphemeralKey("pact:absent"))).toBeUndefined();
		expect(
			await state.expire(
				parseEphemeralKey("pact:absent"),
				parseEphemeralTtlMs(1_000),
			),
		).toBe(false);

		expect(sent).toEqual(
			interactions.map((interaction) => interaction.request.body),
		);
	});

	it("provider: the in-memory engine answers every interaction as the pact states", async () => {
		const results = await verifyEphemeralPactProvider(
			createMemoryRedisExecutor({ now: () => 0 }),
		);
		for (const result of results) {
			expect(result.actual, result.description).toEqual(result.expected);
		}
	});
});
