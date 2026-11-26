import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { REPLAY_BOUNDARIES } from "../src/http-surface.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pactsDir = join(root, "contracts/pacts");

describe("PACT catalog completeness", () => {
	it("ships one pact file per primary boundary family", () => {
		const files = readdirSync(pactsDir).filter((f) => f.endsWith(".pact.json"));
		expect(files.sort()).toEqual(
			[
				"replay-access.pact.json",
				"replay-bindle-host.pact.json",
				"replay-blob-store.pact.json",
				"replay-cli-service.pact.json",
				"replay-correlation.pact.json",
				"replay-events.pact.json",
				"replay-evidence.pact.json",
				"replay-metering.pact.json",
				"replay-player-store.pact.json",
				"replay-policy.pact.json",
				"replay-privacy.pact.json",
				"replay-retention.pact.json",
				"replay-tracker-ingest.pact.json",
			].sort(),
		);
	});

	it("every pact uses PascalCase participants and non-empty interactions", () => {
		const files = readdirSync(pactsDir).filter((f) => f.endsWith(".pact.json"));
		const nameRe = /^[A-Z][A-Za-z0-9]*$/;
		for (const file of files) {
			const pact = JSON.parse(readFileSync(join(pactsDir, file), "utf8"));
			expect(nameRe.test(pact.consumer.name), file).toBe(true);
			expect(nameRe.test(pact.provider.name), file).toBe(true);
			expect(pact.interactions.length).toBeGreaterThan(0);
			expect(pact.metadata.pactSpecification.version).toBe("3.0.0");
		}
	});

	it("boundary catalog matches inventory file references", () => {
		const inventory = readFileSync(
			join(root, "contracts/pact-inventory.md"),
			"utf8",
		);
		expect(REPLAY_BOUNDARIES.length).toBeGreaterThanOrEqual(14);
		for (const b of REPLAY_BOUNDARIES) {
			expect(inventory).toContain(b.consumer);
			expect(inventory).toContain(b.provider);
		}
	});
});
