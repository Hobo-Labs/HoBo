/**
 * Replays `contracts/ephemeral-assignment-replica.pact.json` from both sides.
 *
 * Consumer: the replica, driven through its scenario against a port that
 * answers from the pact, must send exactly the pact's calls and reach the
 * expected outcomes. Provider: the in-memory ephemeral-state binding (the
 * shared Redis-protocol binding over the in-memory engine, with a fixed
 * incarnation and clock) must answer every call with the pact's response.
 */
import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import { createMemoryEphemeralState } from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";
import {
	execute,
	loadReplicaPact,
	pactReplica,
	replayPort,
	runReplicaScenario,
} from "./replica-pact.js";

const EXPECTED = [
	[],
	"accepted",
	"accepted",
	"duplicate",
	"gap",
	[2],
	true,
	"not-empty",
];

describe("ephemeral assignment replica pact", () => {
	it("consumer: the replica sends exactly the pact's calls, in order", async () => {
		const interactions = loadReplicaPact();
		const { port, sent } = replayPort(interactions);
		expect(await runReplicaScenario(pactReplica, port)).toEqual(EXPECTED);
		expect(sent).toEqual(
			interactions.map((interaction) => interaction.request),
		);
	});

	it("provider: an ephemeral-state binding answers every call as pinned", async () => {
		const port = createMemoryEphemeralState({
			now: () => 1_800_000_000_000,
			newIncarnation: () => "inc-1",
		});
		for (const interaction of loadReplicaPact())
			expect(
				await execute(port, interaction.request, {
					key: parseEphemeralKey,
					ttl: parseEphemeralTtlMs,
				}),
			).toEqual(interaction.response);
	});
});
