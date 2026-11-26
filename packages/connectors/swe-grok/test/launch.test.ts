import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseSandboxPosture,
	SANDBOX_POSTURE_SCHEMA,
} from "@hobo/connector-acp";
import { describe, it } from "vitest";

import {
	buildGrokLaunch,
	envGrokCredential,
	GROK_CREDENTIALS_MISSING,
	lowerSweGrokUsage,
	sweGrokConnector,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/swe-grok-boundary.pact.json"),
		"utf8",
	),
);

const SANDBOX = parseSandboxPosture({
	schema: SANDBOX_POSTURE_SCHEMA,
	ambientCredentials: false,
	filesystem: { scope: "workspace", root: "/workspace/fixture-repo" },
	network: { scope: "allowlist", allowlist: ["api.x.ai"] },
	envAllowlist: ["PATH"],
});

describe("swe-grok launch (vendor bridge, brokered credentials)", () => {
	it("builds the pact-recorded bridge launch with exactly one injected brokered key", async () => {
		const launch = await buildGrokLaunch({
			sandbox: SANDBOX,
			credential: async () => "brokered-short-lived-key",
		});
		const recorded = pact.interactions[2].response.body;
		assert.equal(launch.command, recorded.command);
		assert.deepEqual([...launch.args], recorded.args);
		assert.equal(launch.cwd, "/workspace/fixture-repo");
		assert.equal(launch.env.XAI_API_KEY, "brokered-short-lived-key");
		const keys = Object.keys(launch.env).filter((key) => key !== "PATH");
		assert.deepEqual(keys, ["XAI_API_KEY"]);
	});

	it("gates on missing brokered credentials with the typed failure", async () => {
		await assert.rejects(
			buildGrokLaunch({
				sandbox: SANDBOX,
				credential: envGrokCredential({}),
			}),
			(error: { code?: string }) => error.code === GROK_CREDENTIALS_MISSING,
		);
	});

	it("connector('swe-grok', { protocol: 'acp' }) resolves and lowers", () => {
		const binding = sweGrokConnector();
		assert.equal(binding.protocol, "acp");
		const entry = lowerSweGrokUsage([
			"workspace.read",
			"workspace.write",
			"tests.run",
		]);
		assert.equal(entry.protocol, "acp");
		assert.deepEqual(
			[...entry.allow],
			["tests:run", "workspace:read", "workspace:write"],
		);
		assert.equal(entry.requestedScopeSource, "usage-inferred");
	});
});
