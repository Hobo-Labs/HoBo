/**
 * Replays `contracts/vercel-blob-ephemeral-state.pact.json` from both sides.
 *
 * Consumer: the binding, driven through the port and the real pinned SDK,
 * must send exactly the pact's binding requests (method, path, query, pinned
 * headers, body) in order, and turn the pact's responses into the results the
 * scenario expects. Provider: the local emulator, given every request in
 * order (including the other writer's), must answer each with the pact's
 * status, ETag and every pinned response field. The provider is a stand-in:
 * nothing here has been replayed against Vercel.
 *
 * `UPDATE_VERCEL_BLOB_PACT=1` re-records the pact from the emulator first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startBlobEmulator } from "./fixtures/http-emulator.js";
import {
	isPactText,
	loadPact,
	matchesSubset,
	otherWriter,
	PACT_NOW,
	PACT_STEPS,
	pactPort,
	runPactScenario,
	startReplayServer,
	toInteractions,
	withInterference,
	writePact,
} from "./fixtures/pact.js";
import { sdkOverHttp, useEmulatorEnv } from "./fixtures/sdk-over-http.js";

const EXPECTED_RESULTS = [
	{ applied: true, version: "inc-1:1" },
	{ applied: false },
	{ value: '{"runner":"r-1"}', version: "inc-1:1" },
	{ applied: true, version: "inc-1:2" },
	{ applied: false },
	[
		{ value: '{"runner":"r-1","state":"dispatched"}', version: "inc-1:2" },
		null,
	],
	2,
	13,
	false,
	true,
	{ listed: 1, read: 0, deleted: 0 },
];

describe("Vercel Blob ephemeral-state HTTP pact", () => {
	beforeAll(async () => {
		if (process.env.UPDATE_VERCEL_BLOB_PACT !== "1") return;
		const emulator = await startBlobEmulator({ now: () => PACT_NOW });
		const restore = useEmulatorEnv(emulator.apiUrl);
		try {
			const http = sdkOverHttp(emulator.origin);
			const { sdk, arm } = withInterference(http, otherWriter(emulator, http));
			await runPactScenario(pactPort(sdk), sdk, arm);
			writePact(toInteractions(emulator.requests, emulator.replies));
		} finally {
			restore();
			await emulator.close();
		}
	});

	it("lists the scenario's steps, one interaction each", () => {
		expect(loadPact().map((interaction) => interaction.description)).toEqual([
			...PACT_STEPS,
		]);
		expect(
			loadPact().filter((interaction) => interaction.sentBy !== "binding"),
		).toHaveLength(1);
	});

	describe("consumer", () => {
		let restore: () => void;
		let replay: Awaited<ReturnType<typeof startReplayServer>>;
		beforeAll(async () => {
			replay = await startReplayServer(loadPact());
			restore = useEmulatorEnv(replay.apiUrl);
		});
		afterAll(async () => {
			restore();
			await replay.close();
		});

		it("sends exactly the pact's requests and reads the pact's responses", async () => {
			const { sdk, arm } = withInterference(
				sdkOverHttp(replay.origin),
				async () => {},
			);
			const observed = await runPactScenario(pactPort(sdk), sdk, arm);
			expect(replay.mismatches).toEqual([]);
			expect(replay.remaining()).toBe(0);
			expect(observed).toEqual(EXPECTED_RESULTS);
		});
	});

	describe("provider (local emulator)", () => {
		it("answers every request with the pact's status, ETag and pinned fields", async () => {
			const emulator = await startBlobEmulator({ now: () => PACT_NOW });
			try {
				for (const interaction of loadPact()) {
					const reply = await emulator.answer(interaction.request);
					expect(reply.status, interaction.description).toBe(
						interaction.response.status,
					);
					expect(reply.headers.etag, interaction.description).toBe(
						interaction.response.headers.etag,
					);
					const expected = interaction.response.body;
					if (isPactText(expected)) {
						expect(reply.body, interaction.description).toBe(expected);
					} else {
						expect(
							matchesSubset(expected, JSON.parse(reply.body)),
							interaction.description,
						).toBe(true);
					}
				}
			} finally {
				await emulator.close();
			}
		});
	});
});
