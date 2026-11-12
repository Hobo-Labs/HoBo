import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	CAPTURE_SECRET_TOOL,
	CapturedSecret,
	createSecretCaptureApp,
	END_SECRET_CAPTURE_TOOL,
	MCP_APP_MIME_TYPE,
	negotiateSecretCaptureSupport,
	SECRET_CAPTURE_RESOURCE_URI,
	SECRET_CAPTURE_STATUS_TOOL,
	type SecretCaptureApp,
	type SecretCaptureOutcome,
	SUBMIT_SECRET_VALUE_TOOL,
	URL_ELICITATION_REQUIRED,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import {
	http,
	leakWatch,
	memoryConnector,
	SPECS,
	sealAsTheFormDoes,
	synthetic,
	syntheticPem,
	WRITER_SECRET,
} from "./secret-capture-support.js";

const APPS = { apps: true, urlElicitation: false };
const URL_ONLY = { apps: false, urlElicitation: true };
const NEITHER = { apps: false, urlElicitation: false };

const apps: SecretCaptureApp[] = [];
const watches: ReturnType<typeof leakWatch>[] = [];

afterEach(async () => {
	while (apps.length > 0) await apps.pop()?.close();
	while (watches.length > 0) watches.pop()?.restore();
});

function setup(
	options: Parameters<typeof memoryConnector>[0] & {
		clock?: { at: number };
	} = {},
) {
	const store = memoryConnector(options);
	const notifications: { method: string; params: JsonValue }[] = [];
	const clock = options.clock ?? { at: Date.parse("2026-11-12T10:00:00Z") };
	const app = createSecretCaptureApp({
		specs: SPECS,
		connector: store.connector,
		now: () => clock.at,
		notify: (method, params) => notifications.push({ method, params }),
	});
	apps.push(app);
	const watch = leakWatch();
	watches.push(watch);
	return { app, store, notifications, clock, watch };
}

function result(outcome: SecretCaptureOutcome) {
	if (outcome.kind !== "result") throw new Error("expected a tool result");
	return outcome.result;
}

type TicketView = {
	ticketId: string;
	name: string;
	state: string;
	channel: string;
	ref?: string;
	url?: string;
	key: { kty: "EC"; crv: "P-256"; x: string; y: string };
};

function ticketOf(outcome: SecretCaptureOutcome): TicketView {
	// The view is JSON: a round trip reads it as the recorded shape.
	return JSON.parse(JSON.stringify(result(outcome).structuredContent));
}

describe("host negotiation (MCP Apps 2026-01-26, MCP 2025-11-25 elicitation)", () => {
	it("finds MCP Apps only under extensions with the mcp-app MIME type", () => {
		expect(
			negotiateSecretCaptureSupport({
				extensions: {
					"io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME_TYPE] },
				},
			}),
		).toEqual({ apps: true, urlElicitation: false });
		expect(
			negotiateSecretCaptureSupport({
				extensions: {
					"io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
				},
			}).apps,
		).toBe(false);
		expect(negotiateSecretCaptureSupport({ elicitation: {} })).toEqual(NEITHER);
		expect(
			negotiateSecretCaptureSupport({ elicitation: { form: {}, url: {} } }),
		).toEqual(URL_ONLY);
		expect(negotiateSecretCaptureSupport(null)).toEqual(NEITHER);
		expect(negotiateSecretCaptureSupport("apps")).toEqual(NEITHER);
	});
});

describe("the tool and resource surface", () => {
	it("gives an MCP Apps host the form, and hides the submit tool from the model by visibility", () => {
		const { app } = setup();
		const tools = app.tools(APPS);
		const capture = tools.find((tool) => tool.name === CAPTURE_SECRET_TOOL);
		expect(capture?._meta).toEqual({
			ui: { resourceUri: SECRET_CAPTURE_RESOURCE_URI },
			"ui/resourceUri": SECRET_CAPTURE_RESOURCE_URI,
		});
		const submit = tools.find((tool) => tool.name === SUBMIT_SECRET_VALUE_TOOL);
		expect(submit?._meta).toEqual({
			ui: { resourceUri: SECRET_CAPTURE_RESOURCE_URI, visibility: ["app"] },
		});
		// The capture tool takes no value: there is no field to put one in.
		expect(JSON.stringify(capture?.inputSchema)).not.toMatch(/"value"/u);
		expect(app.resources(APPS)).toEqual([
			expect.objectContaining({
				uri: SECRET_CAPTURE_RESOURCE_URI,
				mimeType: MCP_APP_MIME_TYPE,
			}),
		]);
	});

	it("never offers the submit tool or the resource to a host without MCP Apps", () => {
		const { app } = setup();
		for (const support of [URL_ONLY, NEITHER]) {
			const names = app.tools(support).map((tool) => tool.name);
			expect(names).toEqual([
				CAPTURE_SECRET_TOOL,
				SECRET_CAPTURE_STATUS_TOOL,
				END_SECRET_CAPTURE_TOOL,
			]);
			expect(app.tools(support)[0]?._meta).toBeUndefined();
			expect(app.resources(support)).toEqual([]);
		}
	});

	it("serves the form as text/html;profile=mcp-app with no network allowance", () => {
		const { app } = setup();
		const read: {
			contents: { mimeType: string; text: string; _meta: JsonValue }[];
		} = JSON.parse(
			JSON.stringify(app.readResource(SECRET_CAPTURE_RESOURCE_URI)),
		);
		const [content] = read.contents;
		expect(content?.mimeType).toBe(MCP_APP_MIME_TYPE);
		expect(content?._meta).toEqual({
			ui: {
				csp: { connectDomains: [], resourceDomains: [] },
				prefersBorder: true,
			},
		});
		// The form never puts anything in front of the model.
		expect(content?.text).not.toMatch(/ui\/message|ui\/update-model-context/u);
		expect(content?.text).toContain('"ui/initialize"');
		expect(app.readResource("ui://hobo/other")).toBeUndefined();
	});
});

describe("the MCP App channel", () => {
	it("captures, seals in the form, stores, and answers only name, stored and ref", async () => {
		const { app, store, watch } = setup();
		const value = synthetic("SYNTHETIC-webhook", 24);
		const opened = watch.outcome(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				APPS,
			),
		);
		const ticket = ticketOf(opened);
		expect(ticket).toMatchObject({
			name: "HOBO_CI_WEBHOOK_SECRET",
			channel: "mcp-app",
			state: "awaiting-owner",
		});
		expect(ticket.url).toBeUndefined();
		expect(ticket.ticketId).toMatch(/^cap_[A-Za-z0-9_-]{22}$/u);

		const sealed = await sealAsTheFormDoes(ticket, value);
		watch.record(sealed);
		const submitted = watch.outcome(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				APPS,
			),
		);
		expect(result(submitted).structuredContent).toEqual({
			ticketId: ticket.ticketId,
			name: "HOBO_CI_WEBHOOK_SECRET",
			stored: true,
			ref: "secref://runtime/HOBO_CI_WEBHOOK_SECRET",
			status: "stored",
		});
		// It reached the store, and only the store.
		const read = await store.runtime.access("HOBO_CI_WEBHOOK_SECRET");
		expect(read.status === "ok" && read.material).toBe(value);

		const status = watch.outcome(
			await app.callTool(
				SECRET_CAPTURE_STATUS_TOOL,
				{ ticketId: ticket.ticketId },
				APPS,
			),
		);
		expect(result(status).structuredContent).toMatchObject({
			state: "stored",
			ref: "secref://runtime/HOBO_CI_WEBHOOK_SECRET",
		});
		watch.record(app.events());
		expect(app.events().map((event) => event.type)).toEqual([
			"secret.CaptureOpened",
			"secret.CaptureStored",
		]);
		expect(watch.assertNever(value)).toBeGreaterThan(0);
	});

	it("accepts a multi-line PEM-shaped value through the same path", async () => {
		const { app, store, watch } = setup();
		const pem = syntheticPem();
		const ticket = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_GITHUB_APP_PRIVATE_KEY" },
				APPS,
			),
		);
		const answer = watch.outcome(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{
					ticketId: ticket.ticketId,
					sealed: await sealAsTheFormDoes(ticket, pem),
				},
				APPS,
			),
		);
		expect(result(answer).isError).toBe(false);
		const read = await store.runtime.access("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
		expect(read.status === "ok" && read.material).toBe(pem);
		watch.record(app.events());
		watch.assertNever(pem.split("\n")[3] ?? pem);
	});

	it("refuses a sealed value replayed into another ticket or tampered with", async () => {
		const { app, watch } = setup();
		const value = synthetic("SYNTHETIC-webhook", 24);
		const first = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				APPS,
			),
		);
		const second = ticketOf(
			await app.callTool(CAPTURE_SECRET_TOOL, { name: "VERCEL_TOKEN" }, APPS),
		);
		const sealed = await sealAsTheFormDoes(first, value);
		const replayed = watch.outcome(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: second.ticketId, sealed },
				APPS,
			),
		);
		expect(result(replayed).structuredContent).toMatchObject({
			code: "SECRET_CAPTURE_SEAL_INVALID",
		});
		// SAFETY: test-side copy of the sealed record the form built.
		const copy = { ...(sealed as Record<string, string>) };
		const bytes = Buffer.from(copy.ciphertext ?? "", "base64url");
		bytes[0] = (bytes[0] ?? 0) ^ 1;
		const tampered = watch.outcome(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{
					ticketId: first.ticketId,
					sealed: { ...copy, ciphertext: bytes.toString("base64url") },
				},
				APPS,
			),
		);
		expect(result(tampered).structuredContent).toMatchObject({
			code: "SECRET_CAPTURE_SEAL_INVALID",
		});
		watch.assertNever(value);
	});
});

describe("size and charset checks", () => {
	const cases: [string, string, string][] = [
		["too short", "x".repeat(31), "shorter"],
		["too long", "x".repeat(1025), "longer"],
		["a NUL byte", `${"x".repeat(40)}\u0000`, "characters"],
		["non-ASCII", `${"x".repeat(40)}é`, "characters"],
		["a bidi override", `${"x".repeat(40)}‮`, "characters"],
		["a newline in a one-line secret", `${"x".repeat(40)}\nabc`, "characters"],
		["a trailing space", `${"x".repeat(40)} `, "space"],
	];
	for (const [label, raw, reason] of cases)
		it(`refuses ${label} with a reason and no part of the value`, async () => {
			const { app, store, watch } = setup();
			const ticket = ticketOf(
				await app.callTool(
					CAPTURE_SECRET_TOOL,
					{ name: "HOBO_CI_WEBHOOK_SECRET" },
					APPS,
				),
			);
			const answer = watch.outcome(
				await app.callTool(
					SUBMIT_SECRET_VALUE_TOOL,
					{
						ticketId: ticket.ticketId,
						sealed: await sealAsTheFormDoes(ticket, raw),
					},
					APPS,
				),
			);
			const refusal = result(answer);
			expect(refusal.isError).toBe(true);
			expect(refusal.structuredContent).toMatchObject({
				code: "SECRET_CAPTURE_INVALID_VALUE",
				name: "HOBO_CI_WEBHOOK_SECRET",
			});
			expect(refusal.content[0]?.text).toContain(reason);
			expect(store.runtime.names()).toEqual([]);
			watch.record(app.events());
			expect(watch.assertNever(raw)).toBeGreaterThan(0);
		});

	it("refuses a value that is not in the secret's format", async () => {
		const { app } = setup();
		const ticket = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_GITHUB_APP_PRIVATE_KEY" },
				APPS,
			),
		);
		const answer = await app.callTool(
			SUBMIT_SECRET_VALUE_TOOL,
			{
				ticketId: ticket.ticketId,
				sealed: await sealAsTheFormDoes(ticket, "x".repeat(200)),
			},
			APPS,
		);
		expect(result(answer).content[0]?.text).toContain("format");
	});

	it("keeps the capture open for a corrected value, then closes it after five refusals", async () => {
		const { app, store } = setup();
		const ticket = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				APPS,
			),
		);
		const submit = async (value: string) =>
			result(
				await app.callTool(
					SUBMIT_SECRET_VALUE_TOOL,
					{
						ticketId: ticket.ticketId,
						sealed: await sealAsTheFormDoes(ticket, value),
					},
					APPS,
				),
			);
		expect((await submit("short")).isError).toBe(true);
		expect((await submit(synthetic("SYNTHETIC-ok", 20))).isError).toBe(false);
		expect(store.runtime.names()).toEqual(["HOBO_CI_WEBHOOK_SECRET"]);

		const other = ticketOf(
			await app.callTool(CAPTURE_SECRET_TOOL, { name: "VERCEL_TOKEN" }, APPS),
		);
		let last: JsonValue = null;
		for (let i = 0; i < 5; i++)
			last = result(
				await app.callTool(
					SUBMIT_SECRET_VALUE_TOOL,
					{
						ticketId: other.ticketId,
						sealed: await sealAsTheFormDoes(other, " "),
					},
					APPS,
				),
			).structuredContent;
		expect(last).toMatchObject({ code: "SECRET_CAPTURE_ATTEMPTS_EXHAUSTED" });
	});
});

describe("refusals before anything is opened", () => {
	it("refuses when no secret store is connected, and names the next step", async () => {
		const { app, watch } = setup({ connected: false });
		const answer = result(
			watch.outcome(
				await app.callTool(
					CAPTURE_SECRET_TOOL,
					{ name: "HOBO_CI_WEBHOOK_SECRET" },
					APPS,
				),
			),
		);
		expect(answer.isError).toBe(true);
		expect(answer.structuredContent).toMatchObject({
			code: "SECRET_STORE_NOT_CONNECTED",
			name: "HOBO_CI_WEBHOOK_SECRET",
		});
		expect(JSON.stringify(answer.structuredContent)).toContain("OIDC Auth");
		expect(app.events().map((event) => event.type)).toEqual([
			"secret.CaptureRefused",
		]);
	});

	it("asks for the writer credential first when writes are not authorized", async () => {
		const { app } = setup({ writable: false });
		expect(
			result(
				await app.callTool(CAPTURE_SECRET_TOOL, { name: "VERCEL_TOKEN" }, APPS),
			).structuredContent,
		).toMatchObject({ code: "SECRET_STORE_WRITER_REQUIRED" });
		expect(
			result(
				await app.callTool(
					CAPTURE_SECRET_TOOL,
					{ name: "INFISICAL_WRITER_CLIENT_SECRET" },
					APPS,
				),
			).structuredContent,
		).toMatchObject({ code: "SECRET_CAPTURE_WRITER_CLIENT_ID_REQUIRED" });
	});

	it("refuses unknown names and the submit tool from a host without MCP Apps", async () => {
		const { app } = setup();
		expect(
			result(
				await app.callTool(CAPTURE_SECRET_TOOL, { name: "AWS_ROOT_KEY" }, APPS),
			).structuredContent,
		).toMatchObject({ code: "SECRET_CAPTURE_UNKNOWN_NAME" });
		expect(
			result(
				await app.callTool(
					SUBMIT_SECRET_VALUE_TOOL,
					{ ticketId: "cap_AAAAAAAAAAAAAAAAAAAAAA", sealed: {} },
					NEITHER,
				),
			).structuredContent,
		).toMatchObject({ code: "MCP_APPS_NOT_NEGOTIATED" });
	});

	it("reports a store failure by its code only", async () => {
		const { app, watch } = setup({ failStore: "forbidden" });
		const value = synthetic("SYNTHETIC-webhook", 24);
		const ticket = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				APPS,
			),
		);
		const answer = result(
			watch.outcome(
				await app.callTool(
					SUBMIT_SECRET_VALUE_TOOL,
					{
						ticketId: ticket.ticketId,
						sealed: await sealAsTheFormDoes(ticket, value),
					},
					APPS,
				),
			),
		);
		expect(answer.structuredContent).toMatchObject({
			code: "SECRET_STORE_WRITE_FAILED",
		});
		expect(answer.content[0]?.text).toContain("(forbidden)");
		watch.assertNever(value);
	});
});

describe("the writer session", () => {
	it("authorizes writes with a one-use credential that is never stored, and ends it", async () => {
		const { app, store, watch } = setup({ writable: false });
		const writer = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{
					name: "INFISICAL_WRITER_CLIENT_SECRET",
					writerClientId: "writer-client",
				},
				APPS,
			),
		);
		const authorized = watch.outcome(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{
					ticketId: writer.ticketId,
					sealed: await sealAsTheFormDoes(writer, WRITER_SECRET),
				},
				APPS,
			),
		);
		expect(result(authorized).structuredContent).toEqual({
			ticketId: writer.ticketId,
			name: "INFISICAL_WRITER_CLIENT_SECRET",
			stored: false,
			ref: "hobo-writer-session://writer-client",
			status: "authorized",
		});
		const token = synthetic("SYNTHETIC-vercel", 16);
		const ticket = ticketOf(
			await app.callTool(CAPTURE_SECRET_TOOL, { name: "VERCEL_TOKEN" }, APPS),
		);
		await app.callTool(
			SUBMIT_SECRET_VALUE_TOOL,
			{
				ticketId: ticket.ticketId,
				sealed: await sealAsTheFormDoes(ticket, token),
			},
			APPS,
		);
		expect(store.deploy.names()).toEqual(["VERCEL_TOKEN"]);
		expect([...store.runtime.names(), ...store.deploy.names()]).not.toContain(
			"INFISICAL_WRITER_CLIENT_SECRET",
		);
		const end = watch.outcome(
			await app.callTool(END_SECRET_CAPTURE_TOOL, {}, APPS),
		);
		expect(result(end).structuredContent).toEqual({
			closedCaptures: 0,
			writerSession: "ended",
		});
		expect(store.ended).toEqual(["ended"]);
		watch.record(app.events());
		watch.assertNever(WRITER_SECRET, token);
	});

	it("reports a refused writer credential without its value", async () => {
		const { app, watch } = setup({ writable: false });
		const wrong = synthetic("SYNTHETIC-wrong-writer", 16);
		const writer = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{
					name: "INFISICAL_WRITER_CLIENT_SECRET",
					writerClientId: "writer-client",
				},
				APPS,
			),
		);
		const answer = result(
			watch.outcome(
				await app.callTool(
					SUBMIT_SECRET_VALUE_TOOL,
					{
						ticketId: writer.ticketId,
						sealed: await sealAsTheFormDoes(writer, wrong),
					},
					APPS,
				),
			),
		);
		expect(answer.structuredContent).toMatchObject({
			code: "SECRET_STORE_WRITER_DENIED",
		});
		expect(answer.content[0]?.text).toContain("login-denied");
		watch.assertNever(wrong);
	});
});

describe("the fallback: URL-mode elicitation to a loopback page", () => {
	it("answers -32042 with the page, takes the value there, and completes the elicitation", async () => {
		const { app, store, notifications, watch } = setup();
		const value = synthetic("SYNTHETIC-webhook", 24);
		const outcome = watch.outcome(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				URL_ONLY,
			),
		);
		if (outcome.kind !== "error") throw new Error("expected -32042");
		expect(outcome.error.code).toBe(URL_ELICITATION_REQUIRED);
		// SAFETY: test-side read of the elicitation the app built.
		const [elicitation] = (
			outcome.error.data as {
				elicitations: { mode: string; url: string; elicitationId: string }[];
			}
		).elicitations;
		expect(elicitation?.mode).toBe("url");
		const url = new URL(elicitation?.url ?? "");
		expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
		expect(url.search).toBe("");

		const page = await http(`${url.origin}${url.pathname}`, {
			headers: { host: url.host },
		});
		expect(page.status).toBe(200);
		expect(page.headers["content-security-policy"]).toMatch(
			/default-src 'none'; script-src 'nonce-[A-Za-z0-9_-]+'/u,
		);
		expect(page.headers["cache-control"]).toBe("no-store");
		expect(page.headers["referrer-policy"]).toBe("no-referrer");
		// The fragment token is never in the page.
		expect(page.body).not.toContain(url.hash.slice(1));

		const ticket = {
			ticketId: elicitation?.elicitationId ?? "",
			name: "HOBO_CI_WEBHOOK_SECRET",
			key:
				// SAFETY: the embedded config is the page's own JSON.
				(
					JSON.parse(
						/<script type="application\/json" id="hobo-capture-config">(.*?)<\/script>/su.exec(
							page.body,
						)?.[1] ?? "{}",
					) as { ticket: { key: TicketView["key"] } }
				).ticket.key,
		};
		const sealed = await sealAsTheFormDoes(ticket, value);
		const posted = await http(`${url.origin}${url.pathname}`, {
			method: "POST",
			headers: {
				host: url.host,
				origin: url.origin,
				"content-type": "application/json",
				"sec-fetch-site": "same-origin",
			},
			body: JSON.stringify({ token: url.hash.slice(1), sealed }),
		});
		watch.record(posted.body);
		expect(posted.status).toBe(200);
		expect(JSON.parse(posted.body)).toMatchObject({
			name: "HOBO_CI_WEBHOOK_SECRET",
			stored: true,
			status: "stored",
		});
		const read = await store.runtime.access("HOBO_CI_WEBHOOK_SECRET");
		expect(read.status === "ok" && read.material).toBe(value);
		expect(notifications).toEqual([
			{
				method: "notifications/elicitation/complete",
				params: { elicitationId: ticket.ticketId },
			},
		]);
		// The client's retry of the original call gets the stored capture.
		const retried = watch.outcome(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				URL_ONLY,
			),
		);
		expect(result(retried).structuredContent).toMatchObject({
			state: "stored",
		});
		// The page is closed now.
		expect(
			(
				await http(`${url.origin}${url.pathname}`, {
					headers: { host: url.host },
				})
			).status,
		).toBe(410);
		watch.record(app.events());
		watch.assertNever(value);
	});

	it("refuses a rebound Host, a foreign Origin and a wrong token", async () => {
		const { app, store } = setup();
		const opened = await app.callTool(
			CAPTURE_SECRET_TOOL,
			{ name: "HOBO_CI_WEBHOOK_SECRET" },
			NEITHER,
		);
		const ticket = ticketOf(opened);
		const url = new URL(ticket.url ?? "");
		const target = `${url.origin}${url.pathname}`;
		expect(
			(
				await http(target, {
					headers: { host: `attacker.example:${url.port}` },
				})
			).status,
		).toBe(421);
		const sealed = await sealAsTheFormDoes(ticket, synthetic("SYNTHETIC", 20));
		const post = (headers: Record<string, string>, token: string) =>
			http(target, {
				method: "POST",
				headers: {
					host: url.host,
					"content-type": "application/json",
					...headers,
				},
				body: JSON.stringify({ token, sealed }),
			});
		expect(
			(await post({ origin: "https://attacker.example" }, url.hash.slice(1)))
				.status,
		).toBe(403);
		expect(
			(
				await post(
					{ origin: url.origin, "sec-fetch-site": "cross-site" },
					url.hash.slice(1),
				)
			).status,
		).toBe(403);
		expect((await post({ origin: url.origin }, "A".repeat(43))).status).toBe(
			404,
		);
		expect(store.runtime.names()).toEqual([]);
		// The right page still works afterwards.
		expect((await post({ origin: url.origin }, url.hash.slice(1))).status).toBe(
			200,
		);
	});
});

describe("the fallback: a host with neither", () => {
	it("names the loopback page and tells the agent the owner opens it", async () => {
		const { app } = setup();
		const answer = result(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "VERCEL_TOKEN" },
				NEITHER,
			),
		);
		const ticket: TicketView = JSON.parse(
			JSON.stringify(answer.structuredContent),
		);
		expect(ticket.channel).toBe("loopback-page");
		expect(ticket.url).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/capture\/cap_[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/u,
		);
		const text = answer.content[0]?.text ?? "";
		expect(text).toContain("Ask the owner to open");
		expect(text).toContain("Do not open, fetch or submit that page yourself");
		expect(text).toContain("never ask for the value in the chat");
	});

	it("can force the page for an MCP Apps host whose window cannot encrypt", async () => {
		const { app } = setup();
		const ticket = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "VERCEL_TOKEN", channel: "loopback-page" },
				APPS,
			),
		);
		expect(ticket.channel).toBe("loopback-page");
	});
});

describe("expiry and closing", () => {
	it("expires an open capture and refuses a late submission", async () => {
		const clock = { at: Date.parse("2026-11-12T10:00:00Z") };
		const { app } = setup({ clock });
		const ticket = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				APPS,
			),
		);
		const sealed = await sealAsTheFormDoes(ticket, synthetic("SYNTHETIC", 24));
		clock.at += 10 * 60_000;
		expect(
			result(
				await app.callTool(
					SUBMIT_SECRET_VALUE_TOOL,
					{ ticketId: ticket.ticketId, sealed },
					APPS,
				),
			).structuredContent,
		).toMatchObject({ code: "SECRET_CAPTURE_UNKNOWN_TICKET" });
		expect(app.events().map((event) => event.type)).toContain(
			"secret.CaptureExpired",
		);
	});

	it("closes every open capture and stops the page", async () => {
		const { app } = setup();
		const ticket = ticketOf(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "VERCEL_TOKEN" },
				NEITHER,
			),
		);
		const end = result(
			await app.callTool(END_SECRET_CAPTURE_TOOL, {}, NEITHER),
		);
		expect(end.structuredContent).toMatchObject({ closedCaptures: 1 });
		await expect(http(ticket.url ?? "")).rejects.toThrow();
	});
});

describe("CapturedSecret redaction", () => {
	it("prints as [redacted secret] everywhere a value could slip out", () => {
		const [spec] = SPECS;
		if (!spec) throw new Error("no spec");
		const value = synthetic("SYNTHETIC-webhook", 24);
		const secret = CapturedSecret.parse(spec, value);
		expect(String(secret)).toBe("[redacted secret]");
		expect(`${secret}`).toBe("[redacted secret]");
		expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted secret]"}');
		expect(inspect(secret)).toBe("[redacted secret]");
		expect(inspect({ nested: [secret] }, { depth: 5 })).not.toContain(value);
		expect(secret.reveal()).toBe(value);
	});

	it("has a leak watch that does catch a leak (raw, base64, or a log line)", () => {
		const value = synthetic("SYNTHETIC-webhook", 24);
		for (const leak of [
			(watch: ReturnType<typeof leakWatch>) => watch.record({ text: value }),
			(watch: ReturnType<typeof leakWatch>) =>
				watch.record(Buffer.from(value).toString("base64")),
			() => console.error("oops", value),
		]) {
			const watch = leakWatch();
			try {
				leak(watch);
				expect(() => watch.assertNever(value)).toThrow(
					"a captured value reached an output",
				);
			} finally {
				watch.restore();
			}
		}
	});
});
