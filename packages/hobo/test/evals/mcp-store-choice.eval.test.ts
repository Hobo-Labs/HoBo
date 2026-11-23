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
import type {
	OwnerSessionState,
	OwnerStoreSessions,
} from "../../src/owner-store-session.js";

const message = z.record(z.string(), z.json());
type Message = z.infer<typeof message>;

const PRIVATE = "synthetic-private-owner-coordinate";
const VAULT_ID = "abcdefghijklmnopqrstuvwxyz";
const CONNECT_HOST = "https://connect.synthetic-private.example";
const APPS = {
	extensions: {
		"io.modelcontextprotocol/ui": {
			mimeTypes: ["text/html;profile=mcp-app"],
		},
	},
};

const toolResult = z.object({
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
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
				oneOf: z
					.array(z.object({ const: z.string(), title: z.string() }))
					.optional(),
				format: z.string().optional(),
			}),
		),
	}),
});

function fakeSessions(
	outcome: OwnerSessionState = { status: "established", store: "Infisical" },
) {
	const established = new Map<string, OwnerSessionState>();
	const establish = vi.fn(async (cwd: string) => {
		if (outcome.status === "established") established.set(cwd, outcome);
		return outcome;
	});
	const sessions: OwnerStoreSessions = {
		establish,
		status(cwd) {
			const held = established.get(cwd);
			return held?.status === "established"
				? { established: true, store: held.store }
				: { established: false };
		},
		credentials: () => ({
			resolve: async () => {
				throw new Error("not used");
			},
		}),
		close: () => established.clear(),
	};
	return { sessions, establish };
}

function connect(
	capabilities: JsonObject,
	options: {
		readonly saved?: Record<string, string>;
		readonly sessions?: OwnerStoreSessions;
		readonly failWrites?: boolean;
	} = {},
) {
	const input = new PassThrough();
	const output = new PassThrough();
	const saved = { ...options.saved };
	const locatorFor = vi.fn(() => ({
		read: async () => ({ ...saved }),
		write: async (values: Record<string, string>) => {
			if (options.failWrites === true)
				throw new Error(`cannot write ${PRIVATE}`);
			for (const key of Object.keys(saved)) delete saved[key];
			Object.assign(saved, values);
		},
	}));
	const session = createMcpStdioSession(
		createSecretCaptureApp({
			specs: RELAY_SECRET_CAPTURE_SPECS,
			connector: createInfisicalCaptureConnector({ projectDir: "/synthetic" }),
		}),
		createStoreChoiceApp({
			cwd: "/synthetic/project",
			locatorFor,
			...(options.sessions !== undefined
				? { sessions: options.sessions }
				: undefined),
		}),
	);
	const serving = serveMcpStdio({
		server: createHoboMcpServer({ cli: createComposedHoboCli() }),
		auth: localOperatorAuth({}),
		input,
		output,
		session,
		formDeadlineMs: 2_000,
	});
	let trace = "";
	let buffer = "";
	let nextId = 0;
	const inbox: Message[] = [];
	const waiters: (() => void)[] = [];
	output.on("data", (chunk: Buffer) => {
		trace += chunk.toString();
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			inbox.push(message.parse(JSON.parse(buffer.slice(0, newline))));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
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
	const send = (value: Message) => input.write(`${JSON.stringify(value)}\n`);
	const call = (method: string, params: JsonObject = {}) => {
		nextId += 1;
		const id = nextId;
		send({ jsonrpc: "2.0", id, method, params });
		return id;
	};
	const answer = (id: number) =>
		next((m) => m.id === id && m.method === undefined);
	const rpc = (method: string, params: JsonObject = {}) =>
		answer(call(method, params));
	const elicitation = () => next((m) => m.method === "elicitation/create");
	const reply = (request: Message, result: JsonObject) =>
		send({ jsonrpc: "2.0", id: request.id ?? null, result });
	return {
		saved,
		locatorFor,
		trace: () => trace,
		call,
		answer,
		rpc,
		elicitation,
		reply,
		init: () =>
			rpc("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: { ...capabilities, syntheticPrivateField: PRIVATE },
			}),
		choose: (args: JsonObject = {}) =>
			call("tools/call", {
				name: CHOOSE_SECRET_STORE_TOOL,
				arguments: { family: "cd", ...args },
			}),
		async close() {
			input.end();
			await serving;
		},
	};
}

function agentVisible(text: string, stderr: string) {
	for (const secret of [PRIVATE, VAULT_ID, CONNECT_HOST]) {
		expect(text).not.toContain(secret);
		expect(stderr).not.toContain(secret);
	}
}

const stderrSpy = () => {
	const spy = vi.spyOn(process.stderr, "write");
	spy.mockImplementation(() => true);
	return () => JSON.stringify(spy.mock.calls);
};

afterEach(() => vi.restoreAllMocks());

describe("EVAL choose_secret_store: a private owner ceremony", () => {
	it.each([
		["no advertised form", {}],
		["URL elicitation only", { elicitation: { url: {} } }],
	])("refuses with %s, collecting and saving nothing", async (_label, capabilities) => {
		const stderr = stderrSpy();
		const { sessions, establish } = fakeSessions();
		const client = connect(capabilities, { sessions });
		try {
			await client.init();
			const tools = toolsSchema
				.parse((await client.rpc("tools/list")).result)
				.tools.map((tool) => tool.name);
			expect(tools).toContain(CHOOSE_SECRET_STORE_TOOL);
			expect(tools).not.toContain(SUBMIT_STORE_CHOICE_TOOL);
			const choice = toolResult.parse(
				(
					await client.answer(
						client.choose({
							INFISICAL_PROJECT_ID: PRIVATE,
							store: "infisical",
						}),
					)
				).result,
			);
			expect(choice).toMatchObject({
				isError: true,
				structuredContent: {
					status: "secure-form-unavailable",
					reason: "no-private-owner-form",
				},
			});
			const submitted = toolResult.parse(
				(
					await client.rpc("tools/call", {
						name: SUBMIT_STORE_CHOICE_TOOL,
						arguments: { store: "infisical", INFISICAL_PROJECT_ID: PRIVATE },
					})
				).result,
			);
			expect(submitted.structuredContent).toMatchObject({
				status: "secure-form-unavailable",
			});
			expect(JSON.stringify(await client.rpc("resources/list"))).not.toContain(
				STORE_CHOICE_RESOURCE_URI,
			);
			expect(client.saved).toEqual({});
			expect(establish).not.toHaveBeenCalled();
			expect(client.trace()).not.toContain("elicitation/create");
			agentVisible(client.trace(), stderr());
		} finally {
			await client.close();
		}
	});

	it("asks the store alone, then only its own fields, saves them to the owner's locator and establishes the session", async () => {
		const stderr = stderrSpy();
		const { sessions, establish } = fakeSessions();
		const client = connect({ elicitation: { form: {} } }, { sessions });
		try {
			await client.init();
			const pending = client.choose({ cwd: "/synthetic/project" });
			const first = await client.elicitation();
			const picker = elicitSchema.parse(first.params);
			expect(Object.keys(picker.requestedSchema.properties)).toEqual(["store"]);
			expect(picker.requestedSchema.properties.store?.oneOf).toEqual([
				{ const: "infisical", title: "Infisical" },
				{ const: "1password", title: "1Password" },
				{ const: "bitwarden", title: "Bitwarden" },
			]);
			client.reply(first, {
				action: "accept",
				content: { store: "infisical" },
			});
			const second = await client.elicitation();
			const fields = elicitSchema.parse(second.params);
			expect(Object.keys(fields.requestedSchema.properties)).toEqual([
				"INFISICAL_PROJECT_ID",
			]);
			for (const [name, field] of Object.entries(
				fields.requestedSchema.properties,
			)) {
				expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY$/u);
				expect(field.format).not.toBe("password");
			}
			client.reply(second, {
				action: "accept",
				content: { INFISICAL_PROJECT_ID: PRIVATE },
			});
			const done = toolResult.parse((await client.answer(pending)).result);
			expect(done.isError).toBeUndefined();
			expect(done.structuredContent).toEqual({
				status: "established",
				store: "Infisical",
			});
			expect(done.content[0]?.text).toMatch(/chose Infisical/u);
			expect(client.saved).toEqual({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: PRIVATE,
			});
			expect(client.locatorFor).toHaveBeenCalledWith("/synthetic/project");
			expect(establish).toHaveBeenCalledWith("/synthetic/project");

			const reused = toolResult.parse(
				(await client.answer(client.choose({ cwd: "/synthetic/project" })))
					.result,
			);
			expect(reused.structuredContent).toEqual({
				status: "established",
				store: "Infisical",
			});
			expect(establish).toHaveBeenCalledTimes(1);
			agentVisible(client.trace(), stderr());
		} finally {
			await client.close();
		}
	});

	it("signs in to a store already chosen for the project without asking again", async () => {
		const stderr = stderrSpy();
		const { sessions, establish } = fakeSessions({
			status: "sign-in-needed",
			store: "1Password",
			code: "HOBO_OWNER_SIGN_IN",
		});
		const client = connect(
			{ elicitation: {} },
			{
				saved: { HOBO_SECRET_STORE: "1password", OP_VAULT_ID: VAULT_ID },
				sessions,
			},
		);
		try {
			await client.init();
			const done = toolResult.parse(
				(await client.answer(client.choose())).result,
			);
			expect(done).toMatchObject({
				isError: true,
				structuredContent: {
					status: "sign-in-needed",
					store: "1Password",
					code: "HOBO_OWNER_SIGN_IN",
				},
			});
			expect(establish).toHaveBeenCalledTimes(1);
			expect(client.trace()).not.toContain("elicitation/create");
			agentVisible(client.trace(), stderr());
		} finally {
			await client.close();
		}
	});

	it("asks again on reselect and keeps the 1Password fields out of every result", async () => {
		const stderr = stderrSpy();
		const { sessions } = fakeSessions({
			status: "established",
			store: "1Password",
		});
		const client = connect(
			{ elicitation: {} },
			{ saved: { HOBO_SECRET_STORE: "bitwarden" }, sessions },
		);
		try {
			await client.init();
			const pending = client.choose({ reselect: true });
			client.reply(await client.elicitation(), {
				action: "accept",
				content: { store: "1password" },
			});
			const second = await client.elicitation();
			expect(
				Object.keys(
					elicitSchema.parse(second.params).requestedSchema.properties,
				),
			).toEqual(["OP_VAULT_ID", "OP_CONNECT_HOST"]);
			client.reply(second, {
				action: "accept",
				content: { OP_VAULT_ID: VAULT_ID, OP_CONNECT_HOST: CONNECT_HOST },
			});
			const done = toolResult.parse((await client.answer(pending)).result);
			expect(done.structuredContent).toEqual({
				status: "established",
				store: "1Password",
			});
			expect(client.saved).toEqual({
				HOBO_SECRET_STORE: "1password",
				OP_VAULT_ID: VAULT_ID,
				OP_CONNECT_HOST: CONNECT_HOST,
			});
			agentVisible(client.trace(), stderr());
		} finally {
			await client.close();
		}
	});

	it("records nothing when the owner declines or answers outside the rules", async () => {
		const stderr = stderrSpy();
		const { sessions, establish } = fakeSessions();
		const client = connect({ elicitation: {} }, { sessions });
		try {
			await client.init();
			const declined = client.choose();
			client.reply(await client.elicitation(), { action: "decline" });
			expect(
				toolResult.parse((await client.answer(declined)).result)
					.structuredContent,
			).toEqual({ status: "decline" });

			const invalid = client.choose();
			client.reply(await client.elicitation(), {
				action: "accept",
				content: { store: "1password" },
			});
			client.reply(await client.elicitation(), {
				action: "accept",
				content: { OP_VAULT_ID: PRIVATE },
			});
			const refused = toolResult.parse((await client.answer(invalid)).result);
			expect(refused).toMatchObject({
				isError: true,
				structuredContent: { status: "invalid" },
			});
			expect(client.saved).toEqual({});
			expect(establish).not.toHaveBeenCalled();
			agentVisible(client.trace(), stderr());
		} finally {
			await client.close();
		}
	});

	it("says nothing about the owner's settings when they cannot be saved", async () => {
		const stderr = stderrSpy();
		const { sessions } = fakeSessions();
		const client = connect({ elicitation: {} }, { sessions, failWrites: true });
		try {
			await client.init();
			const pending = client.choose();
			client.reply(await client.elicitation(), {
				action: "accept",
				content: { store: "infisical" },
			});
			client.reply(await client.elicitation(), {
				action: "accept",
				content: { INFISICAL_PROJECT_ID: PRIVATE },
			});
			const done = toolResult.parse((await client.answer(pending)).result);
			expect(done).toMatchObject({
				isError: true,
				structuredContent: { status: "unavailable" },
			});
			agentVisible(client.trace(), stderr());
		} finally {
			await client.close();
		}
	});

	it("shows HoBo's widget where the host renders MCP Apps, and records only what the widget submits after the ceremony opened", async () => {
		const stderr = stderrSpy();
		const { sessions, establish } = fakeSessions();
		const client = connect(APPS, { sessions });
		try {
			await client.init();
			const tools = toolsSchema.parse(
				(await client.rpc("tools/list")).result,
			).tools;
			const submit = tools.find(
				(tool) => tool.name === SUBMIT_STORE_CHOICE_TOOL,
			);
			expect(submit?._meta).toMatchObject({ ui: { visibility: ["app"] } });
			expect(
				tools.find((tool) => tool.name === CHOOSE_SECRET_STORE_TOOL)?._meta,
			).toMatchObject({ ui: { resourceUri: STORE_CHOICE_RESOURCE_URI } });

			const early = toolResult.parse(
				(
					await client.rpc("tools/call", {
						name: SUBMIT_STORE_CHOICE_TOOL,
						arguments: { store: "infisical", INFISICAL_PROJECT_ID: PRIVATE },
					})
				).result,
			);
			expect(early.structuredContent).toMatchObject({
				status: "secure-form-unavailable",
			});
			expect(client.saved).toEqual({});

			const shown = toolResult.parse(
				(await client.answer(client.choose())).result,
			);
			expect(shown.structuredContent).toEqual({ status: "shown" });
			expect(shown._meta).toEqual({
				"ui/resourceUri": STORE_CHOICE_RESOURCE_URI,
			});
			const page = z
				.object({ contents: z.array(z.object({ text: z.string() })) })
				.parse(
					(
						await client.rpc("resources/read", {
							uri: STORE_CHOICE_RESOURCE_URI,
						})
					).result,
				);
			expect(page.contents[0]?.text).toContain(SUBMIT_STORE_CHOICE_TOOL);

			const recorded = toolResult.parse(
				(
					await client.rpc("tools/call", {
						name: SUBMIT_STORE_CHOICE_TOOL,
						arguments: { store: "infisical", INFISICAL_PROJECT_ID: PRIVATE },
					})
				).result,
			);
			expect(recorded.structuredContent).toEqual({
				status: "established",
				store: "Infisical",
			});
			expect(client.saved).toEqual({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: PRIVATE,
			});
			expect(establish).toHaveBeenCalledTimes(1);

			const replayed = toolResult.parse(
				(
					await client.rpc("tools/call", {
						name: SUBMIT_STORE_CHOICE_TOOL,
						arguments: { store: "bitwarden" },
					})
				).result,
			);
			expect(replayed.structuredContent).toMatchObject({
				status: "secure-form-unavailable",
			});
			expect(client.saved.HOBO_SECRET_STORE).toBe("infisical");
			agentVisible(client.trace(), stderr());
		} finally {
			await client.close();
		}
	});
});
