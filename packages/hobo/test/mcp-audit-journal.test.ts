import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHoboCli } from "@hobo/cli";
import { createHoboMcpServer } from "@hobo/mcp";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { openMcpAuditJournal } from "../src/mcp-audit-journal.js";
import { localOperatorAuth } from "../src/mcp-stdio.js";

const homes: string[] = [];

afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

async function makeHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "hobo-mcp-audit-"));
	homes.push(home);
	return home;
}

async function readAudit(home: string) {
	const store = createRuntimeLocalEventStore({
		dataDir: join(home, "mcp-audit"),
	});
	try {
		const events = [];
		for await (const entry of store.readAll()) events.push(entry.event);
		return events;
	} finally {
		store.close();
	}
}

describe("durable MCP audit", () => {
	it("persists concurrent decisions and throttles across journal reopen", async () => {
		const home = await makeHome();
		const first = openMcpAuditJournal(home);
		const second = openMcpAuditJournal(home);
		const cli = createHoboCli();
		const left = createHoboMcpServer({
			cli,
			auditSink: first.record,
			rateLimitAuditSink: first.record,
			rateLimit: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 },
			clock: () => 0,
		});
		const right = createHoboMcpServer({ cli, auditSink: second.record });
		const auth = localOperatorAuth({
			HOBO_MCP_TOOLS: "up",
			HOBO_MCP_TENANT: "tenant-a",
		});
		const decisions = await Promise.all([
			left.callTool("plan", {}, auth),
			right.callTool("missing", {}, auth),
		]);
		expect(decisions.map((result) => result.code)).toEqual([
			"MCP_SCOPE_DENIED",
			"MCP_UNKNOWN_TOOL",
		]);
		expect((await left.callTool("plan", {}, auth)).code).toBe(
			"MCP_RATE_LIMITED",
		);
		first.close();
		second.close();
		expect((await stat(join(home, "mcp-audit"))).mode & 0o077).toBe(0);
		expect(
			(await stat(join(home, "mcp-audit", "eventstore.sqlite"))).mode & 0o077,
		).toBe(0);
		const events = await readAudit(home);
		expect(events.map((event) => event.type).sort()).toEqual(
			[
				"mcp.ToolCallDecided",
				"mcp.ToolCallDecided",
				"mcp.ToolCallThrottled",
			].sort(),
		);
		expect(new Set(events.map((event) => event.streamId)).size).toBe(3);
		expect(
			events.every(
				(event) => event.tenant === "tenant-a" && event.actor.kind === "user",
			),
		).toBe(true);
		expect(
			events.every(
				(event) => event.meta?.retention && event.meta.sourceEventId,
			),
		).toBe(true);
		expect(
			events.every(
				(event) => Math.abs(Date.now() - Date.parse(event.ts)) < 60_000,
			),
		).toBe(true);
	});

	it("refuses dispatch when the durable journal is unavailable", async () => {
		const home = await makeHome();
		const journal = openMcpAuditJournal(home);
		const cli = createHoboCli();
		let dispatched = false;
		const server = createHoboMcpServer({
			cli: {
				...cli,
				async run(argv, options) {
					dispatched = true;
					return cli.run(argv, options);
				},
			},
			auditSink: journal.record,
		});
		journal.close();
		const result = await server.callTool("plan", {}, localOperatorAuth({}));
		expect(result.code).toBe("MCP_AUDIT_UNAVAILABLE");
		expect(dispatched).toBe(false);
	});

	it("rejects public directories and database symlinks", async () => {
		const home = await makeHome();
		const dataDir = join(home, "mcp-audit");
		await mkdir(dataDir, { mode: 0o755 });
		await chmod(dataDir, 0o755);
		expect(() => openMcpAuditJournal(home)).toThrow();
		await chmod(dataDir, 0o700);
		const target = join(home, "untouched");
		await writeFile(target, "untouched");
		await symlink(target, join(dataDir, "eventstore.sqlite"));
		expect(() => openMcpAuditJournal(home)).toThrow();
		expect(await readFile(target, "utf8")).toBe("untouched");
	});

	it("records real stdio calls across separate server processes", async () => {
		const home = await makeHome();
		const temp = join(home, "tmp");
		await mkdir(temp);
		const bin = fileURLToPath(
			new URL("../dist/bin/hobo-mcp.js", import.meta.url),
		);
		const messages = [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "up",
					arguments: { args: ["do-not-persist-this-argument"] },
				},
			},
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "missing", arguments: {} },
			},
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "plan", arguments: { cwd: home } },
			},
		];
		for (let index = 0; index < 2; index += 1) {
			const child = spawn(process.execPath, [bin], {
				cwd: home,
				env: {
					PATH: process.env.PATH,
					HOBO_HOME: home,
					TMPDIR: temp,
					HOBO_MCP_TOOLS: "plan",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "";
			let errors = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				errors += chunk.toString();
			});
			child.stdin.end(
				`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			);
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			expect(code, errors).toBe(0);
			expect(output.trim().split("\n")).toHaveLength(3);
		}
		const events = await readAudit(home);
		expect(events).toHaveLength(6);
		expect(new Set(events.map((event) => event.streamId)).size).toBe(6);
		expect(events.every((event) => event.type === "mcp.ToolCallDecided")).toBe(
			true,
		);
		expect(JSON.stringify(events)).not.toContain(
			"do-not-persist-this-argument",
		);
	}, 60_000);
});
