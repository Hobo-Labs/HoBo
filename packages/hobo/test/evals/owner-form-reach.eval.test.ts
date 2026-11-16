import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createHoboMcpServer } from "@hobo/mcp";
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
const linkParams = z.object({
	mode: z.literal("url"),
	url: z.string(),
	message: z.string(),
	elicitationId: z.string(),
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
function host(capabilities: JsonObject, options: { remote: boolean }) {
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
		/** The owner answers the host's link prompt (URL-mode elicitation). */
		async openLink(action = "accept") {
			const request = await next((m) => m.method === "elicitation/create");
			send({ jsonrpc: "2.0", id: request.id ?? null, result: { action } });
			return linkParams.parse(request.params);
		},
		/** The next elicitation the host was asked for, of either kind. */
		peek: () => next((m) => m.method === "elicitation/create"),
		async close() {
			toServer.end();
			await serving;
		},
	};
}

/** Words that send the owner to a form or page. */
const SENDS_TO_A_FORM =
	/\b(open|use|type|paste|enter)\b[^.]{0,60}\b(form|page|preview|pane)\b/iu;

describe("owner handoff links", () => {
	it("keeps concurrent ceremonies' links with their own captures", async () => {
		const owner = createMcpOwnerChannel();
		const handoff = async (name: string, url: string) => {
			await owner.openUrl(url, `Open ${name}`, name);
			await owner.captureSecret({ name, title: name, instructions: "" });
		};
		await Promise.all([
			handoff("infisical", "https://example.com/infisical"),
			handoff("github", "https://example.com/github"),
		]);
		expect(owner.linkFor("infisical")?.url).toBe(
			"https://example.com/infisical",
		);
		expect(owner.linkFor("github")?.url).toBe("https://example.com/github");
		owner.deposit("infisical", "session");
		expect(
			await owner.captureSecret({
				name: "infisical",
				title: "",
				instructions: "",
			}),
		).toBe("session");
		expect(owner.linkFor("infisical")).toBeUndefined();
		expect(owner.linkFor("github")?.url).toBe("https://example.com/github");
	});
});

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

	it("the form is minimal: the link alone on its own line, a short title, nothing said twice", async () => {
		// Derived from the owner's screenshot: the link was not clickable and
		// was buried in a paragraph that repeated itself; label and description
		// said the same thing twice. The link stands alone on its own line.
		const link = "https://app.infisical.com/login?callback_port=31222";
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		await client.owner.openUrl(
			link,
			"Sign in to Infisical.",
			INFISICAL_CLI_SESSION,
		);
		await client.owner.captureSecret({
			name: INFISICAL_CLI_SESSION,
			title: "Infisical session",
			instructions: "",
		});
		const mine = client.capture();
		const form = await client.fill({ value: COPIED });
		const field = form.requestedSchema.properties.value;
		const lines = form.message.split("\n").filter((line) => line !== "");
		expect(lines).toContain(link);
		const prose = lines.filter((line) => line !== link);
		for (const line of prose) {
			expect(line).not.toMatch(/https?:\/\//u);
			expect(line.length).toBeLessThanOrEqual(100);
		}
		const sentences = prose.join(" ").split(/(?<=\.)\s+/u);
		expect(new Set(sentences).size).toBe(sentences.length);
		expect((field?.title ?? "").length).toBeLessThanOrEqual(30);
		expect(field?.title ?? "").not.toMatch(/\(|“/u);
		await client.answer(mine);
		await client.close();
	});

	it("the host cancels the call while the form is open: the form is withdrawn, nothing captured, and the next call opens a fresh one", async () => {
		// No timers anywhere: the host's cancel is the event. Derived from the
		// live run, where the host gave up on the call and the form went stale.
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		const first = client.capture();
		const form = await client.next((m) => m.method === "elicitation/create");
		client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: first, reason: "user stopped waiting" },
		});
		// The server tells the host to close the form it asked for.
		const withdrawn = await client.next(
			(m) => m.method === "notifications/cancelled",
		);
		expect(withdrawn.params).toMatchObject({ requestId: form.id });
		const result = toolResult.parse((await client.answer(first)).result);
		expect(result.structuredContent).toMatchObject({
			code: "SECRET_CAPTURE_NOT_ANSWERED",
		});
		expect(client.owner.holds(INFISICAL_CLI_SESSION)).toBe(false);
		const second = client.capture();
		await client.fill({ value: COPIED });
		const done = toolResult.parse((await client.answer(second)).result);
		expect(done.structuredContent).toMatchObject({ status: "stored" });
		await client.close();
	});

	it("a value the run has taken is asked for afresh: a second capture opens a new form", async () => {
		// Found by the ceremony explorer: the session expired after the
		// hand-over, the run asked for a new sign-in, and capture_secret
		// answered with the old, already-used ticket ("stored"); the owner
		// could never hand over the new session.
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		const first = client.capture();
		await client.fill({ value: COPIED });
		await client.answer(first);
		// The run takes it.
		expect(
			await client.owner.captureSecret({
				name: INFISICAL_CLI_SESSION,
				title: "",
				instructions: "",
			}),
		).toBe(COPIED);
		// Asked again: a fresh form, and the new value reaches the run.
		const second = client.capture();
		const again = Buffer.from(
			JSON.stringify({ JTWToken: "h.e30.t", email: "owner@example.com" }),
		).toString("base64");
		await client.fill({ value: again });
		const done = toolResult.parse((await client.answer(second)).result);
		expect(done.structuredContent).toMatchObject({ status: "stored" });
		expect(client.owner.holds(INFISICAL_CLI_SESSION)).toBe(true);
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

describe("EVAL owner form reach: the link reaches the owner in the form itself", () => {
	// Derived from the live runs: first the paste form opened with no link
	// (nothing to paste); then the link went as a URL-mode prompt, which the
	// owner's app never showed, and the agent relayed it in chat. The host
	// shows forms, so the link goes in the form: one form, the link on its
	// own line, the paste field under it. No link prompt is ever sent.
	const SIGN_IN_URL = "https://app.infisical.com/login?callback_port=56037";
	const BOTH = { elicitation: { form: {}, url: {} } };
	async function pendingSignIn(client: ReturnType<typeof host>) {
		await client.owner.openUrl(
			SIGN_IN_URL,
			"Sign in to Infisical.",
			INFISICAL_CLI_SESSION,
		);
		await client.owner.captureSecret({
			name: INFISICAL_CLI_SESSION,
			title: "Infisical session",
			instructions: "",
		});
	}

	it("one form: the sign-in link on its own line, then the paste field", async () => {
		const client = host(BOTH, { remote: true });
		await client.init();
		await pendingSignIn(client);
		const mine = client.capture();
		const form = await client.fill({ value: COPIED });
		expect(form.message.split("\n")).toContain(SIGN_IN_URL);
		const result = toolResult.parse((await client.answer(mine)).result);
		expect(result.structuredContent).toMatchObject({
			status: "stored",
			linkShownBy: "form",
		});
		await client.close();
	});

	it("no URL-mode link prompt is ever sent, even to a host that declares URL mode", async () => {
		const client = host(BOTH, { remote: true });
		await client.init();
		await pendingSignIn(client);
		const mine = client.capture();
		await client.fill({ value: COPIED });
		await client.answer(mine);
		expect(client.seen.some((line) => line.includes('"mode":"url"'))).toBe(
			false,
		);
		await client.close();
	});

	it("a host without URL mode gets the same one form, with no detour through chat", async () => {
		const client = host({ elicitation: {} }, { remote: true });
		await client.init();
		await pendingSignIn(client);
		const mine = client.capture();
		const form = await client.fill({ value: COPIED });
		expect(form.message).toContain(SIGN_IN_URL);
		const done = toolResult.parse((await client.answer(mine)).result);
		expect(done.structuredContent).toMatchObject({ status: "stored" });
		expect(JSON.stringify(done)).not.toContain("SECRET_CAPTURE_LINK_FIRST");
		await client.close();
	});

	it("the owner declines the form: nothing captured, and it says so", async () => {
		const client = host(BOTH, { remote: true });
		await client.init();
		await pendingSignIn(client);
		const mine = client.capture();
		await client.fill(undefined, "decline");
		const result = toolResult.parse((await client.answer(mine)).result);
		expect(result.structuredContent).toMatchObject({
			code: "SECRET_CAPTURE_DECLINED",
		});
		await client.close();
	});

	it("a value with no link to open (a setting) gets the form at once", async () => {
		const client = host(BOTH, { remote: true });
		await client.init();
		const mine = client.capture();
		const first = elicitParams.safeParse((await client.peek()).params);
		expect(first.success).toBe(true);
		await client.close();
		void mine;
	});
});
