import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactInteraction,
} from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";

import { isJsonNumber, isJsonString, parseJsonValue } from "../../src/json.js";
import { exitCodeOf, outcomeError, parseOutcome } from "../../src/outcome.js";
import { linesFor } from "../../test/fixtures/opensesame-lines.js";
import { fieldOf, jsonBody } from "../../test/support/pact-json.js";
import {
	PROVIDER_NAME,
	SCENARIOS,
	statusFor,
} from "../../test/support/proxied-run-provider.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

async function load(): Promise<PactDocument> {
	const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
	const pact = pacts.find(
		(candidate) => candidate.provider.name === PROVIDER_NAME,
	);
	if (pact === undefined) throw new Error("the proxied-run pact is missing");
	return pact;
}

function scenarioOf(interaction: PactInteraction): string {
	const scenario = fieldOf(jsonBody(interaction.request), "scenario");
	if (!isJsonString(scenario)) {
		throw new Error("an interaction names no scenario");
	}
	return scenario;
}

function exitCodeIn(interaction: PactInteraction): number {
	const exitCode = fieldOf(jsonBody(interaction.response), "exitCode");
	if (!isJsonNumber(exitCode)) {
		throw new Error("an interaction records no exit code");
	}
	return exitCode;
}

/** How the adapter reads the run a recorded interaction describes. */
function read(interaction: PactInteraction) {
	return parseOutcome(
		exitCodeIn(interaction),
		null,
		linesFor(scenarioOf(interaction)),
	);
}

describe("the proxied-run boundary (consumer contract)", () => {
	it("names the adapter as consumer and OpenSesame's proxied run as provider", async () => {
		const pact = await load();
		expect(pact.consumer.name).toBe("HoboOpenSesameAdapter");
		expect(pact.provider.name).toBe("OpenSesameProxiedRun");
	});

	it("covers every scenario the provider can be asked to play, once each", async () => {
		const pact = await load();
		expect(pact.interactions.map(scenarioOf).sort()).toEqual(
			[...SCENARIOS].sort(),
		);
	});

	it("every recorded response says no token leaked, and no request carries one", async () => {
		const pact = await load();
		for (const interaction of pact.interactions) {
			expect(
				fieldOf(jsonBody(interaction.response), "tokenLeaked"),
				interaction.description,
			).toBe(false);
			expect(JSON.stringify(interaction.request)).not.toMatch(
				/osr_|ostest_|vtok_|Bearer /u,
			);
		}
	});

	it("says what tokenLeaked proves: true by construction against the stand-in, evidence only in the real lane", () => {
		const raw = parseJsonValue(
			readFileSync(
				path.join(
					contractsDir,
					"pacts/opensesame-proxied-run-boundary.pact.json",
				),
				"utf8",
			),
		);
		const metadata = fieldOf(raw, "metadata");
		const note = fieldOf(metadata ?? null, "tokenLeaked");
		if (!isJsonString(note))
			throw new Error("the pact carries no tokenLeaked note");
		expect(note).toMatch(/by construction/u);
		expect(note).toMatch(/stand-in/u);
		expect(note).toMatch(/real lane/u);
	});

	it("the adapter concludes from OpenSesame's real lines what the pact says the run was", async () => {
		const pact = await load();
		const mock = createMockProviderFromPact(pact);
		for (const interaction of pact.interactions) {
			const scenario = scenarioOf(interaction);
			const response = await mock.handle(interaction.request);
			const outcome = read(interaction);
			expect(outcome.kind, scenario).toBe(fieldOf(jsonBody(response), "kind"));
			expect(outcome.exitCode, scenario).toBe(exitCodeIn(interaction));
			expect(response.status, scenario).toBe(statusFor(outcome.kind));
		}
	});

	it("counts a run as clean only when a surrogate was delivered and the child exited 0", async () => {
		const pact = await load();
		for (const interaction of pact.interactions) {
			const outcome = read(interaction);
			const holds = fieldOf(
				fieldOf(jsonBody(interaction.response), "childHolds") ?? null,
				"VERCEL_TOKEN",
			);
			const clean =
				outcomeError(outcome) === undefined && exitCodeOf(outcome) === 0;
			expect(clean, scenarioOf(interaction)).toBe(holds === "surrogate");
		}
	});

	it("answers a request the pact does not record with 404, so a drifted consumer fails", async () => {
		const mock = createMockProviderFromPact(await load());
		const response = await mock.handle({
			method: "POST",
			path: "/dev/run",
			body: { scenario: "never-recorded" },
		});
		expect(response.status).toBe(404);
	});

	it("lists the pact in the inventory, and the inventory lists nothing that is not there", async () => {
		expect(await checkPactInventory(contractsDir)).toEqual({
			ok: true,
			problems: [],
		});
	});
});
