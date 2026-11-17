import { createHoboCli } from "@hobo/cli";
import { expect, it } from "vitest";
import { CAPTURE_SECRET_TOOL } from "../src/secret-capture/app.js";
import { createHoboMcpServer } from "../src/server.js";
import { authGranting } from "./helpers.js";

it("audits capture authorization before allowing the caller to proceed", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = createHoboMcpServer({
		cli: createHoboCli(),
		auditSink: async () => gate,
	});
	const pending = server.authorizeCaptureTool(
		CAPTURE_SECRET_TOOL,
		authGranting([CAPTURE_SECRET_TOOL]),
	);
	let settled = false;
	void pending.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	release();
	expect(await pending).toMatchObject({
		ok: true,
		decision: { effect: "allow" },
	});
	expect(server.getAuditEvents()[0]?.data).toMatchObject({
		tool: CAPTURE_SECRET_TOOL,
		effect: "allow",
	});
});

it("records denial and refuses to authorize when audit fails", async () => {
	const denied = createHoboMcpServer({ cli: createHoboCli() });
	expect(
		await denied.authorizeCaptureTool(CAPTURE_SECRET_TOOL, authGranting([])),
	).toMatchObject({ code: "MCP_SCOPE_DENIED" });
	expect(denied.getAuditEvents()[0]?.data.effect).toBe("deny");
	const unavailable = createHoboMcpServer({
		cli: createHoboCli(),
		auditSink: async () => {
			throw new Error("private failure");
		},
	});
	const result = await unavailable.authorizeCaptureTool(
		CAPTURE_SECRET_TOOL,
		authGranting([CAPTURE_SECRET_TOOL]),
	);
	expect(result).toMatchObject({ ok: false, code: "MCP_AUDIT_UNAVAILABLE" });
	expect(JSON.stringify(result)).not.toContain("private failure");
});

it("shares rate limits between capture and command tools", async () => {
	const server = createHoboMcpServer({
		cli: createHoboCli(),
		rateLimit: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 },
		clock: () => 0,
	});
	expect(
		(
			await server.authorizeCaptureTool(
				CAPTURE_SECRET_TOOL,
				authGranting([CAPTURE_SECRET_TOOL]),
			)
		).ok,
	).toBe(true);
	expect((await server.callTool("plan", {}, authGranting(["plan"]))).code).toBe(
		"MCP_RATE_LIMITED",
	);
	expect(server.getRateLimitEvents()[0]?.data.tool).toBe("plan");
});

it("does not authorize arbitrary names as capture tools", async () => {
	const server = createHoboMcpServer({ cli: createHoboCli() });
	expect(
		(await server.authorizeCaptureTool("plan", authGranting(["plan"]))).code,
	).toBe("MCP_UNKNOWN_TOOL");
});
