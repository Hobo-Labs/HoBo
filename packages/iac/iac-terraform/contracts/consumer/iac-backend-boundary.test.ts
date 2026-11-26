import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	createTerraformAdapter,
	createTrivialIacProgram,
	PINNED_TOFU_VERSION,
	runIacBackendConformance,
} from "../../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/iac_backend_boundary.pact.json"),
		"utf8",
	),
);

describe("IaC Terraform backend consumer boundary", () => {
	it("matches the recorded conformance interaction", async () => {
		const interaction = pact.interactions[0];
		const result = await runIacBackendConformance({
			adapter: createTerraformAdapter(),
			program: createTrivialIacProgram(),
		});

		expect(result.suite).toBe(interaction.response.body.suite);
		expect(result.provider).toBe(interaction.response.body.provider);
		expect(result.passed).toBe(interaction.response.body.passed);
		expect(result.assertions).toEqual(interaction.response.body.assertions);
	});

	it("matches the recorded adapter identity interaction", () => {
		const interaction = pact.interactions[1];
		const adapter = createTerraformAdapter();

		expect(adapter.id).toBe(interaction.response.body.id);
		expect(adapter.binary).toBe(interaction.response.body.binary);
		expect(adapter.toolchainVersion).toBe(
			interaction.response.body.toolchainVersion,
		);
		expect(adapter.toolchainVersion).toBe(PINNED_TOFU_VERSION);
		expect(adapter.stateBackend.kind).toBe("memory");
	});
});
