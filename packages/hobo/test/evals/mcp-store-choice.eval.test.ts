import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createHoboMcpServer, createSecretCaptureApp } from "@hobo/mcp";
import { describe, expect, it } from "vitest";
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

const toolResultSchema = z.object({
	content: z.array(z.object({ text: z.string() })),
	structuredContent: message.optional(),
	isError: z.boolean().optional(),
	_meta: message.optional(),
});
const toolsSchema = z.object({
	tools: z.array(z.object({ name: z.string(), _meta: message.optional() })),
});
const elicitSchema = z.object({
	message: z.string(),
	requestedSchema: z.object({
		properties: z.record(
			z.string(),
			z.object({
				enum: z.array(z.string()).optional(),
				enumNames: z.array(z.string()).optional(),
				format: z.string().optional(),
			}),
		),
	}),
});
const resourceSchema = z.object({
	contents: z.array(z.object({ text: z.string() })),
});
const toolResult = (m: Message) => toolResultSchema.parse(m.result);

function connect(capabilities: JsonObject) {
	const toServer = new PassThrough();
	const fromServer = new PassThrough();
	const saved = new Map<string, string>();
	const session = createMcpStdioSession(
		createSecretCaptureApp({
			specs: RELAY_SECRET_CAPTURE_SPECS,
			connector: createInfisicalCaptureConnector({
				projectDir: mkdtempSync(path.join(tmpdir(), "hobo-store-choice-")),
			}),
		}),
		createStoreChoiceApp({
			cwd: "/box/project",
			locatorFor: () => ({
				read: async () => Object.fromEntries(saved),
				write: async (values) => {
					saved.clear();
					for (const [k, v] of Object.entries(values)) saved.set(k, v);
				},
			}),
		}),
	);
	const serving = serveMcpStdio({
		server: createHoboMcpServer({ cli: createComposedHoboCli() }),
		auth: localOperatorAuth({}),
		input: toServer,
		output: fromServer,
		session,
	});
	const inbox: Message[] = [];
	const waiters: (() => void)[] = [];
	let buffer = "";
	fromServer.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			inbox.push(message.parse(JSON.parse(buffer.slice(0, nl))));
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
		}
		for (const wake of waiters.splice(0)) wake();
	});
	const next = async (match: (m: Message) => boolean): Promise<Message> => {
		for (;;) {
			const at = inbox.findIndex(match);
			const [found] = at === -1 ? [] : inbox.splice(at, 1);
			if (found !== undefined) return found;
			await new Promise<void>((resolve) => waiters.push(resolve));
		}
	};
	let id = 0;
	const send = (m: Message) => toServer.write(`${JSON.stringify(m)}\n`);
	const call = (method: string, params: JsonObject) => {
		id += 1;
		const mine = id;
		send({ jsonrpc: "2.0", id: mine, method, params });
		return mine;
	};
	const answer = (mine: number) =>
		next((m) => m.id === mine && m.method === undefined);
	return {
		saved,
		next,
		send,
		call,
		answer,
		rpc: (method: string, params: JsonObject = {}) =>
			answer(call(method, params)),
		init: () =>
			answer(
				call("initialize", { protocolVersion: "2025-06-18", capabilities }),
			),
		async close() {
			toServer.end();
			await serving;
		},
	};
}

describe("EVAL store choice over MCP: a picker the owner can answer", () => {
	it("elicits a form of the three stores with no secret field, and saves the answer", async () => {
		const client = connect({ elicitation: {} });
		await client.init();
		const names = toolsSchema
			.parse((await client.rpc("tools/list")).result)
			.tools.map((t) => t.name);
		expect(names).toContain(CHOOSE_SECRET_STORE_TOOL);

		const pending = client.call("tools/call", {
			name: CHOOSE_SECRET_STORE_TOOL,
			arguments: { family: "cd" },
		});
		const elicit = await client.next((m) => m.method === "elicitation/create");
		const params = elicitSchema.parse(elicit.params);
		expect(params.requestedSchema.properties.store?.enumNames).toEqual([
			"Infisical",
			"1Password",
			"Bitwarden",
		]);
		for (const [name, field] of Object.entries(
			params.requestedSchema.properties,
		)) {
			expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY$/u);
			expect(field.format).not.toBe("password");
		}
		expect(JSON.stringify(params)).not.toMatch(/Vaultwarden/u);
		expect(Object.keys(params.requestedSchema.properties)).toEqual(["store"]);
		client.send({
			jsonrpc: "2.0",
			id: elicit.id ?? null,
			result: { action: "accept", content: { store: "infisical" } },
		});
		const follow = await client.next((m) => m.method === "elicitation/create");
		const fields = elicitSchema.parse(follow.params);
		expect(Object.keys(fields.requestedSchema.properties)).toEqual([
			"INFISICAL_PROJECT_ID",
		]);
		expect(JSON.stringify(fields)).not.toMatch(/1Password|Bitwarden/u);
		client.send({
			jsonrpc: "2.0",
			id: follow.id ?? null,
			result: {
				action: "accept",
				content: { INFISICAL_PROJECT_ID: "proj-123" },
			},
		});
		const done = toolResult(await client.answer(pending));
		expect(JSON.stringify(done)).not.toContain("proj-123");
		expect(done.isError).toBeUndefined();
		expect(done.content[0]?.text).toMatch(
			/chose Infisical.*hobo cd up --hand-off again/su,
		);
		expect(Object.fromEntries(client.saved)).toEqual({
			HOBO_SECRET_STORE: "infisical",
			INFISICAL_PROJECT_ID: "proj-123",
		});
		await client.close();
	});

	it("records nothing when the owner declines, and says to ask again", async () => {
		const client = connect({ elicitation: {} });
		await client.init();
		const pending = client.call("tools/call", {
			name: CHOOSE_SECRET_STORE_TOOL,
			arguments: { family: "cd" },
		});
		const elicit = await client.next((m) => m.method === "elicitation/create");
		client.send({
			jsonrpc: "2.0",
			id: elicit.id ?? null,
			result: { action: "decline" },
		});
		const done = toolResult(await client.answer(pending));
		expect(done.content[0]?.text).toMatch(/declined.*Ask again/su);
		expect(client.saved.size).toBe(0);
		await client.close();
	});

	it("refuses an invalid answer where it enters, naming the rule", async () => {
		const client = connect({ elicitation: {} });
		await client.init();
		const pending = client.call("tools/call", {
			name: CHOOSE_SECRET_STORE_TOOL,
			arguments: { family: "cd" },
		});
		const elicit = await client.next((m) => m.method === "elicitation/create");
		client.send({
			jsonrpc: "2.0",
			id: elicit.id ?? null,
			result: { action: "accept", content: { store: "1password" } },
		});
		const follow = await client.next((m) => m.method === "elicitation/create");
		expect(
			Object.keys(elicitSchema.parse(follow.params).requestedSchema.properties),
		).toEqual(["OP_VAULT_ID", "OP_CONNECT_HOST"]);
		client.send({
			jsonrpc: "2.0",
			id: follow.id ?? null,
			result: { action: "accept", content: { OP_VAULT_ID: "vault-1" } },
		});
		const done = toolResult(await client.answer(pending));
		expect(done.isError).toBe(true);
		expect(done.content[0]?.text).toMatch(
			/OP_VAULT_ID.*26 lowercase letters/su,
		);
		expect(client.saved.size).toBe(0);
		await client.close();
	});

	it("shows the MCP App widget where the host renders MCP Apps", async () => {
		const client = connect({
			extensions: {
				"io.modelcontextprotocol/ui": {
					mimeTypes: ["text/html;profile=mcp-app"],
				},
			},
		});
		await client.init();
		const tools = toolsSchema.parse(
			(await client.rpc("tools/list")).result,
		).tools;
		const tool = tools.find((t) => t.name === CHOOSE_SECRET_STORE_TOOL);
		expect(tool?._meta).toMatchObject({
			ui: { resourceUri: STORE_CHOICE_RESOURCE_URI },
		});
		expect(
			tools.find((t) => t.name === SUBMIT_STORE_CHOICE_TOOL)?._meta,
		).toMatchObject({
			ui: { resourceUri: STORE_CHOICE_RESOURCE_URI, visibility: ["app"] },
		});
		const page = await client.rpc("resources/read", {
			uri: STORE_CHOICE_RESOURCE_URI,
		});
		const html = resourceSchema.parse(page.result).contents[0]?.text ?? "";
		for (const label of ["Infisical", "1Password", "Bitwarden"])
			expect(html).toContain(label);
		expect(html).not.toMatch(/Vaultwarden|type="password"/u);
		const shown = toolResult(
			await client.rpc("tools/call", {
				name: CHOOSE_SECRET_STORE_TOOL,
				arguments: { family: "cd" },
			}),
		);
		expect(shown._meta).toMatchObject({
			"ui/resourceUri": STORE_CHOICE_RESOURCE_URI,
		});
		await client.rpc("tools/call", {
			name: SUBMIT_STORE_CHOICE_TOOL,
			arguments: {
				family: "cd",
				store: "bitwarden",
				choiceTicket: shown._meta?.hoboChoiceTicket ?? null,
			},
		});
		expect(Object.fromEntries(client.saved)).toEqual({
			HOBO_SECRET_STORE: "bitwarden",
		});
		await client.close();
	});

	it("refuses a host without a secure owner form", async () => {
		const client = connect({});
		await client.init();
		const tools = toolsSchema.parse(
			(await client.rpc("tools/list")).result,
		).tools;
		expect(tools.some((tool) => tool.name === SUBMIT_STORE_CHOICE_TOOL)).toBe(
			false,
		);
		const direct = toolResult(
			await client.rpc("tools/call", {
				name: SUBMIT_STORE_CHOICE_TOOL,
				arguments: { family: "cd", store: "bitwarden" },
			}),
		);
		expect(direct.isError).toBe(true);
		const told = toolResult(
			await client.rpc("tools/call", {
				name: CHOOSE_SECRET_STORE_TOOL,
				arguments: { family: "cd" },
			}),
		);
		expect(told.content[0]?.text).toMatch(
			/do not ask for store coordinates in conversation/u,
		);
		expect(told.structuredContent).toMatchObject({
			status: "secure-form-unavailable",
			options: ["Infisical", "1Password", "Bitwarden"],
		});
		expect(client.saved.size).toBe(0);
		await client.close();
	});

	it("asks Bitwarden only its optional server, and nothing about the other stores", async () => {
		const client = connect({ elicitation: {} });
		await client.init();
		const pending = client.call("tools/call", {
			name: CHOOSE_SECRET_STORE_TOOL,
			arguments: { family: "ci" },
		});
		const elicit = await client.next((m) => m.method === "elicitation/create");
		client.send({
			jsonrpc: "2.0",
			id: elicit.id ?? null,
			result: { action: "accept", content: { store: "bitwarden" } },
		});
		const follow = await client.next((m) => m.method === "elicitation/create");
		const fields = elicitSchema.parse(follow.params);
		expect(Object.keys(fields.requestedSchema.properties)).toEqual([
			"BITWARDEN_SERVER_URL",
		]);
		expect(JSON.stringify(fields)).not.toMatch(/Infisical|1Password/u);
		client.send({
			jsonrpc: "2.0",
			id: follow.id ?? null,
			result: { action: "accept", content: {} },
		});
		await client.answer(pending);
		expect(Object.fromEntries(client.saved)).toEqual({
			HOBO_SECRET_STORE: "bitwarden",
		});
		await client.close();
	});
});
