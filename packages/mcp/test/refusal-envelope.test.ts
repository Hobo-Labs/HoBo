import { describe, expect, it } from "vitest";

import { createHoboMcpServer } from "../src/server.js";
import { authGranting, makeWiredCli } from "./helpers.js";

// A refused command's message and remediation reach the agent through MCP:
// the remediation is what the agent relays to the owner (a sign-in link, the
// capture that carries its result back). Dropping it left the agent with a
// bare code.
describe("MCP tool results keep a refusal's message and remediation", () => {
	it("passes them through from the CLI's JSON envelope", async () => {
		const refusal = {
			ok: false,
			verb: "cd",
			status: "needs-connection",
			code: "HOBO_CD_INFISICAL_SIGN_IN",
			message: "Sign in to Infisical once.",
			remediation: [
				"HOBO_OWNER_SIGN_IN url=https://app.infisical.com/login?callback_port=41234 capture=INFISICAL_CLI_SESSION",
				"Then run again.",
			],
			data: {},
		};
		const server = createHoboMcpServer({
			cli: {
				...makeWiredCli(),
				run: async () => ({
					exitCode: 1,
					stdout: JSON.stringify(refusal),
					stderr: "",
				}),
			},
		});
		const result = await server.callTool(
			"plan",
			{ cwd: "." },
			authGranting(["plan"]),
		);
		expect(result.ok).toBe(false);
		expect(result.output).toMatchObject({
			code: "HOBO_CD_INFISICAL_SIGN_IN",
			message: "Sign in to Infisical once.",
			remediation: refusal.remediation,
		});
	});
});
