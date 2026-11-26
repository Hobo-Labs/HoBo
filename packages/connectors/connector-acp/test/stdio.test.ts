import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	ACP_AGENT_SPAWN_FAILED,
	ACP_SDK_MISSING,
	AcpAgentSpawnError,
	AcpSdkMissingError,
} from "../src/index.js";

describe("stdio lane (real @agentclientprotocol/sdk)", () => {
	it("the production ACP SDK is a real, loadable dependency", async () => {
		const sdk = await import("@agentclientprotocol/sdk");
		assert.equal(
			Object.prototype.toString.call(sdk.ClientSideConnection),
			"[object Function]",
		);
		assert.equal(
			Object.prototype.toString.call(sdk.ndJsonStream),
			"[object Function]",
		);
	});

	it("typed gates carry stable codes for missing SDK / failed spawn", () => {
		assert.equal(new AcpSdkMissingError("x").code, ACP_SDK_MISSING);
		assert.equal(
			new AcpAgentSpawnError("claude-code-acp", "ENOENT").code,
			ACP_AGENT_SPAWN_FAILED,
		);
	});
});
