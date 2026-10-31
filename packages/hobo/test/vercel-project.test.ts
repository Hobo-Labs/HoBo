import { inspect } from "node:util";

import type { IacProgram } from "@hobo/cloud";
import type { EventStore } from "@hobo/core";
import { at, first } from "@hobo/core/total-access";
import { afterEach, describe, expect, it, vi } from "vitest";

import { selectIacProvider } from "../src/compose.js";
import { type JsonObject, parseJsonObject } from "../src/json.js";
import {
	createVercelClient,
	VercelApiError,
	type VercelFetch,
	type VercelFetchResponse,
	VercelTransportError,
} from "../src/vercel-client.js";
import { createVercelDeployProvider } from "../src/vercel-deploy-provider.js";

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

		const outputs = await provider.apply(programFor("dep-1"));

		expect(routes()).toEqual([DEPLOY, CREATE, DEPLOY]);
		expect(outputs).toMatchObject({ projectCreated: "true" });
	});

	it("on a missing project: deploy 404, create the project, deploy again", async () => {
		const { fetch, sent, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[CREATE]: [CREATED],
		});
		const provider = createVercelDeployProvider({
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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({
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
		const provider = createVercelDeployProvider({
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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const alone = await createVercelDeployProvider({
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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });

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
		const provider = createVercelDeployProvider({ token: "tok", fetch });
		await provider.preview(programFor("dep-1"));
		expect(sent).toEqual([]);
	});
});

describe("the composed provider's team (selectIacProvider, scripted transport, no network)", () => {
	// selectIacProvider builds the Pulumi lane's provider lazily, so a stand-in
	// store is never read on the Vercel path.
	const deps = {
		// SAFETY: assertion required at this I/O or test boundary.
		store: {} as EventStore,
		providers: [],
	};

	async function composedDeploy(env: NodeJS.ProcessEnv) {
		const { fetch, sent, routes } = scripted({
			[DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[CREATE]: [CREATED],
		});
		const provider = selectIacProvider({ ...deps, env, vercelFetch: fetch });
		const outputs = await provider.apply(programFor("dep-1"));
		const queries = sent.map(({ url }) => new URL(url).search);
		return { outputs, queries, routes: routes() };
	}

	it("creates and deploys in the team VERCEL_TEAM_ID names, and says so", async () => {
		const { outputs, queries, routes } = await composedDeploy({
			VERCEL_TOKEN: "tok",
			VERCEL_TEAM_ID: "team_acme",
		});

		expect(routes).toEqual([DEPLOY, CREATE, DEPLOY]);
		expect(queries).toEqual([
			"?teamId=team_acme",
			"?teamId=team_acme",
			"?teamId=team_acme",
		]);
		expect(outputs).toMatchObject({
			projectCreated: "true",
			scope: "team_acme",
		});
	});

	it.each([
		["VERCEL_ORG_ID alone, trimmed", { VERCEL_ORG_ID: " team_x " }, "team_x"],
		[
			"VERCEL_TEAM_ID over VERCEL_ORG_ID",
			{ VERCEL_TEAM_ID: "team_acme", VERCEL_ORG_ID: "team_org" },
			"team_acme",
		],
		[
			"VERCEL_ORG_ID when VERCEL_TEAM_ID is blank",
			{ VERCEL_TEAM_ID: "  ", VERCEL_ORG_ID: "team_org" },
			"team_org",
		],
		// The operator set VERCEL_TEAM_ID on purpose: a slug or any id is taken
		// as given, whatever VERCEL_ORG_ID holds.
		[
			"a VERCEL_TEAM_ID that is not a team_ id, over a personal VERCEL_ORG_ID",
			{ VERCEL_TEAM_ID: "acme-slug", VERCEL_ORG_ID: "u_abc" },
			"acme-slug",
		],
		[
			"a VERCEL_TEAM_ID that is not a team_ id, over a team VERCEL_ORG_ID",
			{ VERCEL_TEAM_ID: "acme-slug", VERCEL_ORG_ID: "team_org" },
			"acme-slug",
		],
	])("takes the team from %s", async (_case, team, teamId) => {
		const { outputs, queries } = await composedDeploy({
			VERCEL_TOKEN: "tok",
			...team,
		});

		expect(queries).toEqual([
			`?teamId=${teamId}`,
			`?teamId=${teamId}`,
			`?teamId=${teamId}`,
		]);
		expect(outputs.scope).toBe(teamId);
	});

	// A bare `team_` is no team id and no account id: refused here, naming the
	// variable, rather than sent as `?teamId=team_`.
	it.each([
		["bare", { VERCEL_ORG_ID: "team_" }],
		["bare, padded", { VERCEL_ORG_ID: " team_ " }],
		[
			"bare, VERCEL_TEAM_ID blank",
			{ VERCEL_TEAM_ID: " ", VERCEL_ORG_ID: "team_" },
		],
	])("refuses a %s team_ VERCEL_ORG_ID before any request", (_case, team) => {
		const { fetch, sent } = scripted({});

		expect(() =>
			selectIacProvider({
				...deps,
				env: { VERCEL_TOKEN: "tok", ...team },
				vercelFetch: fetch,
			}),
		).toThrow(/^VERCEL_ORG_ID is "team_" with no id after it/u);
		expect(sent).toEqual([]);
	});

	it("reads no VERCEL_ORG_ID, bare team_ or not, when VERCEL_TEAM_ID names the team", async () => {
		const { outputs, queries } = await composedDeploy({
			VERCEL_TOKEN: "tok",
			VERCEL_TEAM_ID: "team_acme",
			VERCEL_ORG_ID: "team_",
		});

		expect(queries).toEqual([
			"?teamId=team_acme",
			"?teamId=team_acme",
			"?teamId=team_acme",
		]);
		expect(outputs.scope).toBe("team_acme");
	});

	it.each([
		["unset", {}],
		["empty", { VERCEL_TEAM_ID: "" }],
		["blank", { VERCEL_TEAM_ID: "  " }],
		["blank, VERCEL_ORG_ID too", { VERCEL_TEAM_ID: "", VERCEL_ORG_ID: " " }],
		// A VERCEL_ORG_ID that is not a team_ id is a personal account's, as the
		// Vercel CLI writes it: no team.
		[
			"unset, VERCEL_ORG_ID a personal account (u_abc)",
			{ VERCEL_ORG_ID: "u_abc" },
		],
		[
			"unset, VERCEL_ORG_ID a user id",
			{ VERCEL_ORG_ID: " 6Qn1jRzOd4H7mDmW5wB2kLpX " },
		],
		[
			"blank, VERCEL_ORG_ID a personal account",
			{ VERCEL_TEAM_ID: " ", VERCEL_ORG_ID: "u_abc" },
		],
		["unset, VERCEL_ORG_ID TEAM_X (case matters)", { VERCEL_ORG_ID: "TEAM_x" }],
	])("with VERCEL_TEAM_ID %s, stays in the token's own scope", async (_case, team) => {
		const { outputs, queries } = await composedDeploy({
			VERCEL_TOKEN: "tok",
			...team,
		});

		expect(queries).toEqual(["", "", ""]);
		expect(outputs).toMatchObject({
			projectCreated: "true",
			scope: "token-default",
		});
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
		const provider = createVercelDeployProvider({ token, fetch });
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

	it("stays linear on a long hostile body: 100 kB of whitespace and near-misses", async () => {
		// Every character of the token but the last, each followed by a run of
		// whitespace, over and over: each try runs nearly to the end and fails.
		const nearMiss = Array.from(TOKEN.slice(0, -1)).join(" \r\n\t ");
		let hostile = "";
		while (hostile.length < 100_000)
			hostile += `${nearMiss}${" ".repeat(64)}\n`;
		const body = JSON.stringify({
			error: { code: "not_found", message: hostile },
			raw: hostile,
		});

		const started = performance.now();
		const error = await refusedBy(() => plainReply(404, body));
		const took = performance.now() - started;

		expect(hostile.length).toBeGreaterThanOrEqual(100_000);
		expect(error.message.length).toBeLessThanOrEqual(501);
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
			// Whitespace, and JSON's escapes for it, taken out: a token broken up
			// by a newline or spaces is still the token.
			const squeezed = text.replace(/\\[nrt]|\s/gu, "");
			for (const form of [token, ...forms]) {
				expect(text).not.toContain(form);
				expect(squeezed).not.toContain(form);
			}
			for (const run of text.match(/[A-Za-z0-9+/]{16,}={0,2}/gu) ?? []) {
				expect(Buffer.from(run, "base64").toString("latin1")).not.toContain(
					token.slice(2, -2),
				);
			}
		}
	}

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
		const provider = createVercelDeployProvider({ token: TOKEN, fetch });
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

	it("wraps a 2xx whose body cannot be read, as a runtime's JSON error quotes it", async () => {
		const error = await failedBy(async () => ({
			ok: true,
			status: 200,
			async text() {
				return `<html>${TOKEN}</html>`;
			},
			async json() {
				throw new SyntaxError(
					`Unexpected token '<', "<html>${TOKEN}</html>" is not valid JSON`,
				);
			},
		}));

		expectNothingLeaks(error);
		expect(error.message).toBe(
			`vercel-client: create deployment answered HTTP 200, and its body could not be read: SyntaxError: Unexpected token '<', "<html>[redacted]</html>" is not valid JSON`,
		);
	});

	it.each([
		["LF", "\n"],
		["CR", "\r"],
		["NUL", "\u0000"],
		["a tab", "\t"],
		["a space", " "],
		["a zero-width space", "\u200b"],
	])("refuses a token holding %s before any request, not saying it", (_case, char) => {
		const token = `${TOKEN.slice(0, 10)}${char}${TOKEN.slice(10)}`;
		const { fetch, sent } = scripted({});

		let refusal: unknown;
		try {
			createVercelDeployProvider({ token, fetch });
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
		await createVercelDeployProvider({
			token: "tok",
			fetch: injected.fetch,
		}).apply(programFor("dep-1"));

		const viaGlobal = scripted(missingProject());
		vi.stubGlobal("fetch", viaGlobal.fetch);
		await createVercelDeployProvider({ token: "tok" }).apply(
			programFor("dep-1"),
		);

		expect(viaGlobal.sent).toEqual(injected.sent);
		for (const { init } of viaGlobal.sent) {
			expect(Object.keys(init)).toEqual(["method", "headers", "body"]);
		}
	});
});
