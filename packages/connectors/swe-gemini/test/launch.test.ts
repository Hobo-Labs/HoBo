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
	buildGeminiLaunch,
	envGeminiCredential,
	GEMINI_CREDENTIALS_MISSING,
	lowerSweGeminiUsage,
	sweGeminiConnector,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/swe-gemini-boundary.pact.json"),
		"utf8",
	),
);

const SANDBOX = parseSandboxPosture({
	schema: SANDBOX_POSTURE_SCHEMA,
	ambientCredentials: false,
	filesystem: { scope: "workspace", root: "/workspace/shop" },
	network: {
		scope: "allowlist",
		allowlist: ["generativelanguage.googleapis.com"],
	},
	envAllowlist: ["PATH"],
});

describe("swe-gemini launch (brokered credentials, sandbox scrub)", () => {
	it("builds the pact-recorded stock launch with exactly one injected brokered key", async () => {
		const launch = await buildGeminiLaunch({
			sandbox: SANDBOX,
			credential: async () => "brokered-short-lived-key",
		});
		const recorded = pact.interactions[2].response.body;
		assert.equal(launch.command, recorded.command);
		assert.deepEqual([...launch.args], recorded.args);
		assert.equal(launch.cwd, "/workspace/shop");
		assert.equal(launch.env.GEMINI_API_KEY, "brokered-short-lived-key");
		// Nothing ambient leaks: only the allowlist + the injected key.
		const keys = Object.keys(launch.env).filter((key) => key !== "PATH");
		assert.deepEqual(keys, ["GEMINI_API_KEY"]);
	});

	it("gates on missing brokered credentials with the typed failure", async () => {
		await assert.rejects(
			buildGeminiLaunch({
				sandbox: SANDBOX,
				credential: envGeminiCredential({}),
			}),
			(error: { code?: string }) => error.code === GEMINI_CREDENTIALS_MISSING,
		);
	});

	it("connector('swe-gemini', { protocol: 'acp' }) resolves and lowers", () => {
		const binding = sweGeminiConnector();
		assert.equal(binding.protocol, "acp");
		const entry = lowerSweGeminiUsage(["workspace.read", "workspace.write"]);
		assert.equal(entry.protocol, "acp");
		assert.deepEqual([...entry.allow], ["workspace:read", "workspace:write"]);
		assert.equal(entry.requestedScopeSource, "usage-inferred");
	});
});
