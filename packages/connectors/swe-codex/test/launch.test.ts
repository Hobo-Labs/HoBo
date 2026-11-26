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
	buildCodexLaunch,
	CODEX_CREDENTIALS_MISSING,
	envCodexCredential,
	lowerSweCodexUsage,
	sweCodexConnector,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/swe-codex-boundary.pact.json"),
		"utf8",
	),
);

const SANDBOX = parseSandboxPosture({
	schema: SANDBOX_POSTURE_SCHEMA,
	ambientCredentials: false,
	filesystem: { scope: "workspace", root: "/workspace/fixture-repo" },
	network: { scope: "allowlist", allowlist: ["api.openai.com"] },
	envAllowlist: ["PATH"],
});

describe("swe-codex launch (vendor bridge, brokered credentials)", () => {
	it("builds the pact-recorded bridge launch with exactly one injected brokered key", async () => {
		const launch = await buildCodexLaunch({
			sandbox: SANDBOX,
			credential: async () => "brokered-short-lived-key",
		});
		const recorded = pact.interactions[2].response.body;
		assert.equal(launch.command, recorded.command);
		assert.deepEqual([...launch.args], recorded.args);
		assert.equal(launch.cwd, "/workspace/fixture-repo");
		assert.equal(launch.env.OPENAI_API_KEY, "brokered-short-lived-key");
		const keys = Object.keys(launch.env).filter((key) => key !== "PATH");
		assert.deepEqual(keys, ["OPENAI_API_KEY"]);
	});

	it("gates on missing brokered credentials with the typed failure", async () => {
		await assert.rejects(
			buildCodexLaunch({
				sandbox: SANDBOX,
				credential: envCodexCredential({}),
			}),
			(error: { code?: string }) => error.code === CODEX_CREDENTIALS_MISSING,
		);
	});

	it("connector('swe-codex', { protocol: 'acp' }) resolves and lowers", () => {
		const binding = sweCodexConnector();
		assert.equal(binding.protocol, "acp");
		const entry = lowerSweCodexUsage([
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
