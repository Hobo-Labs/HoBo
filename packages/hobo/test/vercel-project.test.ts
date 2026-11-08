import { inspect } from "node:util";

import type { IacProgram } from "@hobo/cloud";
import { at, first } from "@hobo/core/total-access";
import { REDACTION_WINDOW } from "@hobo/provider-vercel";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type JsonObject, parseJsonObject } from "../src/json.js";
import {
	createVercelClient,
	VercelApiError,
	type VercelFetch,
	type VercelFetchResponse,
	VercelTransportError,
} from "../src/vercel-client.js";
import {
	createVercelDeployProvider,
	type VercelDeployProviderOptions,
} from "../src/vercel-deploy-provider.js";

// The Vercel deploy path deploys first. Create Deployment names its project, and
// on an account with no project by that name Vercel refuses it:
//   404 {"error":{"code":"not_found","message":"Project not found"}}
// Only then does the provider create the project (POST /v9/projects {name}; a 409
// means someone made it meanwhile) and deploy once more. A deploy to an existing
// project is one request, with no project call, and needs no project-read scope.
// NO network: every request goes to a scripted transport.

type SentInit = Parameters<VercelFetch>[1];

interface Sent {
	readonly url: string;
	readonly init: SentInit;
}

function reply(status: number, body: JsonObject): VercelFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return JSON.stringify(body);
		},
		async json() {
			return body;
		},
	};
}

// An answer whose body is not JSON, as a proxy in front of the API can give.
function plainReply(status: number, text: string): VercelFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return text;
		},
		async json() {
			throw new SyntaxError(`not JSON: ${text}`);
		},
	};
}

const PROJECT_NOT_FOUND = reply(404, {
	error: { code: "not_found", message: "Project not found" },
});
const CONFLICT = reply(409, {
	error: {
		code: "conflict",
		message: "A project with the same name already exists.",
	},
});
const CREATED = reply(200, { id: "prj_new", name: "hobo-hello-bindle" });
const DEPLOYED = reply(200, {
	id: "dpl_1",
	url: "hobo-hello-bindle-1.vercel.app",
});

/**
 * A transport that answers each `METHOD /path` from a queue of scripted
 * answers, in order. It fails the test on a request nobody scripted, and on a
 * request that carries an empty body.
 */
function scripted(
	script: Readonly<Record<string, readonly VercelFetchResponse[]>>,
) {
	const sent: Sent[] = [];
	const left = new Map(
		Object.entries(script).map(([route, answers]) => [route, [...answers]]),
	);
	const fetch: VercelFetch = async (url, init) => {
		sent.push({ url, init });
		const route = `${init.method} ${new URL(url).pathname}`;
		if (init.body === "") throw new Error(`empty body: ${route}`);
		const next = left.get(route)?.shift();
		if (next === undefined) throw new Error(`unscripted request: ${route}`);
		return next;
	};
	const routes = () =>
		sent.map(({ url, init }) => `${init.method} ${new URL(url).pathname}`);
	return { fetch, sent, routes };
}

// The committed-fixture helper as these tests drive it: `fixtureArtifact: true`
// (without it, `apply` refuses before any request).
function fixtureProvider(
	options: Omit<VercelDeployProviderOptions, "fixtureArtifact">,
) {
	return createVercelDeployProvider({ fixtureArtifact: true, ...options });
}

function programFor(deploymentId: string): IacProgram {
	return {
		programId: `prog-${deploymentId}`,
		deploymentId,
		resourceId: "service",
		provider: "vercel",
		driver: "vercel",
		action: "apply",
		stackName: `stack-${deploymentId}`,
	};
}

const DEPLOY = "POST /v13/deployments";
const CREATE = "POST /v9/projects";

describe("createVercelDeployProvider deploys first (scripted transport, no network)", () => {
	it("deploys to an existing project in one request, with no project call", async () => {
		const { fetch, sent, routes } = scripted({ [DEPLOY]: [DEPLOYED] });
		const provider = fixtureProvider({ token: "tok", fetch });

		const outputs = await provider.apply(programFor("dep-1"));

		expect(routes()).toEqual([DEPLOY]);
		expect(outputs.url).toBe("https://hobo-hello-bindle-1.vercel.app");
		expect(outputs).toMatchObject({
			projectCreated: "false",
			scope: "token-default",
		});
		const deploy = parseJsonObject(first(sent).init.body ?? "");
		expect(deploy.project).toBe("hobo-hello-bindle");
	});

	// A 404 body nested thousands deep, as a proxy or a hostile peer could
	// answer: too deep to walk recursively, or to write back out with
	// `JSON.stringify` (plain node gives up near 3000 levels, a test worker
	// further on). It is still Vercel's not_found, so the project is made.
	it.each([
		5000, 100_000,
	])("on a missing project whose 404 body nests %i deep: create, deploy again", async (depth) => {
		const deep = `${"[".repeat(depth)}"tok"${"]".repeat(depth)}`;
		const body = `{"error":{"code":"not_found","message":"Project not found"},"trace":${deep}}`;
		const { fetch, routes } = scripted({
			[DEPLOY]: [plainReply(404, body), DEPLOYED],
			[CREATE]: [CREATED],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const outputs = await provider.apply(programFor("dep-1"));

		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
		expect(outputs).toMatchObject({ projectCreated: "true" });
	});

	it("on a missing project: deploy 404, create the project, deploy again", async () => {
		const { fetch, sent, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[CREATE]: [CREATED],
		});
		const provider = fixtureProvider({
			token: "tok",
			fetch,
			teamId: "team_7",
		});

		const outputs = await provider.apply(programFor("dep-1"));

		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
		expect(outputs.url).toBe("https://hobo-hello-bindle-1.vercel.app");
		expect(outputs.deploymentId).toBe("dpl_1");
		expect(outputs).toMatchObject({ projectCreated: "true", scope: "team_7" });
		for (const { url } of sent) {
			expect(new URL(url).search).toBe("?teamId=team_7");
		}
		expect(at(sent, 1).init).toEqual({
			method: "POST",
			headers: {
				Authorization: "Bearer tok",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "hobo-hello-bindle" }),
		});
		// The second deployment is the first one sent again.
		expect(at(sent, 2).init).toEqual(at(sent, 0).init);
	});

	it("deploys again when the create is answered 409 (made meanwhile)", async () => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[CREATE]: [CONFLICT],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const outputs = await provider.apply(programFor("dep-1"));

		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
		expect(outputs.url).toBe("https://hobo-hello-bindle-1.vercel.app");
		expect(outputs).toMatchObject({
			projectCreated: "false",
			scope: "token-default",
		});
	});

	it.each([
		["blank", "", "", "token-default"],
		["spaces only", "   ", "", "token-default"],
		["padded", " team_x ", "?teamId=team_x", "team_x"],
	])("takes a %s teamId the way selectIacProvider does: trimmed, and blank as none", async (_case, teamId, query, scope) => {
		const { fetch, sent } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[CREATE]: [CREATED],
		});
		const provider = fixtureProvider({
			token: "tok",
			fetch,
			teamId,
		});

		const outputs = await provider.apply(programFor("dep-1"));

		expect(sent.map(({ url }) => new URL(url).search)).toEqual([
			query,
			query,
			query,
		]);
		expect(outputs.scope).toBe(scope);
	});

	// The project lives in team_acme, but the provider was given no teamId, so
	// Vercel looks for it in the token's own scope, answers "Project not found",
	// and the create makes a second project of that name there. That does not
	// fail; the outputs say it happened, and where.
	it("with no teamId, creates the project in the token's default scope and says so", async () => {
		const { fetch, sent, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[CREATE]: [CREATED],
		});
		const provider = fixtureProvider({
			token: "tok",
			fetch,
			projectName: "acme-site",
		});

		const outputs = await provider.apply(programFor("dep-1"));

		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
		for (const { url } of sent) expect(new URL(url).search).toBe("");
		expect(outputs).toMatchObject({
			projectCreated: "true",
			scope: "token-default",
		});
	});

	it("retries a Project not found in any letter case", async () => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [
				reply(404, {
					error: { code: "not_found", message: "project not found" },
				}),
				DEPLOYED,
			],
			[CREATE]: [CREATED],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const outputs = await provider.apply(programFor("dep-1"));

		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
		expect(outputs.deploymentId).toBe("dpl_1");
	});

	it.each([
		[
			"a 404 with another code",
			reply(404, {
				error: {
					code: "deployment_not_found",
					message: "Deployment not found",
				},
			}),
			404,
			"deployment_not_found",
		],
		[
			"a 404 for something other than the project",
			reply(404, { error: { code: "not_found", message: "Team not found" } }),
			404,
			"not_found",
		],
		[
			"a 404 that says Project not found under another code",
			reply(404, {
				error: { code: "forbidden", message: "Project not found" },
			}),
			404,
			"forbidden",
		],
		[
			"a status other than 404 that says not_found, Project not found",
			reply(400, {
				error: { code: "not_found", message: "Project not found" },
			}),
			400,
			"not_found",
		],
		[
			"a 404 whose body is not JSON",
			plainReply(404, "Not Found"),
			404,
			undefined,
		],
	])("does not retry %s", async (_case, refusal, status, code) => {
		const { fetch, routes } = scripted({ [DEPLOY]: [refusal] });
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		await expect(pending).rejects.toMatchObject({ status, code });
		expect(routes()).toEqual([DEPLOY]);
	});

	it("propagates a second 404 after the create, and deploys no more", async () => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, PROJECT_NOT_FOUND],
			[CREATE]: [CREATED],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		await expect(pending).rejects.toMatchObject({
			status: 404,
			code: "not_found",
			apiMessage: "Project not found",
			message: expect.stringMatching(/HTTP 404.*not_found/u),
		});
		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
	});

	it.each([
		[400, "bad_request", "Invalid request: `files` should be array."],
		[403, "forbidden", "Not authorized"],
		[409, "conflict", "The deployment is already in progress."],
		[429, "rate_limited", "Rate limit exceeded"],
		[500, "internal_server_error", "An unexpected error happened."],
	])("propagates a deploy answered %i as a VercelApiError with its status, code and message", async (status, code, message) => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [reply(status, { error: { code, message } })],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		await expect(pending).rejects.toMatchObject({
			name: "VercelApiError",
			status,
			code,
			apiMessage: message,
			message: expect.stringContaining(
				`create deployment failed (HTTP ${status})`,
			),
		});
		expect(routes()).toEqual([DEPLOY]);
	});

	it("propagates a create answered 409 with another code, and deploys no more", async () => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND],
			[CREATE]: [
				reply(409, {
					error: {
						code: "project_transfer_in_progress",
						message: "The project is being transferred.",
					},
				}),
			],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		await expect(pending).rejects.toMatchObject({
			status: 409,
			code: "project_transfer_in_progress",
		});
		expect(routes()).toEqual([DEPLOY, CREATE]);
	});

	it("names the 409's reason when the deployment after a 409 conflict is refused", async () => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, PROJECT_NOT_FOUND],
			[CREATE]: [CONFLICT],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		await expect(pending).rejects.toMatchObject({
			status: 404,
			code: "not_found",
			apiMessage: "Project not found",
			message: expect.stringMatching(
				/^vercel-client: create deployment failed \(HTTP 404\): .*not_found.* \(after create project was answered HTTP 409 conflict: A project with the same name already exists\.\)$/u,
			),
		});
		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
	});

	// The note the refusal of the second deployment carries after a 409 conflict.
	const CONFLICT_NOTE =
		"(after create project was answered HTTP 409 conflict: A project with the same name already exists.)";

	// A 500 whose refusal message, before any note, is `length` characters.
	function refusalOfLength(length: number): VercelFetchResponse {
		const head =
			'vercel-client: create deployment failed (HTTP 500): {"error":{"code":"internal_server_error","message":"';
		const tail = '"}}';
		return reply(500, {
			error: {
				code: "internal_server_error",
				message: "x".repeat(length - head.length - tail.length),
			},
		});
	}

	it("keeps the whole 409 note after a long deployment refusal, cutting the refusal instead", async () => {
		const plain = scripted({ [DEPLOY]: [refusalOfLength(490)] });
		const alone = await fixtureProvider({
			token: "tok",
			fetch: plain.fetch,
		})
			.apply(programFor("dep-1"))
			.catch((error: Error) => error.message);
		expect(alone).toHaveLength(490);

		const { fetch } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, refusalOfLength(490)],
			[CREATE]: [CONFLICT],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		const message = await pending.then(
			() => "",
			(error: Error) => error.message,
		);
		expect(message.endsWith(`… ${CONFLICT_NOTE}`)).toBe(true);
		expect(message.length).toBeLessThanOrEqual(501);
		expect(message).toMatch(
			/^vercel-client: create deployment failed \(HTTP 500\): /u,
		);
		await expect(pending).rejects.toMatchObject({
			status: 500,
			code: "internal_server_error",
		});
	});

	it("cuts a long 409 reason at 200 characters, so the deployment refusal survives", async () => {
		const { fetch } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, PROJECT_NOT_FOUND],
			[CREATE]: [
				reply(409, { error: { code: "conflict", message: "y".repeat(2000) } }),
			],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		const message = await pending.catch((error: Error) => error.message);
		expect(message).toBe(
			`vercel-client: create deployment failed (HTTP 404): {"error":{"code":"not_found","message":"Project not found"}} (after create project was answered HTTP 409 conflict: ${"y".repeat(200)}…)`,
		);
		expect(message.length).toBeLessThanOrEqual(501);
		await expect(pending).rejects.toMatchObject({
			status: 404,
			code: "not_found",
			apiMessage: "Project not found",
		});
	});

	it("propagates a refused create as a VercelApiError, and deploys no more", async () => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND],
			[CREATE]: [
				reply(403, { error: { code: "forbidden", message: "Not authorized" } }),
			],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const pending = provider.apply(programFor("dep-1"));

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		await expect(pending).rejects.toMatchObject({
			status: 403,
			code: "forbidden",
			apiMessage: "Not authorized",
			message: expect.stringContaining("create project failed (HTTP 403)"),
		});
		expect(routes()).toEqual([DEPLOY, CREATE]);
	});

	it("deploys a later deployment in one request once the project exists", async () => {
		const { fetch, routes } = scripted({
			[DEPLOY]: [
				PROJECT_NOT_FOUND,
				DEPLOYED,
				reply(200, { id: "dpl_2", url: "two.vercel.app" }),
			],
			[CREATE]: [CREATED],
		});
		const provider = fixtureProvider({ token: "tok", fetch });

		const earlier = await provider.apply(programFor("dep-1"));
		const again = await provider.apply(programFor("dep-1"));
		const later = await provider.apply(programFor("dep-2"));

		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY, DEPLOY]);
		expect(again).toEqual(earlier);
		expect(earlier.projectCreated).toBe("true");
		expect(later.url).toBe("https://two.vercel.app");
		expect(later.projectCreated).toBe("false");
	});

	it("preview still makes no request", async () => {
		const { fetch, sent } = scripted({});
		const provider = fixtureProvider({ token: "tok", fetch });
		await provider.preview(programFor("dep-1"));
		expect(sent).toEqual([]);
	});
});

describe("a refusal's text (scripted transport, no network)", () => {
	const TOKEN = "tok_SECRET_0123456789abcdef";
	const OTHER_KEY = "sk_live_0123456789abcdef";

	async function refusedBy(
		answer: (init: SentInit) => VercelFetchResponse,
		token = TOKEN,
	): Promise<VercelApiError> {
		const fetch: VercelFetch = async (_url, init) => answer(init);
		const provider = fixtureProvider({ token, fetch });
		try {
			await provider.apply(programFor("dep-1"));
		} catch (error) {
			if (error instanceof VercelApiError) return error;
			throw error;
		}
		throw new Error("expected the deploy to be refused");
	}

	it("carries neither the token nor credential-shaped text, however it is printed", async () => {
		// A body that echoes the request: the Authorization header, the bare
		// token, and another credential in the message.
		const error = await refusedBy((init) =>
			reply(404, {
				error: {
					code: "not_found",
					message: `No such route; you sent ${String(init.headers.Authorization)}, token ${TOKEN} and api_key=${OTHER_KEY}`,
				},
				echo: { headers: init.headers, token: TOKEN },
			}),
		);

		const printed = [
			String(error),
			JSON.stringify(error),
			inspect(error, { depth: 10, showHidden: true }),
			error.stack ?? "",
			error.message,
			error.apiMessage ?? "",
		];
		for (const text of printed) {
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain(OTHER_KEY);
		}
		expect(error.message).toMatch(/create deployment failed \(HTTP 404\)/u);
		expect(error.message).toContain("[redacted]");
		expect(error.apiMessage).toBe(
			"No such route; you sent [redacted] token [redacted] and [redacted]",
		);
		expect(error).toMatchObject({ status: 404, code: "not_found" });
	});

	// The token as a body can carry it in another form: JSON's \u escape,
	// URL-encoded (whole, or byte by byte), and inside base64 (alone, a Basic
	// header's `:token`, or `Bearer token`).
	const base64 = (text: string) => Buffer.from(text).toString("base64");
	const escaped = TOKEN.replace("S", "\\u0053");
	const percent = [...Buffer.from(TOKEN)]
		.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
		.join("");
	// A token encodeURIComponent changes; Vercel's are letters and digits.
	const ODD_TOKEN = "tok+SECRET/0123456789=abcdef";

	it.each([
		["JSON-escaped", TOKEN, `you sent ${escaped}`, [escaped]],
		["percent-encoded byte by byte", TOKEN, `you sent ${percent}`, [percent]],
		[
			"encodeURIComponent'd",
			ODD_TOKEN,
			`you sent ${encodeURIComponent(ODD_TOKEN)}`,
			[encodeURIComponent(ODD_TOKEN)],
		],
		["base64", TOKEN, `you sent ${base64(TOKEN)}`, [base64(TOKEN)]],
		[
			"base64 of a Basic header's :token",
			TOKEN,
			`you sent Basic ${base64(`:${TOKEN}`)}`,
			[base64(`:${TOKEN}`)],
		],
		[
			"base64 of Bearer token",
			TOKEN,
			`you sent ${base64(`Bearer ${TOKEN}`)}`,
			[base64(`Bearer ${TOKEN}`)],
		],
	])("carries no token sent back %s", async (_case, token, sent, forms) => {
		const body = `{"error":{"code":"not_found","message":"${sent}"}}`;
		const error = await refusedBy(() => plainReply(404, body), token);

		expectNoToken(error, token, forms);
	});

	// The same token broken up by whitespace between two of its characters, in a
	// JSON body (escaped there, so a real newline once parsed) and in a body
	// that is not JSON.
	const split = (text: string, by: string, at = 10) =>
		`${text.slice(0, at)}${by}${text.slice(at)}`;

	it.each([
		["a newline", TOKEN, split(TOKEN, "\n"), []],
		["\\r\\n", TOKEN, split(TOKEN, "\r\n"), []],
		["several spaces", TOKEN, split(TOKEN, "     "), []],
		["spaces between every character", TOKEN, [...TOKEN].join(" "), []],
		[
			"a newline in its base64",
			TOKEN,
			split(base64(TOKEN), "\n", 16),
			[base64(TOKEN)],
		],
		[
			"a newline in its percent-encoding",
			TOKEN,
			split(percent, "\n", 20),
			[percent],
		],
	])("carries no token broken up by %s", async (_case, token, sent, forms) => {
		const json = JSON.stringify({
			error: { code: "not_found", message: `you sent ${sent}` },
		});
		const inJson = await refusedBy(() => plainReply(404, json), token);
		const raw = await refusedBy(
			() => plainReply(404, `you sent ${sent} back`),
			token,
		);

		expectNoToken(inJson, token, forms);
		expectNoToken(raw, token, forms);
		expect(inJson.apiMessage).toBe("you sent [redacted]");
	});

	// The token broken up by a control or format character: invisible, or
	// turned into a space on the way into the message, and so the token again.
	const REPRO = "Zm9vYmFyQmF6UXV4MTIzNDU2";
	it.each([
		["NUL", "\u0000"],
		["ESC", "\u001b"],
		["DEL", "\u007f"],
		["NEL (U+0085)", "\u0085"],
		["a soft hyphen (U+00AD)", "\u00ad"],
		["U+180E", "\u180e"],
		["a zero-width space (U+200B)", "\u200b"],
		["a zero-width non-joiner (U+200C)", "\u200c"],
		["a zero-width joiner (U+200D)", "\u200d"],
		["a word joiner (U+2060)", "\u2060"],
		// Default-ignorable code points that are neither control nor format
		// characters: a renderer draws them as nothing at all.
		["a variation selector (U+FE0F)", "\ufe0f"],
		["a combining grapheme joiner (U+034F)", "\u034f"],
		["a Hangul filler (U+3164)", "\u3164"],
		["a Hangul choseong filler (U+115F)", "\u115f"],
		["a Khmer inherent vowel (U+17B4)", "\u17b4"],
		["a Mongolian free variation selector (U+180B)", "\u180b"],
		["a variation selector supplement (U+E0100)", "\u{e0100}"],
	])("carries no token broken up by %s", async (_case, char) => {
		const sent = split(REPRO, char);
		const json = JSON.stringify({
			error: { code: "not_found", message: `sent ${sent} back` },
		});
		const raw = await refusedBy(
			() => plainReply(404, `sent ${sent} back`),
			REPRO,
		);
		const inJson = await refusedBy(() => plainReply(404, json), REPRO);

		expectNoToken(raw, REPRO, []);
		expectNoToken(inJson, REPRO, []);
		expect(raw.message).toBe(
			"vercel-client: create deployment failed (HTTP 404): sent [redacted] back",
		);
		expect(inJson.apiMessage).toBe("sent [redacted] back");
	});

	it("stays linear on a long hostile body: 1 MB of breaks and near-misses", async () => {
		// Every character of the token but the last, each followed by a run of
		// whitespace, control and format characters, over and over: each try
		// runs nearly to the end and fails.
		const nearMiss = Array.from(TOKEN.slice(0, -1)).join(
			" \r\n\t\u0000\u001b\u200b\u00ad ",
		);
		let hostile = "";
		while (hostile.length < 1_000_000)
			hostile += `${nearMiss}${" \u200b".repeat(32)}\n`;
		const json = JSON.stringify({
			error: { code: "not_found", message: hostile },
		});

		const started = performance.now();
		const raw = await refusedBy(() => plainReply(404, hostile));
		const inJson = await refusedBy(() => plainReply(404, json));
		const took = performance.now() - started;

		expect(hostile.length).toBeGreaterThanOrEqual(1_000_000);
		expect(raw.message.length).toBeLessThanOrEqual(501);
		expect(inJson.apiMessage?.length).toBeLessThanOrEqual(501);
		expect(took).toBeLessThan(1000);
	});

	it.each([
		5000, 100_000,
	])("carries no token in a body nested %i deep", async (depth) => {
		const deep = `${"[".repeat(depth)}"${TOKEN}"${"]".repeat(depth)}`;
		const body = `{"echo":"you sent ${TOKEN}","error":{"code":"forbidden","message":"Not authorized: ${TOKEN}"},"trace":${deep}}`;
		const error = await refusedBy(() => plainReply(403, body));

		expectNoToken(error, TOKEN, []);
		expect(error).toMatchObject({
			status: 403,
			code: "forbidden",
			apiMessage: "Not authorized: [redacted]",
		});
		expect(error.message).toMatch(
			/^vercel-client: create deployment failed \(HTTP 403\): \{"echo":"you sent \[redacted\]","error"/u,
		);
	});

	it("keeps a __proto__ key in the body as a key, its token taken out", async () => {
		const body = `{"__proto__":{"echo":"you sent ${TOKEN}"},"error":{"code":"forbidden","message":"Not authorized"}}`;
		const error = await refusedBy(() => plainReply(403, body));

		expect(error.message).toBe(
			'vercel-client: create deployment failed (HTTP 403): {"__proto__":{"echo":"you sent [redacted]"},"error":{"code":"forbidden","message":"Not authorized"}}',
		);
	});

	// Credential shapes are searched for in the first REDACTION_WINDOW
	// characters only, each in linear time, so a hostile body cannot stall the
	// deploy's error path.
	const MB = 1_000_000;
	it.each([
		["-ey, over and over", "-ey"],
		["BEGIN markers, over and over", "-----BEGIN PRIVATE KEY-----"],
		[
			"a mix of both, bearer and key shapes, and whitespace",
			"-ey-ey eyAAAAAAAAAAAA.eyBBBBBBBBBBBB -----BEGIN PRIVATE KEY-----\n Bearer api_key= sk- \t",
		],
	])("stays linear on a 1 MB body of %s", async (_case, unit) => {
		const hostile = unit.repeat(Math.ceil(MB / unit.length));
		const json = JSON.stringify({
			error: { code: "not_found", message: hostile },
		});

		const started = performance.now();
		const raw = await refusedBy(() => plainReply(404, hostile));
		const inJson = await refusedBy(() => plainReply(404, json));
		const took = performance.now() - started;

		expect(raw.message.length).toBeLessThanOrEqual(501);
		expect(inJson.apiMessage?.length).toBeLessThanOrEqual(501);
		expect(took).toBeLessThan(1000);
	});

	// A body redaction shrinks to almost nothing, so the window's end reaches
	// the message: what the window cuts through leaves nothing behind.
	const shrinking = (length: number) =>
		`Bearer ${"A".repeat(400)} `.repeat(Math.floor(length / 408));
	const keyBody = Array.from(
		{ length: 40 },
		(_, i) => `MIIK${String(i).padStart(4, "0")}${"q".repeat(56)}`,
	).join("\n");

	it.each([
		[
			"a private key",
			`${shrinking(REDACTION_WINDOW - 200)}-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----`,
			["MIIK", "qqqq"],
		],
		[
			"a JWT",
			`${shrinking(REDACTION_WINDOW - 200)}token eyJ${"h".repeat(40)}.eyJ${"p".repeat(4000)}.sigsigsig`,
			["eyJ", "hhhh", "pppp"],
		],
	])("leaves nothing of %s the window cuts through", async (_case, body, parts) => {
		const raw = await refusedBy(() => plainReply(404, body));
		const inJson = await refusedBy(() =>
			plainReply(
				404,
				JSON.stringify({ error: { code: "not_found", message: body } }),
			),
		);

		for (const text of [raw.message, inJson.message, inJson.apiMessage ?? ""]) {
			for (const part of parts) expect(text).not.toContain(part);
			expect(text.endsWith("…")).toBe(true);
		}
	});

	// A JSON refusal body of many small values: each string and key is
	// searched, so the walk must not pay a full search for every one of them.
	it.each([
		[
			"175k nested objects",
			() => `${'{"a":'.repeat(175_000)}1${"}".repeat(175_000)}`,
		],
		[
			"91k keys",
			() =>
				`{${Array.from({ length: 91_000 }, (_, i) => `"k${String(i).padStart(5, "0")}":1`).join(",")}}`,
		],
		[
			"35k strings",
			() =>
				`[${Array.from({ length: 35_000 }, (_, i) => `"${String(i).padStart(26, "x")}"`).join(",")}]`,
		],
		// Each longer than the token, so each is searched.
		[
			"30k strings longer than the token",
			() =>
				`[${Array.from({ length: 30_400 }, (_, i) => `"${String(i).padStart(30, "x")}"`).join(",")}]`,
		],
	])("stays fast on a 1 MB JSON body of %s", async (_case, make) => {
		const body = make();
		const started = performance.now();
		const error = await refusedBy(() => plainReply(404, body));
		const took = performance.now() - started;

		expect(body.length).toBeGreaterThanOrEqual(1_000_000);
		expect(error.message.length).toBeLessThanOrEqual(501);
		expect(took).toBeLessThan(1000);
	});

	it("still redacts the token among many short strings, as a value and a key", async () => {
		const values = Array.from({ length: 1000 }, (_, i) => `"v${i}"`);
		const body = `{"error":{"code":"not_found","message":"x"},"echo":[${values.join(",")},"${TOKEN}"],"${TOKEN}":1}`;
		const error = await refusedBy(() => plainReply(404, body));

		expectNoToken(error, TOKEN, []);
	});

	// A token the credential shapes complete: its text ends in `[redacted]`,
	// the marker `redactProviderText` writes, so a body holding the token's
	// start followed by `Bearer …` holds no token until the shapes have run. The
	// second search, after them, is what finds it.
	it.each([
		["after a hyphen, the `[` case", "tok-[redacted]", "tok-Bearer abc"],
		["after a backslash", "tok\\[redacted]", "tok\\Bearer abc"],
	])("carries no token the shapes complete, %s", async (_case, token, sent) => {
		const raw = await refusedBy(
			() => plainReply(404, `you sent ${sent} back`),
			token,
		);
		const inJson = await refusedBy(
			() =>
				reply(404, {
					error: { code: "not_found", message: `you sent ${sent} back` },
				}),
			token,
		);

		expect(raw.message).not.toContain(token);
		expect(raw.message).toBe(
			"vercel-client: create deployment failed (HTTP 404): you sent [redacted] back",
		);
		expect(inJson.apiMessage).not.toContain(token);
		expect(inJson.apiMessage).toBe("you sent [redacted] back");
	});

	it("carries no token sent back JSON-escaped as the code", async () => {
		const body = `{"error":{"code":"${escaped}","message":"x"}}`;
		const error = await refusedBy(() => plainReply(404, body));

		expect(error.code).toBeUndefined();
		expectNoToken(error, TOKEN, [escaped]);
	});

	// Nowhere the error is printed or kept (the executor persists
	// `executor.apply_failed: <message>` as exec.Failed.reason) holds the token,
	// a form of it, or base64 that decodes to text holding it.
	function expectNoToken(
		error: VercelApiError,
		token: string,
		forms: readonly string[],
	): void {
		expect(error).toBeInstanceOf(VercelApiError);
		const printed = [
			error.message,
			error.apiMessage ?? "",
			error.code ?? "",
			error.stack ?? "",
			String(error),
			inspect(error, { depth: 10, showHidden: true }),
			JSON.stringify(error),
			`executor.apply_failed: ${error.message}`,
		];
		for (const text of printed) {
			// What a body can encode the token's characters in, decoded, and
			// the breaks taken out: the token written any of those ways is
			// still the token.
			const plain = decoded(text);
			for (const form of [token, ...forms]) {
				expect(text).not.toContain(form);
				expect(plain).not.toContain(form);
			}
			// Nor anything base64, or base64 of base64, decodes to.
			for (const inner of base64Inside(text)) {
				expect(decoded(inner)).not.toContain(token.slice(2, -2));
			}
		}
	}

	// `text` with JSON's `\uXXXX` escapes (after any number of backslashes),
	// percent-encoding (once or twice) and HTML numeric references decoded,
	// then its whitespace, control and format characters, and JSON's escapes
	// for them, taken out.
	function decoded(text: string): string {
		const code = (digits: string, radix: number, match: string) => {
			const point = Number.parseInt(digits, radix);
			return point <= 0x10ffff ? String.fromCodePoint(point) : match;
		};
		return text
			.replace(/\\+u([0-9a-fA-F]{4})/gu, (match, hex: string) =>
				code(hex, 16, match),
			)
			.replace(/%(?:25)?([0-9a-fA-F]{2})/gu, (match, hex: string) =>
				code(hex, 16, match),
			)
			.replace(/&#[xX]0*([0-9a-fA-F]{1,6});?/gu, (match, hex: string) =>
				code(hex, 16, match),
			)
			.replace(/&#0*([0-9]{1,7});?/gu, (match, dec: string) =>
				code(dec, 10, match),
			)
			.replace(
				/\\+[nrt/]|[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu,
				"",
			);
	}

	// What the base64 runs in `text` decode to, and the base64 runs in those.
	function base64Inside(text: string, depth = 2): string[] {
		if (depth === 0) return [];
		return (text.match(/[A-Za-z0-9+/]{16,}={0,2}/gu) ?? []).flatMap((run) => {
			const inner = Buffer.from(run, "base64").toString("latin1");
			return [inner, ...base64Inside(inner, depth - 1)];
		});
	}

	// The token's characters written as a body can carry them.
	const hex = (char: string, width: number) =>
		(char.codePointAt(0) ?? 0).toString(16).padStart(width, "0");
	const jsonEscaped = (char: string, upper = false) =>
		`\\u${upper ? hex(char, 4).toUpperCase() : hex(char, 4)}`;
	const percentOf = (text: string, twice = false) =>
		[...Buffer.from(text)]
			.map((byte) => `%${twice ? "25" : ""}${byte.toString(16).toUpperCase()}`)
			.join("");
	const eachChar = (
		text: string,
		write: (char: string, at: number) => string,
	) => Array.from(text, write).join("");
	const fullPercent = percentOf(TOKEN);

	it.each([
		[
			"JSON-escaped, every third character, in a JSON fragment in text",
			`upstream said {"session":"${eachChar(TOKEN, (char, at) => (at % 3 === 0 ? jsonEscaped(char, at % 2 === 0) : char))}"} and gave up`,
			[],
		],
		[
			"with one character JSON-escaped",
			`you sent ${TOKEN.slice(0, -1)}${jsonEscaped(TOKEN.slice(-1))}`,
			[],
		],
		[
			"JSON-escaped twice, as JSON inside a JSON string",
			`{\\"auth\\":\\"${eachChar(TOKEN, (char) => `\\${jsonEscaped(char)}`)}\\"}`,
			[],
		],
		[
			"percent-encoded in part, either case",
			eachChar(TOKEN, (char, at) =>
				at % 2 === 0
					? char
					: at % 4 === 1
						? percentOf(char)
						: percentOf(char).toLowerCase(),
			),
			[],
		],
		["percent-encoded twice (%25XX)", percentOf(TOKEN, true), []],
		[
			"as HTML references, hex and decimal, leading zeros, either case",
			eachChar(
				TOKEN,
				(char, at) =>
					[
						char,
						`&#x${hex(char, 1)};`,
						`&#${char.charCodeAt(0)};`,
						`&#X00${hex(char, 1).toUpperCase()};`,
						`&#000${char.charCodeAt(0)}`,
					][at % 5] ?? char,
			),
			[],
		],
		["as base64 of its base64", base64(base64(TOKEN)), [base64(base64(TOKEN))]],
		[
			"as base64 of its percent-encoding",
			base64(fullPercent),
			[base64(fullPercent)],
		],
	])("carries no token written %s", async (_case, sent, forms) => {
		const raw = await refusedBy(() => plainReply(404, `you sent ${sent} back`));
		const inJson = await refusedBy(() =>
			plainReply(
				404,
				JSON.stringify({
					error: { code: "not_found", message: `you sent ${sent} back` },
				}),
			),
		);

		expectNoToken(raw, TOKEN, forms);
		expectNoToken(inJson, TOKEN, forms);
		expect(inJson.apiMessage).toMatch(/^you sent .*\[redacted\].* back$/u);
	});

	it.each([
		[
			"near-misses in every encoding",
			eachChar(
				TOKEN.slice(0, -1),
				(char, at) =>
					[
						char,
						`\\\\${jsonEscaped(char)}`,
						percentOf(char, true),
						`&#x000${hex(char, 1)}`,
						`&#00${char.charCodeAt(0)} `,
					][at % 5] ?? char,
			),
		],
		["runs of backslashes", `${"\\".repeat(4096)}u00`],
		["runs of %25", `${"%25".repeat(2048)}%2`],
		[
			"runs of zeros in references",
			`&#x${"0 ".repeat(2048)}&#${"0".repeat(2048)}`,
		],
	])("stays linear on 1 MB of %s", async (_case, unit) => {
		const hostile = unit.repeat(Math.ceil(1_000_000 / unit.length));
		const json = JSON.stringify({
			error: { code: "not_found", message: hostile },
		});

		const started = performance.now();
		const raw = await refusedBy(() => plainReply(404, hostile));
		const inJson = await refusedBy(() => plainReply(404, json));
		const took = performance.now() - started;

		expect(raw.message.length).toBeLessThanOrEqual(501);
		expect(inJson.apiMessage?.length).toBeLessThanOrEqual(501);
		expect(took).toBeLessThan(1000);
	});

	it.each([
		["valid", "}"],
		["cut off", ""],
	])("carries no token in a JSON-escaped key, the JSON %s", async (_case, end) => {
		const key = eachChar(TOKEN, (char, at) =>
			at % 2 === 0 ? jsonEscaped(char) : char,
		);
		const body = `{"${key}":true,"error":{"code":"not_found","message":"Not found"}${end}`;
		const error = await refusedBy(() => plainReply(404, body));

		expectNoToken(error, TOKEN, [key]);
		expect(error.message).toContain('{"[redacted]":true');
	});

	it("carries no token JSON-escaped in JSON a raw newline makes invalid", async () => {
		const escapedToken = eachChar(TOKEN, (char) => jsonEscaped(char));
		const body = `{"error":{"code":"not_found","message":"you sent ${escapedToken}\n back"}}`;
		const error = await refusedBy(() => plainReply(404, body));

		expectNoToken(error, TOKEN, [escapedToken]);
		expect(error.apiMessage).toBeUndefined();
		expect(error.message).toContain("you sent [redacted]  back");
	});

	it("is cut at 500 characters, message and apiMessage each", async () => {
		const error = await refusedBy(() =>
			reply(500, {
				error: { code: "internal_server_error", message: "x".repeat(5000) },
			}),
		);

		expect(error.message).toHaveLength(501);
		expect(error.message.endsWith("…")).toBe(true);
		expect(error.message).toMatch(
			/^vercel-client: create deployment failed \(HTTP 500\)/u,
		);
		expect(error.apiMessage).toBe(`${"x".repeat(500)}…`);
	});

	it("keeps a short refusal whole", async () => {
		const error = await refusedBy(() =>
			reply(403, { error: { code: "forbidden", message: "Not authorized" } }),
		);

		expect(error.message).toBe(
			'vercel-client: create deployment failed (HTTP 403): {"error":{"code":"forbidden","message":"Not authorized"}}',
		);
		expect(error.apiMessage).toBe("Not authorized");
	});

	it.each([
		["bears the token", `Bearer ${TOKEN}`],
		["is the token itself", TOKEN],
		["is credential-shaped", OTHER_KEY],
		["is 5000 characters", "x".repeat(5000)],
		["is empty", ""],
	])("drops a code that %s", async (_case, code) => {
		const error = await refusedBy(() =>
			reply(404, { error: { code, message: "Not found" } }),
		);

		expect(error.code).toBeUndefined();
		expect(error).toMatchObject({ status: 404, apiMessage: "Not found" });
		const printed = `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 10, showHidden: true })}`;
		expect(printed).not.toContain(TOKEN);
		expect(printed).not.toContain(OTHER_KEY);
		expect(printed).not.toContain("x".repeat(501));
	});

	it.each([
		"not_found",
		"forbidden",
		"internal_server_error",
		"deployment.not-found",
		"A".repeat(64),
	])("keeps the short identifier %s as the code", async (code) => {
		const error = await refusedBy(() =>
			reply(404, { error: { code, message: "Not found" } }),
		);

		expect(error.code).toBe(code);
	});

	it("drops a 65-character code", async () => {
		const error = await refusedBy(() =>
			reply(404, { error: { code: "A".repeat(65), message: "Not found" } }),
		);

		expect(error.code).toBeUndefined();
	});
});

describe("a transport failure (scripted transport, no network)", () => {
	const TOKEN = "tok_SECRET_0123456789abcdef";
	const OTHER_KEY = "sk_live_0123456789abcdef";
	const base64 = (text: string) => Buffer.from(text).toString("base64");

	// The deploy's error when the transport throws `thrown` (or answers 2xx
	// with a body `json()` cannot read, when `answered` is set).
	async function failedBy(fetch: VercelFetch): Promise<VercelTransportError> {
		const provider = fixtureProvider({ token: TOKEN, fetch });
		try {
			await provider.apply(programFor("dep-1"));
		} catch (error) {
			if (error instanceof VercelTransportError) return error;
			throw error;
		}
		throw new Error("expected the deploy to fail");
	}

	const rejecting =
		(thrown: Error | string | JsonObject): VercelFetch =>
		async () => {
			throw thrown;
		};

	// Nowhere the error is printed or kept holds the token, a form of it, or
	// another credential, and it keeps nothing that was thrown.
	function expectNothingLeaks(
		error: VercelTransportError,
		forms: readonly string[] = [],
	): void {
		expect(error).toBeInstanceOf(VercelTransportError);
		expect(error.name).toBe("VercelTransportError");
		expect(error.cause).toBeUndefined();
		expect(Object.keys(error)).toEqual(["name"]);
		const printed = [
			error.message,
			error.stack ?? "",
			String(error),
			inspect(error, { depth: 10, showHidden: true }),
			JSON.stringify(error),
			`executor.apply_failed: ${error.message}`,
		];
		for (const text of printed) {
			for (const form of [TOKEN, OTHER_KEY, ...forms]) {
				expect(text).not.toContain(form);
			}
		}
	}

	it("redacts what a rejected request says, and keeps nothing of it", async () => {
		const error = await failedBy(
			rejecting(
				new Error(
					`proxy refused: sent Bearer ${TOKEN} and api_key=${OTHER_KEY}`,
				),
			),
		);

		expectNothingLeaks(error);
		expect(error.message).toBe(
			"vercel-client: create deployment got no answer: Error: proxy refused: sent [redacted] and [redacted]",
		);
	});

	it("redacts runtime's own refusal of the header, as undici words it", async () => {
		const error = await failedBy(
			rejecting(
				new TypeError(
					`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`,
				),
			),
		);

		expectNothingLeaks(error);
		expect(error.message).toMatch(
			/^vercel-client: create deployment got no answer: TypeError: Headers\.append: /u,
		);
	});

	it("reads down the cause chain, codes included, and redacts each link", async () => {
		const refused = Object.assign(
			new Error(`connect ECONNREFUSED 127.0.0.1:443 (as ${TOKEN})`, {
				cause: `a string cause with ${base64(TOKEN)}`,
			}),
			{ code: "ECONNREFUSED" },
		);
		const error = await failedBy(
			rejecting(new TypeError("fetch failed", { cause: refused })),
		);

		expectNothingLeaks(error, [base64(TOKEN)]);
		expect(error.message).toBe(
			"vercel-client: create deployment got no answer: TypeError: fetch failed; Error [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:443 (as [redacted]); a string cause with [redacted]",
		);
	});

	it("reads an AggregateError's errors, and redacts each", async () => {
		const error = await failedBy(
			rejecting(
				new AggregateError(
					[new Error(`first ${TOKEN}`), new Error(`second ${OTHER_KEY}`)],
					"every address failed",
				),
			),
		);

		expectNothingLeaks(error);
		expect(error.message).toBe(
			"vercel-client: create deployment got no answer: AggregateError: every address failed; Error: first [redacted]; Error: second [redacted]",
		);
	});

	it("ends on a cause chain that loops, and on one that runs long", async () => {
		const looped = new Error(`one ${TOKEN}`);
		looped.cause = new Error("two", { cause: looped });
		let long = new Error("last");
		for (let i = 0; i < 10_000; i++)
			long = new Error(`link ${i}`, { cause: long });

		const fromLoop = await failedBy(rejecting(looped));
		const fromLong = await failedBy(rejecting(long));

		expectNothingLeaks(fromLoop);
		expect(fromLoop.message).toBe(
			"vercel-client: create deployment got no answer: Error: one [redacted]; Error: two",
		);
		expectNothingLeaks(fromLong);
		expect(fromLong.message.length).toBeLessThanOrEqual(501);
	});

	it.each([
		["a string", `refused ${TOKEN}`, "refused [redacted]"],
		["an object", { token: TOKEN }, "a thrown object"],
	])("wraps %s thrown by the transport", async (_case, thrown, said) => {
		const error = await failedBy(rejecting(thrown));

		expectNothingLeaks(error);
		expect(error.message).toBe(
			`vercel-client: create deployment got no answer: ${said}`,
		);
	});

	it("reads nothing of a thrown value whose getter throws", async () => {
		const hostile = new Error("unread");
		Object.defineProperty(hostile, "message", {
			get() {
				throw new Error(`a getter, ${TOKEN}`);
			},
		});

		const error = await failedBy(rejecting(hostile));

		expectNothingLeaks(error);
		expect(error.message).toBe(
			"vercel-client: create deployment got no answer: a thrown value that could not be read",
		);
	});

	it("wraps a transport that throws before it returns a promise", async () => {
		const error = await failedBy(() => {
			throw new Error(`synchronously, ${TOKEN}`);
		});

		expectNothingLeaks(error);
		expect(error.message).toBe(
			"vercel-client: create deployment got no answer: Error: synchronously, [redacted]",
		);
	});

	// A runtime's JSON error quotes the start of the body, cut short: a part of
	// the token no pattern of the whole token can find. The reason is fixed,
	// and nothing of the body is quoted.
	it.each([
		["the token at its start", `${TOKEN} and the rest`],
		["the token after a few characters", `<p>${TOKEN}</p>`],
		["the token split across the quote's cut", `<html>${TOKEN.repeat(3)}`],
	])("names no part of a 2xx body that is not JSON: %s", async (_case, body) => {
		const error = await failedBy(async () => ({
			ok: true,
			status: 200,
			async text() {
				return body;
			},
			async json() {
				return JSON.parse(body);
			},
		}));

		expectNothingLeaks(error);
		expect(error.message).toBe(
			"vercel-client: create deployment answered HTTP 200, and its body could not be read: response body was not JSON",
		);
		for (const part of [TOKEN.slice(0, 6), TOKEN.slice(4, 10), "<p>", "<html>"])
			expect(error.message).not.toContain(part);
	});

	it.each([
		["LF", "\n"],
		["CR", "\r"],
		["NUL", "\u0000"],
		["a tab", "\t"],
		["a space", " "],
		["a zero-width space", "\u200b"],
		["a variation selector (U+FE0F)", "\ufe0f"],
		["a variation selector supplement (U+E0100)", "\u{e0100}"],
	])("refuses a token holding %s before any request, not saying it", (_case, char) => {
		const token = `${TOKEN.slice(0, 10)}${char}${TOKEN.slice(10)}`;
		const { fetch, sent } = scripted({});

		let refusal: unknown;
		try {
			fixtureProvider({ token, fetch });
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(TypeError);
		const message = refusal instanceof Error ? refusal.message : "";
		expect(message).toMatch(/^createVercelClient: the token holds /u);
		expect(message).not.toContain(TOKEN.slice(0, 10));
		expect(message).not.toContain(TOKEN.slice(10));
		expect(sent).toEqual([]);
	});
});

// The deployment read and delete main added (`getDeployment`,
// `deleteDeployment`) follow the client's rules: a request with nothing to send
// carries no body (`fetch` refuses a GET with one), the team id is trimmed, and
// a transport that throws is a redacted VercelTransportError.
describe("createVercelClient's deployment read and delete (scripted transport, no network)", () => {
	const READ = "GET /v13/deployments/dpl_1";
	const DELETE = "DELETE /v13/deployments/dpl_1";
	const READ_BACK = reply(200, { id: "dpl_1", url: "one.vercel.app" });

	it("reads and deletes with no body, in the trimmed team", async () => {
		const { fetch, sent, routes } = scripted({
			[READ]: [READ_BACK, reply(404, {})],
			[DELETE]: [reply(200, {})],
		});
		const client = createVercelClient({
			token: "tok",
			fetch,
			teamId: " team_x ",
		});

		const read = await client.getDeployment("dpl_1");
		await client.deleteDeployment("dpl_1");

		expect(read).toMatchObject({ id: "dpl_1", url: "https://one.vercel.app" });
		expect(routes()).toEqual([READ, DELETE, READ]);
		for (const { url, init } of sent) {
			expect(Object.keys(init)).toEqual(["method", "headers"]);
			expect(new URL(url).search).toBe("?teamId=team_x");
		}
	});

	it("wraps a transport failure on a read, the token redacted", async () => {
		const token = "tok_SECRET_0123456789abcdef";
		const client = createVercelClient({
			token,
			fetch: async () => {
				throw new TypeError(`fetch failed: Bearer ${token}`);
			},
		});

		const error = await client.getDeployment("dpl_1").then(
			() => undefined,
			(thrown: Error) => thrown,
		);

		expect(error).toBeInstanceOf(VercelTransportError);
		expect(error?.message).toBe(
			"vercel-client: get deployment got no answer: TypeError: fetch failed: [redacted]",
		);
		expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
			token,
		);
	});
});

describe("createVercelClient's teamId (scripted transport, no network)", () => {
	it.each([
		["blank", " ", ""],
		["empty", "", ""],
		["padded", " team_x ", "?teamId=team_x"],
	])("takes a %s teamId as the provider does: trimmed, and blank as none", async (_case, teamId, query) => {
		const { fetch, sent } = scripted({
			[CREATE]: [reply(200, { id: "prj_fresh", name: "fresh" })],
		});
		const client = createVercelClient({ token: "tok", fetch, teamId });

		await client.createProject("fresh");

		expect(new URL(first(sent).url).search).toBe(query);
	});
});

describe("createVercelClient.createProject (scripted transport, no network)", () => {
	it("answers the project it created", async () => {
		const { fetch } = scripted({
			[CREATE]: [reply(200, { id: "prj_fresh", name: "fresh" })],
		});
		const client = createVercelClient({ token: "tok", fetch });

		await expect(client.createProject("fresh")).resolves.toEqual({
			id: "prj_fresh",
			name: "fresh",
			created: true,
		});
	});

	it("answers created: false, with the 409's reason, when the name is taken (409 conflict)", async () => {
		const { fetch } = scripted({ [CREATE]: [CONFLICT] });
		const client = createVercelClient({ token: "tok", fetch });

		await expect(client.createProject("raced")).resolves.toEqual({
			id: "",
			name: "raced",
			created: false,
			conflictMessage: "A project with the same name already exists.",
		});
	});

	it.each([
		[
			"another code",
			reply(409, {
				error: {
					code: "project_transfer_in_progress",
					message: "The project is being transferred.",
				},
			}),
			"project_transfer_in_progress",
		],
		["a body that is not JSON", plainReply(409, "Conflict"), undefined],
	])("refuses a 409 with %s as a VercelApiError", async (_case, answer, code) => {
		const { fetch } = scripted({ [CREATE]: [answer] });
		const client = createVercelClient({ token: "tok", fetch });

		const pending = client.createProject("held");

		await expect(pending).rejects.toBeInstanceOf(VercelApiError);
		await expect(pending).rejects.toMatchObject({
			status: 409,
			code,
			message: expect.stringContaining("create project failed (HTTP 409)"),
		});
	});
});

describe("the default transport", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("hands global fetch each request exactly as the client formed it", async () => {
		const missingProject = () => ({
			[DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[CREATE]: [CREATED],
		});
		const injected = scripted(missingProject());
		await fixtureProvider({
			token: "tok",
			fetch: injected.fetch,
		}).apply(programFor("dep-1"));

		const viaGlobal = scripted(missingProject());
		vi.stubGlobal("fetch", viaGlobal.fetch);
		await fixtureProvider({ token: "tok" }).apply(programFor("dep-1"));

		expect(viaGlobal.sent).toEqual(injected.sent);
		for (const { init } of viaGlobal.sent) {
			expect(Object.keys(init)).toEqual(["method", "headers", "body"]);
		}
	});
});
