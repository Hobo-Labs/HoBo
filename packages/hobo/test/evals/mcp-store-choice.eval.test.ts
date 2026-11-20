import { PassThrough } from "node:stream";
import { createHoboMcpServer, createSecretCaptureApp } from "@hobo/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createComposedHoboCli } from "../../src/cli.js";
import type { JsonObject } from "../../src/json.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
} from "../../src/mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	serveMcpStdio,
} from "../../src/mcp-stdio.js";
import {
	CHOOSE_SECRET_STORE_TOOL,
	createStoreChoiceApp,
	STORE_CHOICE_RESOURCE_URI,
	SUBMIT_STORE_CHOICE_TOOL,
} from "../../src/mcp-store-choice.js";

const message = z.record(z.string(), z.json());
type Message = z.infer<typeof message>;

function connect() {
	const input = new PassThrough();
	const output = new PassThrough();
	const saved = {
		HOBO_SECRET_STORE: "existing",
		INFISICAL_PROJECT_ID: "synthetic-existing",
	};
	const locatorFor = vi.fn(() => ({
		read: async () => ({ ...saved }),
		write: async (values: Record<string, string>) => {
			Object.assign(saved, values);
		},
	}));
	const session = createMcpStdioSession(
		createSecretCaptureApp({
			specs: RELAY_SECRET_CAPTURE_SPECS,
			connector: createInfisicalCaptureConnector({ projectDir: "/synthetic" }),
		}),
		createStoreChoiceApp({ cwd: "/synthetic", locatorFor }),
	);
	const serving = serveMcpStdio({
		server: createHoboMcpServer({ cli: createComposedHoboCli() }),
		auth: localOperatorAuth({}),
		input,
		output,
		session,
		formDeadlineMs: 250,
	});
	let trace = "";
	let buffer = "";
	let nextId = 0;
	const pending = new Map<number, (value: Message) => void>();
	output.on("data", (chunk: Buffer) => {
		trace += chunk.toString();
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const value = message.parse(JSON.parse(buffer.slice(0, newline)));
			buffer = buffer.slice(newline + 1);
			const id = z.number().safeParse(value.id);
			if (id.success && value.method === undefined) {
				pending.get(id.data)?.(value);
				pending.delete(id.data);
			}
			newline = buffer.indexOf("\n");
		}
	});
	return {
		saved,
		locatorFor,
		trace: () => trace,
		send(value: Message) {
			input.write(`${JSON.stringify(value)}\n`);
		},
		rpc(method: string, params: JsonObject = {}) {
			const id = ++nextId;
			const answer = new Promise<Message>((resolve) =>
				pending.set(id, resolve),
			);
			input.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
			return answer;
		},
		async close() {
			input.end();
			await serving;
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("owner store choice over raw MCP stdio", () => {
	it.each([
		["no advertised form", {}],
		["advertised form", { elicitation: { form: {} } }],
		[
			"advertised app",
			{
				extensions: {
					"io.modelcontextprotocol/ui": {
						mimeTypes: ["text/html;profile=mcp-app"],
					},
				},
			},
		],
		[
			"both advertised",
			{
				elicitation: {},
				extensions: {
					"io.modelcontextprotocol/ui": {
						mimeTypes: ["text/html;profile=mcp-app"],
					},
				},
			},
		],
	])("refuses %s without collecting or saving a choice", async (_label, capabilities) => {
		const stderr = vi.spyOn(process.stderr, "write");
		stderr.mockImplementation(() => true);
		const client = connect();
		const marker = "synthetic-private-owner-coordinate";
		try {
			await client.rpc("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: { ...capabilities, syntheticPrivateField: marker },
			});
			const listed = await client.rpc("tools/list");
			const tools = z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse(listed.result).tools;
			expect(tools.map((tool) => tool.name)).toContain(
				CHOOSE_SECRET_STORE_TOOL,
			);
			expect(tools.map((tool) => tool.name)).not.toContain(
				SUBMIT_STORE_CHOICE_TOOL,
			);
			const choice = await client.rpc("tools/call", {
				name: CHOOSE_SECRET_STORE_TOOL,
				arguments: { family: "cd", INFISICAL_PROJECT_ID: marker },
			});
			expect(choice.result).toMatchObject({
				isError: true,
				content: [
					{
						type: "text",
						text: "Private owner store selection is not yet available in this HoBo MCP implementation. This tool cannot establish an owner store session.",
					},
				],
				structuredContent: {
					status: "secure-form-unavailable",
					reason: "owner-setup-unavailable",
				},
			});
			const submitted = await client.rpc("tools/call", {
				name: SUBMIT_STORE_CHOICE_TOOL,
				arguments: {
					family: "ci",
					store: "infisical",
					INFISICAL_PROJECT_ID: marker,
					OP_VAULT_ID: marker,
					BITWARDEN_SERVER_URL: marker,
				},
			});
			expect(submitted.result).toMatchObject({
				isError: true,
				structuredContent: {
					status: "secure-form-unavailable",
					reason: "owner-setup-unavailable",
				},
			});
			const resources = await client.rpc("resources/list");
			expect(JSON.stringify(resources)).not.toContain(
				STORE_CHOICE_RESOURCE_URI,
			);
			const page = await client.rpc("resources/read", {
				uri: STORE_CHOICE_RESOURCE_URI,
			});
			expect(page.error).toMatchObject({ code: -32002 });
			client.send({
				jsonrpc: "2.0",
				id: "hobo-1",
				result: { action: "accept", content: { INFISICAL_PROJECT_ID: marker } },
			});
			await client.rpc("ping");
			expect(client.saved).toEqual({
				HOBO_SECRET_STORE: "existing",
				INFISICAL_PROJECT_ID: "synthetic-existing",
			});
			expect(client.locatorFor).not.toHaveBeenCalled();
			expect(client.trace()).not.toContain("elicitation/create");
			expect(client.trace()).not.toContain(marker);
			expect(JSON.stringify(stderr.mock.calls)).not.toContain(marker);
		} finally {
			await client.close();
		}
	});
});
