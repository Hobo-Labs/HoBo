import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createHoboMcpServer, SECRET_CAPTURE_FORM_TIMEOUT_MS } from "@hobo/mcp";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createComposedHoboCli } from "../../src/cli.js";
import type { JsonObject } from "../../src/json.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
	INFISICAL_CLI_SESSION,
	OWNER_HANDOFF_SPECS,
} from "../../src/mcp-owner-channel.js";
import { createInfisicalCaptureConnector } from "../../src/mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	serveMcpStdio,
} from "../../src/mcp-stdio.js";

// EVAL: the owner of a remote dev box actually sees a form for every value
// a run waits on. Derived from this conversation's failures:
//
// - The capture went to a "port preview" the owner's app never showed, and
//   the agent told the owner to open a form that did not exist.
// - The host showed the model only structuredContent, so what the agent had
//   to do never reached it.
// - Earlier: a page on the box's 127.0.0.1, which a remote owner can never
//   open; and questions asked in prose instead of a form.
//
// Each host profile is a real MCP client on the other end of the stdio
// transport. A capture passes only if the value went from a form the HOST
// renders (an MCP App, or the host's own elicitation form) to the waiting
// run, and never through the tool result, chat, or the model.

const message = z.record(z.string(), z.json());
type Message = z.infer<typeof message>;

const elicitParams = z.object({
	mode: z.literal("form").optional(),
	message: z.string(),
	requestedSchema: z.object({
		type: z.literal("object"),
		properties: z.record(
			z.string(),
			z.object({
				type: z.literal("string"),
				title: z.string().optional(),
				description: z.string().optional(),
			}),
		),
		required: z.array(z.string()),
	}),
});
const toolResult = z.object({
	content: z.array(z.object({ text: z.string() })),
	structuredContent: message.optional(),
	isError: z.boolean().optional(),
});

/** What Infisical's "Copy to clipboard" copies (synthetic). */
const COPIED = Buffer.from(
	JSON.stringify({ JTWToken: "h.e30.s", email: "owner@example.com" }),
).toString("base64");

/** A host on the other end of the stdio transport, with a capability profile. */
function host(
	capabilities: JsonObject,
	options: { remote: boolean; elicitTimeoutMs?: number },
) {
	const toServer = new PassThrough();
	const fromServer = new PassThrough();
	const owner = createMcpOwnerChannel();
	const session = createMcpStdioSession(
		createOwnerCaptureApp({
			owner,
			connector: createInfisicalCaptureConnector({
				projectDir: mkdtempSync(path.join(tmpdir(), "hobo-owner-form-")),
			}),
			remote: options.remote,
			...(options.elicitTimeoutMs !== undefined
				? { elicitTimeoutMs: options.elicitTimeoutMs }
				: undefined),
			elicit: (params) => {
				const request = session.request;
				if (request === undefined) throw new Error("no transport");
				return request("elicitation/create", params);
			},
		}),
	);
	const serving = serveMcpStdio({
		server: createHoboMcpServer({ cli: createComposedHoboCli() }),
		auth: localOperatorAuth({}),
		input: toServer,
		output: fromServer,
		session,
	});
	const seen: string[] = [];
	const inbox: Message[] = [];
	const waiters: (() => void)[] = [];
	let buffer = "";
	fromServer.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl);
			seen.push(line);
			inbox.push(message.parse(JSON.parse(line)));
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
		send({ jsonrpc: "2.0", id, method, params });
		return id;
	};
	const answer = (mine: number) =>
		next((m) => m.id === mine && m.method === undefined);
	return {
		owner,
		seen,
		next,
		send,
		call,
		answer,
		init: () =>
			answer(
				call("initialize", { protocolVersion: "2025-06-18", capabilities }),
			),
		capture: () =>
			call("tools/call", {
				name: "capture_secret",
				arguments: { name: INFISICAL_CLI_SESSION },
			}),
		/** The owner answers the host's form. */
		async fill(content: JsonObject | undefined, action = "accept") {
			const request = await next((m) => m.method === "elicitation/create");
			send({
				jsonrpc: "2.0",
				id: request.id ?? null,
				result: content === undefined ? { action } : { action, content },
			});
			return elicitParams.parse(request.params);
		},
		async close() {
			toServer.end();
			await serving;
		},
	};
}

/** Words that send the owner to a form or page. */
const SENDS_TO_A_FORM =
	/\b(open|use|type|paste|enter)\b[^.]{0,60}\b(form|page|preview|pane)\b/iu;

describe("EVAL owner form reach: the owner sees a form the host renders", () => {
	it("remote, host with form elicitation and no MCP Apps: the host's own form takes the value to the run", async () => {
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		const mine = client.capture();
		const form = await client.fill({ value: COPIED });
		// One field, for this value only; nothing pre-filled.
		expect(Object.keys(form.requestedSchema.properties)).toEqual(["value"]);
		expect(form.message).toMatch(/Infisical/u);
		const result = toolResult.parse((await client.answer(mine)).result);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({
			status: "stored",
			hostSupport: { apps: false, formElicitation: true },
			ref: `handoff://${INFISICAL_CLI_SESSION}`,
		});
		// The run has it; nothing the server sent the host carries it.
		expect(
			await client.owner.captureSecret({
				name: INFISICAL_CLI_SESSION,
				title: "",
				instructions: "",
			}),
		).toBe(COPIED);
		expect(client.seen.join("\n")).not.toContain(COPIED);
		await client.close();
	});

	it("the form is minimal: a short title, one short line, no link or repeated prose", async () => {
		// Derived from the owner's screenshot: the link was not clickable and
		// was buried in a paragraph that repeated itself; label and description
		// said the same thing twice. The link belongs in chat, before the form.
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		await client.owner.openUrl(
			"https://app.infisical.com/login?callback_port=31222",
			"Sign in to Infisical.",
		);
		const mine = client.capture();
		const form = await client.fill({ value: COPIED });
		const field = form.requestedSchema.properties.value;
		expect(form.message.length).toBeLessThanOrEqual(100);
		expect(form.message).not.toMatch(/https?:\/\//u);
		const sentences = form.message.split(/(?<=\.)\s+/u);
		expect(new Set(sentences).size).toBe(sentences.length);
		expect((field?.title ?? "").length).toBeLessThanOrEqual(30);
		expect(field?.title ?? "").not.toMatch(/\(|“/u);
		await client.answer(mine);
		await client.close();
	});

	it("the owner does not answer before the host's limit: the server answers first, captures nothing, and the next call opens a fresh form", async () => {
		// Derived from the live run: the host gives up on a question after 60s;
		// the form opened before the owner had signed in and copied the value.
		const client = host(
			{ elicitation: {} },
			{ remote: true, elicitTimeoutMs: 50 },
		);
		await client.init();
		const first = client.capture();
		await client.next((m) => m.method === "elicitation/create");
		// Nobody answers.
		const result = toolResult.parse((await client.answer(first)).result);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			code: "SECRET_CAPTURE_NOT_ANSWERED",
		});
		expect(JSON.stringify(result)).toMatch(/ready|copied|again/iu);
		expect(client.owner.holds(INFISICAL_CLI_SESSION)).toBe(false);
		// Asked again once the owner is ready: a new form, not the dead one.
		const second = client.capture();
		await client.fill({ value: COPIED });
		const done = toolResult.parse((await client.answer(second)).result);
		expect(done.structuredContent).toMatchObject({ status: "stored" });
		await client.close();
	});

	it("remote: never a box-local page or a port preview the owner may not see", async () => {
		for (const capabilities of [
			{ elicitation: {} },
			{ elicitation: { form: {}, url: {} } },
			{},
		]) {
			const client = host(capabilities, { remote: true });
			await client.init();
			const mine = client.capture();
			if ("elicitation" in capabilities) await client.fill(undefined, "cancel");
			const result = toolResult.parse((await client.answer(mine)).result);
			const text = JSON.stringify(result);
			expect(text).not.toMatch(
				/127\.0\.0\.1|localhost|preview-page|loopback-page/u,
			);
			await client.close();
		}
	});

	it("remote, host with no form at all: refuses honestly, sends the owner to no form, and says what the host lacks", async () => {
		const client = host({}, { remote: true });
		await client.init();
		const result = toolResult.parse(
			(await client.answer(client.capture())).result,
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			code: "SECRET_CAPTURE_NO_OWNER_FORM",
			hostSupport: { apps: false, formElicitation: false },
		});
		const text = result.content.map((c) => c.text).join("\n");
		expect(text).not.toMatch(SENDS_TO_A_FORM);
		await client.close();
	});

	it("the owner declines the form: nothing reaches the run, and the result says it did not complete", async () => {
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		const mine = client.capture();
		await client.fill(undefined, "decline");
		const result = toolResult.parse((await client.answer(mine)).result);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			code: "SECRET_CAPTURE_DECLINED",
		});
		expect(client.owner.holds(INFISICAL_CLI_SESSION)).toBe(false);
		await client.close();
	});

	it("a value of the wrong shape: the form is shown again with the reason, never with the value", async () => {
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		const mine = client.capture();
		await client.fill({ value: "not the copied session!" });
		const again = await client.fill({ value: COPIED });
		expect(again.message).toMatch(/not|again|expected/iu);
		expect(again.message).not.toContain("not the copied session!");
		const result = toolResult.parse((await client.answer(mine)).result);
		expect(result.structuredContent).toMatchObject({ status: "stored" });
		await client.close();
	});

	it("an MCP Apps host still gets HoBo's sealed form", async () => {
		const client = host(
			{
				extensions: {
					"io.modelcontextprotocol/ui": {
						mimeTypes: ["text/html;profile=mcp-app"],
					},
				},
				elicitation: {},
			},
			{ remote: true },
		);
		await client.init();
		const result = toolResult.parse(
			(await client.answer(client.capture())).result,
		);
		expect(result.structuredContent).toMatchObject({ channel: "mcp-app" });
		await client.close();
	});

	it("every capture result says what the host can show, so the agent never guesses", async () => {
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		const mine = client.capture();
		await client.fill({ value: COPIED });
		const result = toolResult.parse((await client.answer(mine)).result);
		expect(result.structuredContent).toMatchObject({
			hostSupport: { apps: false, formElicitation: true },
		});
		await client.close();
	});
});

describe("EVAL owner form reach: every hand-over reads at a glance", () => {
	it("each value's title and line are short and say it once", () => {
		for (const spec of OWNER_HANDOFF_SPECS) {
			expect(spec.label.length, spec.name).toBeLessThanOrEqual(30);
			expect(spec.label, spec.name).not.toMatch(/\(|“/u);
			expect(spec.purpose.length, spec.name).toBeLessThanOrEqual(90);
		}
	});
});

describe("EVAL owner form reach: the owner has ten minutes", () => {
	it("the host's tool limit is ten minutes, and the server answers just before it", () => {
		// Derived from the live run: the host cut the question off at 60s.
		const settings = z
			.object({ env: z.object({ MCP_TOOL_TIMEOUT: z.string() }) })
			.parse(
				JSON.parse(
					readFileSync(
						new URL("../../../../.claude/settings.json", import.meta.url),
						"utf8",
					),
				),
			);
		const hostLimit = Number(settings.env.MCP_TOOL_TIMEOUT);
		expect(hostLimit).toBe(10 * 60_000);
		expect(SECRET_CAPTURE_FORM_TIMEOUT_MS).toBeLessThan(hostLimit);
		expect(SECRET_CAPTURE_FORM_TIMEOUT_MS).toBeGreaterThanOrEqual(
			hostLimit - 30_000,
		);
	});
});
