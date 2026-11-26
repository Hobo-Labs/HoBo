import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createHoboMcpServer } from "../../src/server.js";
import {
	authGranting,
	closeStores,
	HELLO_BINDLE,
	makeWiredCli,
	withProject,
} from "../../test/helpers.js";

// The consumer side of the mcp-control-surface + identity-policy-boundary pacts
// (lifted from the cli-mcp epic). Each recorded interaction is backed by a real
// outcome from the SVID-bound MCP server. Note the pact's conceptual `deploy`
// tool is HoBo's `up` lifecycle verb (the canonical verb the surface derives).

const packageRoot = dirname(fileURLToPath(import.meta.url));

function loadPact(name: string) {
	return JSON.parse(readFileSync(join(packageRoot, "../pacts/", name), "utf8"));
}

afterEach(() => closeStores());

describe("mcp-control-surface pact — SVID-scoped agent boundary", () => {
	it("realizes both recorded interactions (plan allowed, missing scope denied)", async () => {
		const pact = loadPact("mcp-control-surface.pact.json");
		expect(pact.consumer.name).toBe("agent-mcp-client");
		expect(pact.provider.name).toBe("hobo-svid-bound-mcp-server");

		const allow = pact.interactions.find((i: { description: string }) =>
			i.description.includes("can call plan"),
		);
		const deny = pact.interactions.find((i: { description: string }) =>
			i.description.includes("denied"),
		);

		await withProject(HELLO_BINDLE, async (cwd) => {
			const server = createHoboMcpServer({ cli: makeWiredCli() });

			// "SVID-scoped agent can call plan" -> { ok:true, tool:"plan" }
			const planResult = await server.callTool(
				"plan",
				{ cwd },
				authGranting(["plan"]),
			);
			expect(planResult.ok).toBe(allow.response.body.ok);
			expect(planResult.tool).toBe(allow.response.body.tool);

			// "missing deploy scope is denied" -> { ok:false, code:"MCP_SCOPE_DENIED" }
			// (the `deploy` tool is the `up` lifecycle verb; the agent lacks its scope.)
			const deniedResult = await server.callTool(
				"up",
				{ cwd },
				authGranting(["plan"]),
			);
			expect(deniedResult.ok).toBe(deny.response.body.ok);
			expect(deniedResult.code).toBe(deny.response.body.code);
			expect(deniedResult.error?.code).toBe(deny.response.body.code);
		});
	});

	it("realizes the backpressure interaction (flooding principal throttled)", async () => {
		const pact = loadPact("mcp-control-surface.pact.json");
		const throttle = pact.interactions.find((i: { description: string }) =>
			i.description.includes("throttled"),
		);
		expect(throttle).toBeTruthy();

		await withProject(HELLO_BINDLE, async (cwd) => {
			// A single-token bucket with a frozen clock: the second call is refused.
			const server = createHoboMcpServer({
				cli: makeWiredCli(),
				rateLimit: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 },
				clock: () => 0,
			});
			const auth = authGranting(["plan"]);
			await server.callTool("plan", { cwd }, auth);
			const throttled = await server.callTool("plan", { cwd }, auth);
			expect(throttled.ok).toBe(throttle.response.body.ok);
			expect(throttled.code).toBe(throttle.response.body.code);
			expect(throttled.error?.code).toBe(throttle.response.body.code);
		});
	});
});

describe("identity-policy-boundary pact — fail-closed decision", () => {
	it("backs the mandatory-deny interaction with the fail-closed scope denial", async () => {
		const pact = loadPact("identity-policy-boundary.pact.json");
		const denyInteraction = pact.interactions.find(
			(i: { response: { body: { effect?: string } } }) =>
				i.response.body.effect === "deny",
		);
		expect(denyInteraction).toBeTruthy();

		await withProject(HELLO_BINDLE, async (cwd) => {
			const server = createHoboMcpServer({ cli: makeWiredCli() });
			const denied = await server.callTool(
				"up",
				{ cwd },
				authGranting(["plan"]),
			);
			// The MCP deny-by-default decision is the fail-closed effect the pact records.
			expect(denied.decision.effect).toBe(denyInteraction.response.body.effect);
			const auditEvent = server.getAuditEvents().at(-1);
			expect(auditEvent?.data.effect).toBe("deny");
		});
	});
});
