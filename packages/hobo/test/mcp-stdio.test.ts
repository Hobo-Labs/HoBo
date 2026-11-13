import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CANONICAL_VERBS } from "@hobo/cli";
import { first } from "@hobo/core/total-access";
import { createHoboMcpServer } from "@hobo/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";
import { isJsonObject, parseJsonValue } from "../src/json.js";
import {
	handleMcpMessage,
	localOperatorAuth,
	serveMcpStdio,
} from "../src/mcp-stdio.js";

// Verification: the runnable MCP surface serves a
// tool list with exact parity against CANONICAL_VERBS and dispatches calls
// through the same composed command registry as the `hobo` binary.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

function createServer() {
	return createHoboMcpServer({ cli: createComposedHoboCli() });
}

describe("hobo-mcp stdio surface (3-3)", () => {
	it("initialize handshake identifies the server", async () => {
		const response = await handleMcpMessage(
			createServer(),
			localOperatorAuth({}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18" },
			}),
		);
		expect(response).not.toBeNull();
		// SAFETY: assertion required at this I/O or test boundary.
		const result = response?.result as {
			serverInfo: { name: string };
			capabilities: { tools: object };
		};
		expect(result.serverInfo.name).toBe("hobo-mcp");
		expect(result.capabilities.tools).toBeDefined();
	});

	it("tools/list has exact parity with CANONICAL_VERBS", async () => {
		const response = await handleMcpMessage(
			createServer(),
			localOperatorAuth({}),
			JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const result = response?.result as { tools: Array<{ name: string }> };
		expect(result.tools.map((tool) => tool.name)).toEqual(
			CANONICAL_VERBS.map((verb) => verb.name),
		);
	});

	it("tools/call dispatches through the composed registry", async () => {
		const projectDir = await mkdtemp(path.join(tmpdir(), "hobo-mcp-"));
		cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
		await mkdir(path.join(projectDir, "src"), { recursive: true });
		await writeFile(
			path.join(projectDir, "src", "bindle.js"),
			`export default {
	name: "mcp-e2e",
	resources: {
		api: { kind: "api", name: "api", stableId: "api:api", declaredAllow: [], annotations: [], dependsOn: [] },
	},
	edges: [],
};
`,
		);
		const response = await handleMcpMessage(
			createServer(),
			localOperatorAuth({}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "collect", arguments: { cwd: projectDir } },
			}),
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const result = response?.result as {
			isError: boolean;
			content: Array<{ text: string }>;
		};
		expect(result.isError).toBe(false);
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = parseJsonValue(first(result.content).text);
		expect(isJsonObject(envelope)).toBe(true);
		expect(isJsonObject(envelope) ? envelope.code : undefined).toBe("HOBO_OK");
		const data = isJsonObject(envelope) ? envelope.data : undefined;
		expect(isJsonObject(data) ? data.bindleId : undefined).toBe("mcp-e2e");
	});

	it("scope restriction denies unlisted tools before dispatch", async () => {
		const response = await handleMcpMessage(
			createServer(),
			localOperatorAuth({ HOBO_MCP_TOOLS: "plan" }),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "up", arguments: {} },
			}),
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const result = response?.result as { isError: boolean };
		expect(result.isError).toBe(true);
	});

	it("serves newline-delimited JSON-RPC over streams end to end", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		const done = serveMcpStdio({
			server: createServer(),
			auth: localOperatorAuth({}),
			input,
			output,
		});
		input.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
		);
		input.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		input.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
		);
		input.end();
		await done;

		const lines = Buffer.concat(chunks)
			.toString()
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			// SAFETY: assertion required at this I/O or test boundary.
			.map((line: string) => {
				const parsed = parseJsonValue(line);
				return { id: isJsonObject(parsed) ? parsed.id : null };
			});
		// The notification produced no response: exactly two replies.
		expect(lines.map((line) => line.id)).toEqual([1, 2]);
	});
});
