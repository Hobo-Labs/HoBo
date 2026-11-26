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
	buildCursorLaunch,
	CURSOR_CREDENTIALS_MISSING,
	envCursorCredential,
	lowerSweCursorUsage,
	sweCursorConnector,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/swe-cursor-boundary.pact.json"),
		"utf8",
	),
);

const SANDBOX = parseSandboxPosture({
	schema: SANDBOX_POSTURE_SCHEMA,
	ambientCredentials: false,
	filesystem: { scope: "workspace", root: "/workspace/fixture-repo" },
	network: { scope: "allowlist", allowlist: ["api.cursor.com"] },
	envAllowlist: ["PATH"],
});

describe("swe-cursor launch (vendor bridge, brokered credentials)", () => {
	it("builds the pact-recorded bridge launch with exactly one injected brokered key", async () => {
		const launch = await buildCursorLaunch({
			sandbox: SANDBOX,
			credential: async () => "brokered-short-lived-key",
		});
		const recorded = pact.interactions[2].response.body;
		assert.equal(launch.command, recorded.command);
		assert.deepEqual([...launch.args], recorded.args);
		assert.equal(launch.cwd, "/workspace/fixture-repo");
		assert.equal(launch.env.CURSOR_API_KEY, "brokered-short-lived-key");
		const keys = Object.keys(launch.env).filter((key) => key !== "PATH");
		assert.deepEqual(keys, ["CURSOR_API_KEY"]);
	});

	it("gates on missing brokered credentials with the typed failure", async () => {
		await assert.rejects(
			buildCursorLaunch({
				sandbox: SANDBOX,
				credential: envCursorCredential({}),
			}),
			(error: { code?: string }) => error.code === CURSOR_CREDENTIALS_MISSING,
		);
	});

	it("connector('swe-cursor', { protocol: 'acp' }) resolves and lowers", () => {
		const binding = sweCursorConnector();
		assert.equal(binding.protocol, "acp");
		const entry = lowerSweCursorUsage([
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
