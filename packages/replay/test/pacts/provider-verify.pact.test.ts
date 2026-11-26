/**
 * Provider verification: every PACT under contracts/pacts/ is verified against
 * the live ReplayHttpSurface (real package code + dual fixtures).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type ProviderStub,
	parsePactDocument,
	verifyPact,
} from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";

import {
	createReplayHttpSurface,
	type ReplayHttpRequest,
	seedReplayFixture,
} from "../../src/http-surface.js";

const pactsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../contracts/pacts",
);

const pactFiles = readdirSync(pactsDir)
	.filter((f) => f.endsWith(".pact.json"))
	.sort();

describe("Session Replay PACT provider verification (all boundaries)", () => {
	it("inventory lists every pact file", () => {
		const inventory = readFileSync(
			join(pactsDir, "../pact-inventory.md"),
			"utf8",
		);
		for (const file of pactFiles) {
			expect(inventory).toContain(`pacts/${file}`);
		}
		expect(pactFiles.length).toBeGreaterThanOrEqual(12);
	});

	for (const file of pactFiles) {
		it(`verifies ${file}`, async () => {
			const raw = JSON.parse(readFileSync(join(pactsDir, file), "utf8"));
			const pact = parsePactDocument(raw, file);

			const surface = createReplayHttpSurface({
				stationId: "station:local",
				name: pact.provider.name,
			});
			// Seed sessions used by player/cli contracts.
			await seedReplayFixture(surface.store, {
				sessionId: "sess-local-1",
				stationId: "station:local",
				errorId: "err-42",
			});

			const provider: ProviderStub = {
				name: pact.provider.name,
				handle: async (request) => {
					const res = await surface.handle(request as ReplayHttpRequest);
					return {
						status: res.status,
						...(res.headers !== undefined ? { headers: res.headers } : {}),
						...(res.body !== undefined ? { body: res.body } : {}),
					};
				},
			};

			const report = await verifyPact(pact, provider);
			expect(
				report.ok,
				report.failures.map((f) => `${f.description}: ${f.reason}`).join("\n"),
			).toBe(true);
		});
	}
});
