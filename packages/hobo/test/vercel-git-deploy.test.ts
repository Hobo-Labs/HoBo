import { readFileSync } from "node:fs";
import { inspect } from "node:util";

import type { IacProgram } from "@hobo/cloud";
import { parsePactDocument } from "@hobo/contract-harness";
import { at, first } from "@hobo/core/total-access";
import { type PactLifecycle, pactBackedTransport } from "@hobo/testing";
import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../src/json.js";
import {
	createVercelClient,
	VercelApiError,
	VercelEnvRefusal,
	type VercelFetch,
	type VercelFetchResponse,
	VercelTransportError,
} from "../src/vercel-client.js";
import {
	createVercelDeployProvider,
	planVercelGitDeployment,
	type VercelDeployProviderOptions,
} from "../src/vercel-deploy-provider.js";
import {
	isRefusedEnvKey,
	refusedEnvValueReason,
} from "../src/vercel-env-policy.js";

// Git-source deployments and non-secret project configuration, against a fake
// transport only. The contract half replays `contracts/vercel-git-deploy.pact.json`
// through `pactBackedTransport`, which sequences the pact's own recorded
// answers (a variable absent, then present) so "a second run changes nothing"
// is a claim about recorded states rather than about a hand-written fake. The
// pact is a hand-authored consumer expectation, checked against Vercel's REST
// documentation; it is not captured traffic and Vercel has not verified it.
// NO network: nothing here reaches api.vercel.com.

const TOKEN = "synthetic-token-0123";
const TEAM = "team_hobo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SETTING = { HOBO_CI_PUBLIC_URL: "https://ci.example.test" };

const pact = parsePactDocument(
	JSON.parse(
		readFileSync(
			new URL("../contracts/vercel-git-deploy.pact.json", import.meta.url),
			"utf8",
		),
	),
);

const ENV = `/v10/projects/hobo-ci/env?teamId=${TEAM}`;
const LIST = `GET ${ENV}`;
const CREATE_ENV = `POST ${ENV}`;
const EDIT_ENV = `PATCH /v9/projects/hobo-ci/env/env_public_url?teamId=${TEAM}`;
const DEPLOY = `POST /v13/deployments?teamId=${TEAM}`;

// Which recorded listing answers the read in each state. Every body served is
// one the pact declares; only the order is added here.
function lifecycle(initial: "absent" | "present" | "older"): PactLifecycle {
	return {
		initial,
		created: "present",
		creates: [CREATE_ENV],
		answers: {
			absent: {
				[LIST]: "list project environment variables when the setting is absent",
			},
			present: {
				[LIST]:
					"list project environment variables holding the setting as asked",
			},
			older: {
				[LIST]:
					"list project environment variables holding an older value of the setting",
			},
		},
		transitions: { [CREATE_ENV]: "present", [EDIT_ENV]: "present" },
	};
}

function world(initial: "absent" | "present" | "older") {
	return pactBackedTransport(pact, { lifecycle: lifecycle(initial) });
}

// The recorded request of one interaction, as the world records a call: the
// header names lowercased.
function recorded(description: string) {
	const interaction = pact.interactions.find(
		(candidate) => candidate.description === description,
	);
	if (interaction === undefined) throw new Error(`no such: ${description}`);
	return {
		method: interaction.request.method,
		path: interaction.request.path,
		headers: Object.fromEntries(
			Object.entries(interaction.request.headers ?? {}).map(([key, value]) => [
				key.toLowerCase(),
				value,
			]),
		),
		...(interaction.request.body !== undefined
			? { body: interaction.request.body }
			: undefined),
	};
}

const selectors = (calls: readonly { method: string; path: string }[]) =>
	calls.map((call) => `${call.method} ${call.path}`);

function programFor(deploymentId: string): IacProgram {
	return {
		programId: `prog-${deploymentId}`,
		deploymentId,
		resourceId: "relay",
		provider: "vercel",
		driver: "vercel",
		action: "apply",
		stackName: `stack-${deploymentId}`,
	};
}

const GIT = { org: "example", repo: "hobo", ref: "main" };

function gitProvider(
	fetch: VercelFetch,
	options: Partial<VercelDeployProviderOptions> = {},
) {
	return createVercelDeployProvider({
		token: TOKEN,
		fetch,
		teamId: TEAM,
		projectName: "hobo-ci",
		gitArtifact: GIT,
		...options,
	});
}

describe("the Vercel git-deploy pact (pact-backed transport, no network)", () => {
	it("creates a preview deployment by default: a gitSource, no target, no files, no project settings", async () => {
		const vercel = world("absent");
		const outputs = await gitProvider(vercel.fetchImpl).apply(
			programFor("dep-preview"),
		);

		expect(vercel.calls).toEqual([
			recorded("create a preview deployment from a GitHub ref"),
		]);
		expect(Object.keys(at(vercel.calls, 0).body ?? {})).toEqual([
			"name",
			"project",
			"gitSource",
		]);
		expect(vercel.fidelityViolations()).toEqual([]);
		expect(outputs).toEqual({
			url: "https://hobo-ci-git-main.example.vercel.app",
			deploymentId: "dpl_preview",
			provider: "vercel",
			target: "preview",
			projectCreated: "false",
			scope: TEAM,
			artifact: "git",
			gitRepository: "example/hobo",
			gitRef: "main",
			gitSha: "",
			configCreated: "",
			configUpdated: "",
			configUnchanged: "",
		});
	});

	it("deploys to production only when asked, pinned to the commit", async () => {
		const vercel = world("absent");
		const outputs = await gitProvider(vercel.fetchImpl, {
			gitArtifact: { ...GIT, sha: SHA },
			target: "production",
		}).apply(programFor("dep-production"));

		expect(vercel.calls).toEqual([
			recorded(
				"create a production deployment from a GitHub ref pinned to a commit",
			),
		]);
		expect(vercel.fidelityViolations()).toEqual([]);
		expect(outputs).toMatchObject({
			deploymentId: "dpl_production",
			target: "production",
			gitSha: SHA,
		});
	});

	it("sets configuration before deploying, and a second run changes nothing", async () => {
		const vercel = world("absent");
		const firstRun = await gitProvider(vercel.fetchImpl, {
			configuration: SETTING,
		}).apply(programFor("dep-first"));

		expect(selectors(vercel.calls)).toEqual([LIST, CREATE_ENV, DEPLOY]);
		expect(at(vercel.calls, 1)).toEqual(
			recorded(
				"create a plain environment variable for the preview environment",
			),
		);
		expect(firstRun).toMatchObject({
			configCreated: "HOBO_CI_PUBLIC_URL",
			configUpdated: "",
			configUnchanged: "",
		});

		// A new provider, as a second invocation makes: nothing is remembered.
		const secondRun = await gitProvider(vercel.fetchImpl, {
			configuration: SETTING,
		}).apply(programFor("dep-second"));

		expect(selectors(vercel.calls).slice(3)).toEqual([LIST, DEPLOY]);
		expect(vercel.countCreates()).toBe(1);
		expect(secondRun).toMatchObject({
			configCreated: "",
			configUpdated: "",
			configUnchanged: "HOBO_CI_PUBLIC_URL",
		});
		expect(vercel.countUnmatched()).toBe(0);
		expect(vercel.fidelityViolations()).toEqual([]);
	});

	it("edits a plain variable of that environment alone whose value differs", async () => {
		const vercel = world("older");
		const outputs = await gitProvider(vercel.fetchImpl, {
			configuration: SETTING,
		}).apply(programFor("dep-edit"));

		expect(selectors(vercel.calls)).toEqual([LIST, EDIT_ENV, DEPLOY]);
		expect(at(vercel.calls, 1)).toEqual(
			recorded("edit the value of an environment variable"),
		);
		expect(vercel.countCreates()).toBe(0);
		expect(outputs).toMatchObject({
			configCreated: "",
			configUpdated: "HOBO_CI_PUBLIC_URL",
			configUnchanged: "",
		});
		expect(vercel.fidelityViolations()).toEqual([]);
	});

	it("applies each resource of one deployment once", async () => {
		const vercel = world("absent");
		const provider = gitProvider(vercel.fetchImpl, { configuration: SETTING });
		const relay = await provider.apply(programFor("dep-memo"));
		const queue = await provider.apply({
			...programFor("dep-memo"),
			resourceId: "hobo-ci",
		});
		expect(queue).toEqual(relay);
		expect(selectors(vercel.calls)).toEqual([LIST, CREATE_ENV, DEPLOY]);
	});

	it("does not create a project it was told must exist", async () => {
		const vercel = world("absent");
		const provider = gitProvider(vercel.fetchImpl, {
			projectName: "hobo-ci-absent",
			createMissingProject: false,
		});

		await expect(provider.apply(programFor("dep-absent"))).rejects.toThrow(
			/HTTP 404.*Project not found/u,
		);
		expect(vercel.calls).toEqual([
			recorded("refuse a deployment whose project does not exist"),
		]);
		expect(vercel.fidelityViolations()).toEqual([]);
	});

	it("works in the token's own scope without a team id, and says so", async () => {
		for (const teamId of [undefined, "", "   "]) {
			const vercel = world("absent");
			const outputs = await createVercelDeployProvider({
				token: TOKEN,
				fetch: vercel.fetchImpl,
				projectName: "hobo-ci",
				gitArtifact: GIT,
				...(teamId !== undefined ? { teamId } : undefined),
			}).apply(programFor("dep-own-scope"));

			expect(vercel.calls).toEqual([
				recorded("create a preview deployment in the token's own scope"),
			]);
			expect(outputs).toMatchObject({
				deploymentId: "dpl_own_scope",
				scope: "token-default",
			});
			expect(vercel.fidelityViolations()).toEqual([]);
		}
	});

	it("plans exactly the requests a run sends, with no client and no network", async () => {
		const options = {
			teamId: TEAM,
			projectName: "hobo-ci",
			gitArtifact: GIT,
			configuration: SETTING,
		};
		const plan = planVercelGitDeployment(options);
		const vercel = world("absent");
		await createVercelDeployProvider({
			...options,
			token: TOKEN,
			fetch: vercel.fetchImpl,
		}).apply(programFor("dep-planned"));

		expect(
			plan.requests.map(({ method, path, body }) => ({
				method,
				path,
				...(body !== undefined ? { body } : undefined),
			})),
		).toEqual(
			vercel.calls.map(({ method, path, body }) => ({
				method,
				path,
				...(body !== undefined ? { body } : undefined),
			})),
		);
		expect(plan).toMatchObject({
			project: "hobo-ci",
			scope: TEAM,
			target: "preview",
			createMissingProject: true,
			configuration: ["HOBO_CI_PUBLIC_URL"],
		});
		expect(JSON.stringify(plan)).not.toContain(TOKEN);
	});
});

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

/**
 * A transport that answers each `METHOD /path` from a queue of scripted
 * answers, in order, and fails the test on a request nobody scripted.
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
		const next = left.get(route)?.shift();
		if (next === undefined) throw new Error(`unscripted request: ${route}`);
		return next;
	};
	const routes = () =>
		sent.map(({ url, init }) => `${init.method} ${new URL(url).pathname}`);
	return { fetch, sent, routes };
}

const POST_DEPLOY = "POST /v13/deployments";
const POST_PROJECT = "POST /v9/projects";
const GET_ENV = "GET /v10/projects/hobo-ci/env";
const POST_ENV = "POST /v10/projects/hobo-ci/env";

const PROJECT_NOT_FOUND = reply(404, {
	error: { code: "not_found", message: "Project not found" },
});
const CONFLICT = reply(409, {
	error: {
		code: "conflict",
		message: "A project with the same name already exists.",
	},
});
const DEPLOYED = reply(200, { id: "dpl_1", url: "hobo-ci-1.vercel.app" });
const NO_ENVS = reply(200, { envs: [] });
const ENV_CREATED = reply(201, { created: { key: "X" }, failed: [] });

const listing = (...envs: JsonObject[]) => reply(200, { envs });

describe("createVercelClient.createDeployment from a git reference (scripted transport, no network)", () => {
	it("keeps the file-tree request byte for byte", async () => {
		const { fetch, sent } = scripted({ [POST_DEPLOY]: [DEPLOYED, DEPLOYED] });
		const client = createVercelClient({ token: TOKEN, fetch });

		await client.createDeployment({
			name: "n",
			files: [{ file: "index.html", data: "aGk=" }],
			target: "production",
		});
		await client.createDeployment({ name: "n", files: [] });

		expect(at(sent, 0).init.body).toBe(
			'{"name":"n","project":"n","files":[{"file":"index.html","data":"aGk=","encoding":"base64"}],"target":"production","projectSettings":{"framework":null}}',
		);
		expect(at(sent, 1).init.body).toBe(
			'{"name":"n","project":"n","files":[],"projectSettings":{"framework":null}}',
		);
	});

	it("sends project settings for a git deployment only when given", async () => {
		const { fetch, sent } = scripted({ [POST_DEPLOY]: [DEPLOYED] });
		await gitProvider(fetch, {
			gitArtifact: { ...GIT, rootDirectory: "packages/ci-vercel" },
		}).apply(programFor("dep-root"));

		expect(first(sent).init.body).toBe(
			'{"name":"hobo-ci","project":"hobo-ci","gitSource":{"type":"github","org":"example","repo":"hobo","ref":"main"},"projectSettings":{"rootDirectory":"packages/ci-vercel"}}',
		);
	});

	it("refuses a gitSource that is not one before any request", async () => {
		const { fetch, sent } = scripted({});
		const client = createVercelClient({ token: TOKEN, fetch });
		const source = { type: "github", org: "example", repo: "hobo" } as const;

		for (const gitSource of [
			{ ...source, ref: "" },
			{ ...source, ref: "main branch" },
			{ ...source, ref: "a..b" },
			{ ...source, ref: "main", sha: "0123abc" },
			{ ...source, ref: "main", sha: SHA.toUpperCase() },
			{ ...source, org: "exa mple", ref: "main" },
			{ ...source, repo: "ho/bo", ref: "main" },
		]) {
			await expect(
				client.createDeployment({ name: "hobo-ci", gitSource }),
			).rejects.toThrow(TypeError);
		}
		expect(sent).toEqual([]);
	});
});

describe("createVercelDeployProvider with a git artifact (scripted transport, no network)", () => {
	it("refuses a target that is neither preview nor production, at construction", () => {
		const { fetch } = scripted({});
		for (const target of ["staging", "Production", ""]) {
			expect(() => gitProvider(fetch, { target })).toThrow(
				/"preview" \(the default\) or "production"/u,
			);
		}
	});

	it("needs an explicit project, and is not the fixture path", () => {
		const { fetch } = scripted({});
		expect(() =>
			createVercelDeployProvider({ token: TOKEN, fetch, gitArtifact: GIT }),
		).toThrow(/explicit projectName/u);
		expect(() => gitProvider(fetch, { fixtureArtifact: true })).toThrow(
			/not both/u,
		);
		expect(() =>
			createVercelDeployProvider({
				fixtureArtifact: true,
				token: TOKEN,
				fetch,
				configuration: SETTING,
			}),
		).toThrow(/the fixture path sets none/u);
	});

	it("previews without a request", async () => {
		const { fetch, sent } = scripted({});
		const diff = await gitProvider(fetch, {
			gitArtifact: { ...GIT, sha: SHA },
			configuration: SETTING,
		}).preview(programFor("dep-preview"));

		expect(sent).toEqual([]);
		expect(diff).toEqual({
			summary: `vercel deploy hobo-ci target=preview git=example/hobo@${SHA} (1 settings) [dry-run; live call cred-gated]`,
			changes: 2,
		});
	});

	it("creates the project when the deployment finds none, and deploys once more", async () => {
		const { fetch, routes, sent } = scripted({
			[POST_DEPLOY]: [PROJECT_NOT_FOUND, DEPLOYED],
			[POST_PROJECT]: [reply(200, { id: "prj_new", name: "hobo-ci" })],
		});
		const outputs = await gitProvider(fetch).apply(programFor("dep-create"));

		expect(routes()).toEqual([POST_DEPLOY, POST_PROJECT, POST_DEPLOY]);
		expect(at(sent, 2).init.body).toBe(first(sent).init.body);
		expect(outputs).toMatchObject({ projectCreated: "true", scope: TEAM });
	});

	it("creates the project when its configuration finds none, then sets and deploys", async () => {
		const { fetch, routes } = scripted({
			[GET_ENV]: [PROJECT_NOT_FOUND, NO_ENVS],
			[POST_PROJECT]: [reply(200, { id: "prj_new", name: "hobo-ci" })],
			[POST_ENV]: [ENV_CREATED],
			[POST_DEPLOY]: [DEPLOYED],
		});
		const outputs = await gitProvider(fetch, { configuration: SETTING }).apply(
			programFor("dep-configure-create"),
		);

		expect(routes()).toEqual([
			GET_ENV,
			POST_PROJECT,
			GET_ENV,
			POST_ENV,
			POST_DEPLOY,
		]);
		expect(outputs).toMatchObject({
			projectCreated: "true",
			configCreated: "HOBO_CI_PUBLIC_URL",
		});
	});

	it("names the 409 that answered the create when the deployment is refused after it", async () => {
		const { fetch, routes } = scripted({
			[POST_DEPLOY]: [PROJECT_NOT_FOUND, PROJECT_NOT_FOUND],
			[POST_PROJECT]: [CONFLICT],
		});
		const refusal = await gitProvider(fetch)
			.apply(programFor("dep-conflict"))
			.catch((error: Error) => error);

		expect(routes()).toEqual([POST_DEPLOY, POST_PROJECT, POST_DEPLOY]);
		expect(refusal).toBeInstanceOf(VercelApiError);
		expect(refusal).toMatchObject({
			message: expect.stringContaining(
				"(after create project was answered HTTP 409 conflict: A project with the same name already exists.)",
			),
		});
	});

	it("deploys nothing when the configuration is refused", async () => {
		const { fetch, sent } = scripted({});
		await expect(
			gitProvider(fetch, {
				configuration: { ...SETTING, CRON_SECRET: "x".repeat(32) },
			}).apply(programFor("dep-refused")),
		).rejects.toThrow(VercelEnvRefusal);
		expect(sent).toEqual([]);
	});
});

describe("createVercelClient.setProjectEnv (scripted transport, no network)", () => {
	const client = (fetch: VercelFetch) =>
		createVercelClient({ token: TOKEN, fetch, teamId: TEAM });
	const set = (fetch: VercelFetch, variables: Record<string, string>) =>
		client(fetch).setProjectEnv({
			project: "hobo-ci",
			target: "preview",
			variables,
		});

	it.each([
		"DATABASE_URL",
		"DATABASE_URL_UNPOOLED",
		"POSTGRES_URL",
		"PGPASSWORD",
		"REDIS_URL",
		"ConnectionStrings__Relay",
		"CRON_SECRET",
		"API_KEY",
		"HOBO_CI_SESSION_KEY",
		"HOBO_CI_BOOTSTRAP_TOKEN_SHA256",
		"HOBO_CI_CONTROL_TOKENS_JSON",
		"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
		"HOBO_CI_GITHUB_APP_CLIENT_SECRET",
		"HOBO_CI_WEBHOOK_SECRET",
		"VERCEL_TOKEN",
		"ACCESSTOKEN",
		"MY_PASSWORD",
		"hobo_ci_session_key",
		"not a name",
		"1ST",
	])("refuses the secret-looking name %s before any request", async (key) => {
		const { fetch, sent } = scripted({});
		expect(isRefusedEnvKey(key)).toBe(true);
		await expect(
			set(fetch, { ...SETTING, [key]: "plain-looking-value" }),
		).rejects.toThrow(VercelEnvRefusal);
		expect(sent).toEqual([]);
	});

	it.each([
		"HOBO_CI_PUBLIC_URL",
		"HOBO_CI_SANDBOX_ENABLED",
		"HOBO_CI_SANDBOX_TEAM_ID",
		"HOBO_CI_SANDBOX_PROJECT_ID",
		"HOBO_CI_SANDBOX_ISSUER",
		"HOBO_CI_SANDBOX_DOMAINS_JSON",
		"HOBO_CI_SANDBOX_PLAN",
		"HOBO_CI_BOOTSTRAP_ACCOUNT_ID",
		"HOBO_CI_GITHUB_APP_ID",
		"HOBO_CI_GITHUB_APP_CLIENT_ID",
	])("takes the relay's non-secret setting %s", (key) => {
		expect(isRefusedEnvKey(key)).toBe(false);
	});

	it.each([
		["a connection string", "postgres://relay:synthetic-pw@db.example.test/ci"],
		["a URL with credentials", "https://user:synthetic-pw@example.test/"],
		["a bearer header", "Bearer synthetic-bearer-value"],
		["this client's own token", TOKEN],
		["its own token inside a value", `prefix-${TOKEN}-suffix`],
		["a control character", "line\nbreak"],
		["surrounding whitespace", " padded "],
	])("refuses %s as a value, and never quotes it", async (_name, value) => {
		const { fetch, sent } = scripted({});
		const refusal = await set(fetch, { HOBO_CI_PUBLIC_URL: value }).catch(
			(error: Error) => error,
		);

		expect(refusal).toBeInstanceOf(VercelEnvRefusal);
		expect(inspect(refusal)).not.toContain(value.trim());
		expect(sent).toEqual([]);
	});

	it("takes an ordinary value", () => {
		expect(refusedEnvValueReason("https://ci.example.test")).toBeUndefined();
		expect(
			refusedEnvValueReason('["github.com","nodejs.org"]'),
		).toBeUndefined();
	});

	it("sends nothing at all for no variables", async () => {
		const { fetch, sent } = scripted({});
		expect(await set(fetch, {})).toEqual({
			created: [],
			updated: [],
			unchanged: [],
		});
		expect(sent).toEqual([]);
	});

	it("leaves alone a variable another environment's entry already covers as asked", async () => {
		const { fetch, routes } = scripted({
			[GET_ENV]: [
				listing({
					id: "env_1",
					key: "HOBO_CI_PUBLIC_URL",
					value: SETTING.HOBO_CI_PUBLIC_URL,
					type: "plain",
					target: ["production", "preview"],
				}),
			],
		});
		expect(await set(fetch, SETTING)).toEqual({
			created: [],
			updated: [],
			unchanged: ["HOBO_CI_PUBLIC_URL"],
		});
		expect(routes()).toEqual([GET_ENV]);
	});

	it("creates beside a variable set for another environment or a git branch only", async () => {
		const { fetch, routes, sent } = scripted({
			[GET_ENV]: [
				listing(
					{
						id: "env_prod",
						key: "HOBO_CI_PUBLIC_URL",
						value: "https://production.example.test",
						type: "plain",
						target: ["production"],
					},
					{
						id: "env_branch",
						key: "HOBO_CI_PUBLIC_URL",
						value: "https://branch.example.test",
						type: "plain",
						target: ["preview"],
						gitBranch: "feature-1",
					},
				),
			],
			[POST_ENV]: [ENV_CREATED],
		});
		expect(await set(fetch, SETTING)).toMatchObject({
			created: ["HOBO_CI_PUBLIC_URL"],
		});
		expect(routes()).toEqual([GET_ENV, POST_ENV]);
		expect(at(sent, 1).init.body).toBe(
			'{"key":"HOBO_CI_PUBLIC_URL","value":"https://ci.example.test","type":"plain","target":["preview"]}',
		);
	});

	it.each([
		[
			"an encrypted variable of the operator's",
			{ type: "encrypted", value: "synthetic-ciphertext", target: ["preview"] },
			/already set for preview as encrypted, which the operator owns/u,
		],
		[
			"a sensitive variable of the operator's",
			{ type: "sensitive", target: ["preview"] },
			/already set for preview as sensitive/u,
		],
		[
			"a plain variable shared with production under another value",
			{
				type: "plain",
				value: "https://shared.example.test",
				target: ["production", "preview"],
			},
			/shared with production under a different value/u,
		],
	])("refuses to overwrite %s, before any write", async (_name, held, reason) => {
		const { fetch, routes } = scripted({
			[GET_ENV]: [
				listing(
					{ id: "env_held", key: "HOBO_CI_PUBLIC_URL", ...held },
					{
						id: "env_other",
						key: "HOBO_CI_SANDBOX_PLAN",
						value: "hobby",
						type: "plain",
						target: ["preview"],
					},
				),
			],
		});
		const refusal = await set(fetch, {
			...SETTING,
			HOBO_CI_SANDBOX_PLAN: "pro",
		}).catch((error: Error) => error);

		expect(refusal).toBeInstanceOf(VercelEnvRefusal);
		expect(refusal).toMatchObject({ message: expect.stringMatching(reason) });
		expect(inspect(refusal)).not.toContain("synthetic-ciphertext");
		// The other variable differs too, and is not edited: nothing was changed.
		expect(routes()).toEqual([GET_ENV]);
	});

	it("refuses a listing that goes on past one page", async () => {
		const { fetch, routes } = scripted({
			[GET_ENV]: [reply(200, { envs: [], pagination: { next: 2 } })],
		});
		await expect(set(fetch, SETTING)).rejects.toThrow(VercelTransportError);
		expect(routes()).toEqual([GET_ENV]);
	});

	it("reports a create Vercel answered 2xx and marked failed", async () => {
		const { fetch } = scripted({
			[GET_ENV]: [NO_ENVS],
			[POST_ENV]: [
				reply(201, {
					failed: [{ error: { code: "ENV_CONFLICT", message: "exists" } }],
				}),
			],
		});
		await expect(set(fetch, SETTING)).rejects.toThrow(
			/reported HOBO_CI_PUBLIC_URL as failed/u,
		);
	});

	it("carries the team on every request, and none without a team", async () => {
		const answers = {
			[GET_ENV]: [NO_ENVS],
			[POST_ENV]: [ENV_CREATED],
		};
		const team = scripted(answers);
		await set(team.fetch, SETTING);
		expect(team.sent.map(({ url }) => new URL(url).search)).toEqual([
			`?teamId=${TEAM}`,
			`?teamId=${TEAM}`,
		]);

		const own = scripted(answers);
		await createVercelClient({ token: TOKEN, fetch: own.fetch }).setProjectEnv({
			project: "hobo-ci",
			target: "preview",
			variables: SETTING,
		});
		expect(own.sent.map(({ url }) => new URL(url).search)).toEqual(["", ""]);
	});
});

describe("the token (scripted transport, no network)", () => {
	it("is in no output, plan, error or log line of a git deployment", async () => {
		const logged: string[] = [];
		const spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(level) =>
				vi.spyOn(console, level).mockImplementation((...parts) => {
					logged.push(inspect(parts));
				}),
		);
		const echo = {
			error: {
				code: "forbidden",
				message: `Not authorized: Bearer ${TOKEN}`,
				authorization: `Bearer ${TOKEN}`,
			},
		};
		const seen: string[] = [];
		try {
			const ok = scripted({
				[GET_ENV]: [NO_ENVS],
				[POST_ENV]: [ENV_CREATED],
				[POST_DEPLOY]: [reply(200, { id: "dpl_1", url: "x.vercel.app" })],
			});
			seen.push(
				JSON.stringify(
					await gitProvider(ok.fetch, { configuration: SETTING }).apply(
						programFor("dep-ok"),
					),
				),
				JSON.stringify(
					planVercelGitDeployment({
						teamId: TEAM,
						projectName: "hobo-ci",
						gitArtifact: GIT,
						configuration: SETTING,
					}),
				),
				JSON.stringify(
					await gitProvider(ok.fetch).preview(programFor("dep-ok")),
				),
			);

			for (const script of [
				{ [GET_ENV]: [reply(403, echo)] },
				{ [GET_ENV]: [NO_ENVS], [POST_ENV]: [reply(400, echo)] },
				{
					[GET_ENV]: [NO_ENVS],
					[POST_ENV]: [ENV_CREATED],
					[POST_DEPLOY]: [reply(403, echo)],
				},
				// Nothing scripted: the transport throws, naming the header it sent.
				{},
			]) {
				const refused = scripted(script);
				const fetch: VercelFetch = async (url, init) => {
					try {
						return await refused.fetch(url, init);
					} catch {
						throw new Error(`refused ${init.headers.Authorization}`);
					}
				};
				const error = await gitProvider(fetch, { configuration: SETTING })
					.apply(programFor("dep-refused"))
					.catch((thrown: Error) => thrown);
				expect(error).toBeInstanceOf(Error);
				seen.push(inspect(error, { depth: 8 }), String(error));
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}

		expect(seen).toHaveLength(11);
		for (const text of [...seen, ...logged]) expect(text).not.toContain(TOKEN);
		// Nothing on this path writes a log line at all.
		expect(logged).toEqual([]);
	});
});
