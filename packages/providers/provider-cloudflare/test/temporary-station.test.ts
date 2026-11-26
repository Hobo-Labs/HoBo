import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	assertStationWorkerHasNoAppCode,
	ENVIRONMENT_STATION_WORKER_MODULE,
} from "../src/station-worker-source.js";
import {
	solvePreviewChallenge,
	verifyPreviewChallengeSolution,
} from "../src/temporary-pow.js";
import {
	provisionTemporaryEnvironmentStation,
	type TemporaryAccountTransport,
} from "../src/temporary-station.js";
import { parseWranglerTemporaryOutput } from "../src/wrangler-temporary.js";

function sha256(input: Buffer): Buffer {
	return createHash("sha256").update(input).digest();
}

describe("temporary PoW", () => {
	it("builds contiguous SHA-256 checkpoint ladder", async () => {
		const seed = Buffer.alloc(32, 7);
		const challenge = {
			challengeToken: "tok",
			seed: seed.toString("base64url"),
			k: 4,
			g: 5,
		};
		const { solution } = await solvePreviewChallenge(challenge);
		expect(
			await verifyPreviewChallengeSolution(challenge, solution.checkpoints),
		).toBe(true);
		const flat = Buffer.from(solution.checkpoints, "base64");
		expect(flat.length).toBe(5 * 32);
		expect(flat.subarray(0, 32).equals(sha256(seed))).toBe(true);
	});

	it("rejects oversized work", async () => {
		await expect(
			solvePreviewChallenge({
				challengeToken: "t",
				seed: Buffer.alloc(32).toString("base64url"),
				k: 8_000_001,
				g: 8,
			}),
		).rejects.toThrow(/64,000,000/);
	});
});

describe("station worker source", () => {
	it("ships Environment Station without Bindle/app code", () => {
		expect(() =>
			assertStationWorkerHasNoAppCode(ENVIRONMENT_STATION_WORKER_MODULE),
		).not.toThrow();
		expect(ENVIRONMENT_STATION_WORKER_MODULE).toContain("data-hobo-station");
		expect(() =>
			assertStationWorkerHasNoAppCode("const waspApp = true"),
		).toThrow(/app\/Bindle/);
	});
});

describe("provisionTemporaryEnvironmentStation", () => {
	it("provisions via mocked CF transport", async () => {
		const transport: TemporaryAccountTransport = {
			async requestChallenge() {
				return {
					challengeToken: "challenge-token",
					seed: Buffer.alloc(32, 1).toString("base64url"),
					k: 2,
					g: 2,
				};
			},
			async createPreviewAccount() {
				return {
					accountId: "acct_temp",
					apiToken: "tok_temp",
					claimUrl: "https://dash.cloudflare.com/claim/temp",
					workersDevSubdomain: "preview",
				};
			},
			async deployWorkerScript({ scriptName }) {
				return {
					workersDevUrl: `https://${scriptName}.preview.workers.dev`,
				};
			},
		};

		const result = await provisionTemporaryEnvironmentStation({
			stationId: "station:home:cloudflare",
			transport,
		});

		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.claimUrl).toContain("claim");
		expect(result.stationUrl).toMatch(/\.workers\.dev$/);
		expect(result.stationUrl).not.toMatch(/^blob:/);
		expect(result.scriptName).toMatch(/^hobo-env-station-/);
	});

	it("rejects Bindle/app bytes in station Worker", async () => {
		await expect(
			provisionTemporaryEnvironmentStation({
				stationId: "bad",
				workerModule: "export default { waspApp: true, fetch() {} };",
				transport: {
					requestChallenge: async () => {
						throw new Error("unreachable");
					},
					createPreviewAccount: async () => {
						throw new Error("unreachable");
					},
					deployWorkerScript: async () => {
						throw new Error("unreachable");
					},
				},
			}),
		).rejects.toThrow(/app\/Bindle/);
	});
});

describe("parseWranglerTemporaryOutput", () => {
	it("extracts workers.dev and claim URLs", () => {
		const parsed = parseWranglerTemporaryOutput(
			[
				"Deployed hobo-env-station-demo",
				"https://hobo-env-station-demo.preview.workers.dev",
				"Claim this deployment: https://dash.cloudflare.com/?to=/:account/workers/claim&token=abc",
			].join("\n"),
			"",
		);
		expect(parsed.stationUrl).toBe(
			"https://hobo-env-station-demo.preview.workers.dev",
		);
		expect(parsed.claimUrl).toContain("claim");
	});
});
