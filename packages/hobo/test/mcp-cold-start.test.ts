import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

// SPEC: a host waits a fixed time (30 seconds in Claude Code) for hobo-mcp
// to answer `initialize`, and gives up on the server for the session if it
// does not. On a machine that has just booted, loading the full server took
// longer than that and the owner's ceremony lost its tools. The entry point
// therefore answers `initialize` before the full server has loaded; the full
// server still sees the host's `initialize` (its capabilities decide which
// forms the owner gets), and the host gets exactly one answer to it.
//
// The full server is held from loading by a module hook until the test
// releases it (SIGUSR2): no timer stands in for "slow".

/** A JSON-RPC message's fields, as the wire carries them. */
type Rpc =
	| string
	| number
	| boolean
	| null
	| readonly Rpc[]
	| { readonly [key: string]: Rpc };

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const Message = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	result: z.record(z.string(), z.json()).optional(),
});

// Loading the full server under a loaded test run takes a while: a budget
// for the test, not a wait in the product.
// A failing run leaves no server behind.
const started: { kill(): boolean }[] = [];
afterEach(() => {
	for (const child of started.splice(0)) child.kill();
});

describe("SPEC hobo-mcp cold start", { timeout: 120_000 }, () => {
	it("answers initialize while the full server is still loading, then serves it", async () => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--import",
				"./test/support/hold-mcp-serve.mjs",
				"src/bin/hobo-mcp.ts",
			],
			{ cwd: packageDir, stdio: ["pipe", "pipe", "pipe"] },
		);
		started.push(child);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const seen: z.infer<typeof Message>[] = [];
		const waiters: (() => void)[] = [];
		createInterface({ input: child.stdout }).on("line", (line) => {
			seen.push(Message.parse(JSON.parse(line)));
			for (const wake of waiters.splice(0)) wake();
		});
		const answerTo = async (id: number) => {
			for (;;) {
				const found = seen.find((message) => message.id === id);
				if (found !== undefined) return found;
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		};
		const send = (message: { readonly [key: string]: Rpc }) =>
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

		send({
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {
					elicitation: { form: {}, url: {} },
					extensions: {
						"io.modelcontextprotocol/ui": {
							mimeTypes: ["text/html;profile=mcp-app"],
						},
					},
					syntheticPrivateField: "synthetic-private-owner-coordinate",
				},
			},
		});
		send({ method: "notifications/initialized" });
		send({ id: 2, method: "tools/list" });

		// Answered while the full server cannot load.
		expect((await answerTo(1)).result).toMatchObject({
			protocolVersion: "2025-11-25",
			capabilities: { tools: {}, resources: {} },
			serverInfo: { name: "hobo-mcp" },
		});
		expect(seen.some((message) => message.id === 2)).toBe(false);

		// Loaded: the queued request is served, and the full server saw the
		// host's initialize (its capabilities).
		child.kill("SIGUSR2");
		const tools = z
			.object({ tools: z.array(z.object({ name: z.string() })) })
			.parse((await answerTo(2)).result);
		expect(tools.tools.map((tool) => tool.name)).toContain("capture_secret");
		expect(tools.tools.map((tool) => tool.name)).toContain(
			"submit_secret_value",
		);
		expect(stderr).not.toContain('"elicitation":{"form":{},"url":{}}');
		expect(stderr).not.toContain("synthetic-private-owner-coordinate");
		expect(seen.filter((message) => message.id === 1)).toHaveLength(1);

		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.stdin.end();
		await exited;
	});

	it("the full server refuses to start: the entry point ends, it does not linger answering nothing", async () => {
		// Found in review: initialize was already answered, the full server
		// refused (a credential refusal), and the process kept reading stdin
		// with nothing behind it until the host closed it.
		const child = spawn(
			process.execPath,
			["--import", "tsx", "src/bin/hobo-mcp.ts"],
			{
				cwd: packageDir,
				stdio: ["pipe", "pipe", "pipe"],
				// A proxied run's command: the guard refuses this process's
				// credentials when the server composes.
				env: { ...process.env, HOBO_OPENSESAME_CHILD: "1" },
			},
		);
		started.push(child);
		const exited = new Promise<number | null>((resolve) =>
			child.once("exit", resolve),
		);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } })}\n`,
		);
		// stdin stays open: only the refusal may end the process.
		expect(await exited).toBe(1);
	});
});
