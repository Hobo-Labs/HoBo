import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	createCrossplaneIacAdapter,
	createFixtureIacProgram,
	runIacBackendConformance,
} from "../../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/iac_backend_boundary.pact.json"),
		"utf8",
	),
);

describe("IaC Crossplane backend consumer boundary", () => {
	it("matches the recorded conformance interaction", async () => {
		const interaction = pact.interactions[0];
		const result = await runIacBackendConformance({
			adapter: createCrossplaneIacAdapter(),
			program: createFixtureIacProgram(),
		});

		expect(result.suite).toBe(interaction.response.body.suite);
		expect(result.provider).toBe(interaction.response.body.provider);
		expect(result.passed).toBe(interaction.response.body.passed);
		expect(result.assertions).toEqual(interaction.response.body.assertions);
	});

	it("matches the recorded adapter identity interaction", () => {
		const interaction = pact.interactions[1];
		const adapter = createCrossplaneIacAdapter();

		expect(adapter.id).toBe(interaction.response.body.id);
		expect(adapter.model).toBe(interaction.response.body.model);
	});
});
