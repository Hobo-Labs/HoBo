import { createHoboCli } from "@hobo/cli";
import { describe, expect, it, vi } from "vitest";
import { createHoboMcpServer } from "../src/server.js";
import { authGranting } from "./helpers.js";

describe("MCP audit boundary", () => {
	it("waits for the decision record before dispatching an allowed command", async () => {
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const auditSink = vi.fn(async () => pending);
		const cli = createHoboCli();
		const run = vi.spyOn(cli, "run").mockResolvedValue({
			exitCode: 0,
			stdout: '{"ok":true,"status":"ok"}',
			stderr: "",
		});
		const server = createHoboMcpServer({ cli, auditSink });
		const call = server.callTool("plan", {}, authGranting(["plan"]));
		expect(auditSink).toHaveBeenCalledOnce();
		expect(run).not.toHaveBeenCalled();
		release();
		expect((await call).ok).toBe(true);
		expect(run).toHaveBeenCalledOnce();
		expect(server.getAuditEvents()).toHaveLength(1);
	});

	it.each([
		"synchronous",
		"asynchronous",
	])("fails closed when an %s audit sink fails", async (mode) => {
		const cli = createHoboCli();
		const run = vi.spyOn(cli, "run");
		const fail = () => {
			throw new Error("private storage failure");
		};
		const server = createHoboMcpServer({
			cli,
			auditSink: mode === "synchronous" ? fail : async () => fail(),
		});
		const result = await server.callTool("plan", {}, authGranting(["plan"]));
		expect(result).toMatchObject({
			ok: false,
			status: "unavailable",
			code: "MCP_AUDIT_UNAVAILABLE",
			output: null,
		});
		expect(JSON.stringify(result)).not.toContain("private storage failure");
		expect(run).not.toHaveBeenCalled();
		expect(server.getAuditEvents()).toEqual([]);
	});

	it("fails closed when an unknown-tool or throttle record cannot be saved", async () => {
		const cli = createHoboCli();
		const run = vi.spyOn(cli, "run");
		const failedDecision = createHoboMcpServer({
			cli,
			auditSink: async () => {
				throw new Error("unavailable");
			},
		});
		expect(
			(await failedDecision.callTool("unknown", {}, authGranting([]))).code,
		).toBe("MCP_AUDIT_UNAVAILABLE");

		const failedThrottle = createHoboMcpServer({
			cli,
			rateLimit: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 },
			clock: () => 0,
			rateLimitAuditSink: async () => {
				throw new Error("unavailable");
			},
		});
		expect(
			(await failedThrottle.callTool("plan", {}, authGranting([]))).code,
		).toBe("MCP_SCOPE_DENIED");
		expect(
			(await failedThrottle.callTool("plan", {}, authGranting([]))).code,
		).toBe("MCP_AUDIT_UNAVAILABLE");
		expect(failedThrottle.getRateLimitEvents()).toEqual([]);
		expect(run).not.toHaveBeenCalled();
	});

	it("assigns distinct event IDs across server restarts", async () => {
		const cli = createHoboCli();
		const first = createHoboMcpServer({ cli });
		const second = createHoboMcpServer({ cli });
		await first.callTool("plan", {}, authGranting([]));
		await second.callTool("plan", {}, authGranting([]));
		expect(first.getAuditEvents()[0]?.id).not.toBe(
			second.getAuditEvents()[0]?.id,
		);
	});
});
