import { KEPT_STORE_SIGN_INS } from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";

import {
	createMcpOwnerChannel,
	INFISICAL_CLI_SESSION,
} from "../src/mcp-owner-channel.js";

const SIGN_IN = "synthetic-store-sign-in";

describe("what the owner page deposits in the MCP owner channel", () => {
	it("keeps a store sign-in in the channel's vault, where a run's sign-in restores it", () => {
		for (const name of KEPT_STORE_SIGN_INS) {
			const owner = createMcpOwnerChannel();
			owner.deposit(name, SIGN_IN);
			expect(owner.vault?.reveal(name)).toBe(SIGN_IN);
			expect(owner.holds(name)).toBe(false);
		}
	});

	it("holds anything else for the capture that asks for it, taken once", async () => {
		const owner = createMcpOwnerChannel();
		owner.deposit(INFISICAL_CLI_SESSION, SIGN_IN);
		expect(owner.vault?.reveal(INFISICAL_CLI_SESSION)).toBeUndefined();
		expect(owner.holds(INFISICAL_CLI_SESSION)).toBe(true);
		expect(
			await owner.captureSecret({
				name: INFISICAL_CLI_SESSION,
				title: "Infisical sign-in",
				instructions: "",
			}),
		).toBe(SIGN_IN);
		expect(owner.holds(INFISICAL_CLI_SESSION)).toBe(false);
	});
});
