import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHoboCli } from "@hobo/cli";
import type { HttpTransport } from "@hobo/core";
import { createTrustedVault } from "@hobo/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCiCommand } from "../src/ci-command.js";
import {
	RELAY_DEPLOY_READER_OIDC_AUDIENCE,
	type readRelayDeployToken,
} from "../src/ci-relay-deploy-credential.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";
import type { VercelFetch } from "../src/vercel-client.js";
import type { VercelBuildRunner } from "../src/vercel-prebuilt.js";
import {
	keepInOwnerStore,
	ownerStoreEntries,
	syntheticRelayBinding,
} from "./support/owner-store-stand-in.js";

const RELAY_DIR = fileURLToPath(new URL("../../ci-vercel/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "synthetic-token-prebuilt-0123";
const TEAM = "team_hobo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PROJECT_ID = "prj_relay";
const PINNED = [
	"--repo",
	"example/hobo",
	"--ref",
	"main",
	"--sha",
	SHA,
	"--project",
	"hobo-ci",
	"--build",
	"prebuilt",
];
const PRODUCTION_ORIGIN = "https://relay.example.test";

const relayFixtureDir = mkdtempSync(
	join(RELAY_DIR, "..", ".ci-relay-prebuilt-fixture-"),
);
cpSync(RELAY_DIR, relayFixtureDir, {
	recursive: true,
	filter: (source) => !source.includes("node_modules"),
});
rmSync(join(relayFixtureDir, "package.json"), { force: true });
symlinkSync(
	join(RELAY_DIR, "node_modules"),
	join(relayFixtureDir, "node_modules"),
);
const OWNER_STORE = mkdtempSync(join(tmpdir(), "hobo-owner-store-"));
keepInOwnerStore(OWNER_STORE, syntheticRelayBinding());
const BUNDLE = join(relayFixtureDir, "deploy", "secret-store.binding.json");

beforeAll(() => {
	vi.stubEnv("HOBO_CI_RELAY_URL", PRODUCTION_ORIGIN);
});
afterAll(() => {
	vi.unstubAllEnvs();
});

const homes: string[] = [];
function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "hobo-ci-prebuilt-"));
	homes.push(home);
	return home;
}
afterAll(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
	rmSync(relayFixtureDir, { recursive: true, force: true });
	rmSync(OWNER_STORE, { recursive: true, force: true });
});

function steppingClock() {
	let clock = Date.UTC(2026, 10, 21, 12);
	return {
		sleep: async (ms: number) => {
			clock += ms;
		},
		now: () => clock,
	};
}

type Deployment = {
	uid: string;
	url: string;
	readyState: string;
	target: string;
	created: number;
	meta: Record<string, string>;
};

function prebuiltVercel(initial: { production?: string } = {}) {
	const deployments: Deployment[] = [];
	const sent: string[] = [];
	const state = {
		production: initial.production ?? "dpl_live",
		deployments,
		sent,
	};
	const answer = (status: number, body: JsonObject) => ({
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return JSON.stringify(body);
		},
		async json() {
			return body;
		},
	});
	const fetch: VercelFetch = async (url, init) => {
		const parsed = new URL(url);
		const path = parsed.pathname;
		state.sent.push(`${init.method} ${path}`);
		if (init.method === "POST" && path === "/v13/deployments")
			throw new Error("a prebuilt delivery never asks Vercel to build");
		if (
			init.method === "GET" &&
			(path === "/v9/projects/hobo-ci" || path === `/v9/projects/${PROJECT_ID}`)
		)
			return answer(200, {
				id: PROJECT_ID,
				name: "hobo-ci",
				targets: { production: { id: state.production } },
			});
		if (init.method === "GET" && path === "/v6/deployments")
			return answer(200, {
				deployments: state.deployments.filter(
					(entry) =>
						parsed.searchParams.get("target") === null ||
						entry.target === parsed.searchParams.get("target"),
				),
			});
		if (init.method === "GET" && path.startsWith("/v13/deployments/")) {
			const id = path.slice("/v13/deployments/".length);
			const found = state.deployments.find((entry) => entry.uid === id);
			if (!found)
				return answer(404, { error: { code: "not_found", message: "no" } });
			return answer(200, {
				id: found.uid,
				name: "hobo-ci",
				projectId: PROJECT_ID,
				url: found.url.replace("https://", ""),
				readyState: found.readyState,
				target: found.target,
				meta: found.meta,
			});
		}
		if (path === `/v10/projects/${PROJECT_ID}/env`)
			return init.method === "GET"
				? answer(200, { envs: [] })
				: answer(200, { created: {} });
		const promote = path.match(/^\/v10\/projects\/([^/]+)\/promote\/([^/]+)$/);
		if (init.method === "POST" && promote) {
			state.production = promote[2] ?? "";
			return answer(201, {});
		}
		const rollback = path.match(/^\/v1\/projects\/([^/]+)\/rollback\/([^/]+)$/);
		if (init.method === "POST" && rollback) {
			state.production = rollback[2] ?? "";
			return answer(201, {});
		}
		return answer(404, { error: { code: "not_found", message: "no" } });
	};
	return { fetch, state };
}

function fakeVercelBuild(vercel: ReturnType<typeof prebuiltVercel>) {
	const runs: { args: readonly string[]; cwd: string }[] = [];
	const bundled: (string | undefined)[] = [];
	const run: VercelBuildRunner = async (args, options) => {
		runs.push({ args, cwd: options.cwd });
		if (args[0] === "build")
			bundled.push(
				existsSync(BUNDLE) ? readFileSync(BUNDLE, "utf8") : undefined,
			);
		if (args[0] === "deploy") {
			const meta: Record<string, string> = {};
			args.forEach((arg, index) => {
				const value = args[index + 1];
				if (arg === "--meta" && value !== undefined) {
					const at = value.indexOf("=");
					meta[value.slice(0, at)] = value.slice(at + 1);
				}
			});
			vercel.state.deployments.push({
				uid: "dpl_staged",
				url: "https://hobo-ci-staged.vercel.app",
				readyState: "READY",
				target: "production",
				created: 1_794_600_000_000,
				meta,
			});
			return {
				code: 0,
				stdout: "https://hobo-ci-staged.vercel.app\n",
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	return { run, runs, bundled };
}

function relayAt(commit: string, ready = true) {
	const probed: string[] = [];
	const http: HttpTransport = async (request) => {
		probed.push(request.url);
		return {
			status: ready ? 200 : 503,
			headers: { "content-type": "application/json" },
			body: request.url.endsWith("/healthz")
				? JSON.stringify({ ok: true, commit })
				: JSON.stringify({ ready }),
		};
	};
	return { http, probed };
}

function unconfiguredRelay(commit: string) {
	const probed: string[] = [];
	const json = (status: number, body: JsonValue) => ({
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const http: HttpTransport = async (request) => {
		probed.push(request.url);
		const { pathname } = new URL(request.url);
		if (pathname === "/healthz") return json(200, { ok: true, commit });
		if (pathname === "/readyz")
			return json(503, {
				ready: false,
				started: false,
				state: "not-configured",
				missing: ["HOBO_CI_GITHUB_APP_ID", "HOBO_CI_GITHUB_APP_PRIVATE_KEY"],
				invalid: ["HOBO_CI_CONFIG_JSON"],
			});
		return json(404, {});
	};
	return { http, probed };
}

async function deploy(
	args: readonly string[],
	options: {
		readonly fetch: VercelFetch;
		readonly build: VercelBuildRunner;
		readonly env: NodeJS.ProcessEnv;
		readonly hoboHome: string;
		readonly head?: string;
		readonly probe?: HttpTransport;
		readonly sleep?: (ms: number) => Promise<void>;
		readonly now?: () => number;
		readonly credentialFetch?: typeof fetch;
	},
) {
	const deployCredentials = createTrustedVault();
	deployCredentials.put("VERCEL_TOKEN", TOKEN);
	const readDeployCredential: typeof readRelayDeployToken = async () => ({
		token: TOKEN,
		secretRef: "infisical://ci-deploy-project/prod/VERCEL_TOKEN",
		identityId: "ci-deploy-reader-identity",
		audience: RELAY_DEPLOY_READER_OIDC_AUDIENCE,
	});
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {
					...options.env,
					ACTIONS_ID_TOKEN_REQUEST_URL:
						"https://token.actions.example.test/token?api-version=2.0",
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token",
				},
				deployCredentials,
				readDeployCredential,
				ownerEntries: () => ownerStoreEntries(OWNER_STORE),
				vercelFetch: options.fetch,
				vercelBuild: options.build,
				...(options.credentialFetch !== undefined
					? { credentialFetch: options.credentialFetch }
					: undefined),
				checkoutHead: async () => options.head ?? SHA,
				hoboHome: options.hoboHome,
				probeHttp: options.probe ?? relayAt(SHA).http,
				...(options.sleep !== undefined ? { sleep: options.sleep } : undefined),
				...(options.now !== undefined ? { now: options.now } : undefined),
			}),
		},
	});
	const result = await cli.run([
		"ci",
		"deploy",
		...args,
		"--team",
		TEAM,
		"--cwd",
		relayFixtureDir,
		"--json",
	]);
	const envelope = parseJsonObject(result.stdout);
	const data = envelope.data;
	return {
		exitCode: result.exitCode,
		envelope,
		data:
			data !== undefined && !Array.isArray(data) && data !== null
				? parseJsonObject(JSON.stringify(data))
				: {},
	};
}

const ENV = { VERCEL_TEAM_ID: TEAM };
const PRODUCTION_ENV = {
	VERCEL_TEAM_ID: TEAM,
	HOBO_CI_RELAY_URL: PRODUCTION_ORIGIN,
};

async function stage(
	home: string,
	vercel: ReturnType<typeof prebuiltVercel>,
	clock: ReturnType<typeof steppingClock> = steppingClock(),
) {
	const build = fakeVercelBuild(vercel);
	const ran = await deploy([...PINNED, "--wait"], {
		fetch: vercel.fetch,
		build: build.run,
		env: ENV,
		hoboHome: home,
		...clock,
	});
	return { ran, build };
}

describe("hobo ci deploy --build prebuilt: stage on the preview node", () => {
	it("builds the checkout once, stages a production build that serves no domain, and qualifies it by its record", async () => {
		const vercel = prebuiltVercel();
		const { ran, build } = await stage(freshHome(), vercel);
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		expect(ran.data.delivery).toMatchObject({
			node: "preview",
			state: "PROMOTED",
		});
		expect(build.runs.map((r) => r.args[0])).toEqual([
			"pull",
			"build",
			"deploy",
		]);
		expect(
			build.runs.every((r) => r.cwd === REPO_ROOT.replace(/\/$/, "")),
		).toBe(true);
		const upload = build.runs[2]?.args ?? [];
		expect(upload).toEqual(
			expect.arrayContaining(["--prebuilt", "--prod", "--skip-domain"]),
		);
		expect(upload).toContain(`hoboSha=${SHA}`);
		expect(vercel.state.production).toBe("dpl_live");
		expect(vercel.state.sent.some((s) => s.includes("/promote/"))).toBe(false);
		expect(vercel.state.sent).not.toContain("POST /v13/deployments");
		expect(
			vercel.state.sent.some((s) =>
				s.includes(`/v10/projects/${PROJECT_ID}/env`),
			),
		).toBe(false);
		expect(ran.data.outputs).toMatchObject({
			deploymentId: "dpl_staged",
			build: "prebuilt",
			staged: "true",
		});
	});

	it("bundles the relay's store coordinates from the owner's store into the build only, and removes them after staging", async () => {
		const vercel = prebuiltVercel();
		const { ran, build } = await stage(freshHome(), vercel);
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		expect(build.bundled).toHaveLength(1);
		const bundled = parseJsonObject(build.bundled[0] ?? "{}");
		expect(Object.keys(bundled).sort()).toEqual([
			"endpoint",
			"environment",
			"kind",
			"projectId",
			"relayIdentityId",
			"secretPath",
		]);
		const owner = parseJsonObject(syntheticRelayBinding());
		expect(bundled.projectId).toBe(owner.projectId);
		expect(bundled.relayIdentityId).toBe(owner.relayIdentityId);
		expect(existsSync(BUNDLE)).toBe(false);
		expect(JSON.stringify(ran.envelope)).not.toContain(String(owner.projectId));
	});

	it("refuses to build a checkout at another commit, running no CLI and staging nothing", async () => {
		const vercel = prebuiltVercel();
		const build = fakeVercelBuild(vercel);
		const ran = await deploy([...PINNED, "--wait"], {
			fetch: vercel.fetch,
			build: build.run,
			env: ENV,
			hoboHome: freshHome(),
			head: "f".repeat(40),
			...steppingClock(),
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_CHECKOUT_MISMATCH",
		});
		expect(build.runs).toEqual([]);
		expect(vercel.state.deployments).toEqual([]);
	});

	it("needs --sha, and knows only git and prebuilt", async () => {
		const vercel = prebuiltVercel();
		const build = fakeVercelBuild(vercel);
		const unpinned = await deploy(
			["--repo", "example/hobo", "--ref", "main", "--build", "prebuilt"],
			{
				fetch: vercel.fetch,
				build: build.run,
				env: ENV,
				hoboHome: freshHome(),
			},
		);
		expect(unpinned.exitCode).toBe(2);
		expect(unpinned.envelope).toMatchObject({
			code: "HOBO_CLI_USAGE",
			message: expect.stringContaining("--build prebuilt needs --sha"),
		});
		const unknown = await deploy(
			[
				"--repo",
				"example/hobo",
				"--ref",
				"main",
				"--sha",
				SHA,
				"--build",
				"docker",
			],
			{
				fetch: vercel.fetch,
				build: build.run,
				env: ENV,
				hoboHome: freshHome(),
			},
		);
		expect(unknown.exitCode).toBe(2);
		expect(unknown.envelope).toMatchObject({
			code: "HOBO_CLI_USAGE",
			message: expect.stringContaining("--build is git"),
		});
		expect(vercel.state.sent).toEqual([]);
		expect(build.runs).toEqual([]);
	});
});

describe("hobo ci deploy --build prebuilt: promote the staged build to production", () => {
	it("points production at the exact build staging verified, building nothing again", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		const staged = await stage(home, vercel, clock);
		expect(staged.ran.exitCode).toBe(0);

		const build = fakeVercelBuild(vercel);
		const relay = relayAt(SHA);
		const ran = await deploy([...PINNED, "--target", "production", "--wait"], {
			fetch: vercel.fetch,
			build: build.run,
			env: PRODUCTION_ENV,
			hoboHome: home,
			probe: relay.http,
			...clock,
		});
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		expect(ran.data.delivery).toMatchObject({
			node: "production",
			state: "PROMOTED",
		});
		expect(build.runs).toEqual([]);
		expect(vercel.state.sent).toContain(
			`POST /v10/projects/${PROJECT_ID}/promote/dpl_staged`,
		);
		expect(vercel.state.production).toBe("dpl_staged");
		expect(ran.data.outputs).toMatchObject({
			deploymentId: "dpl_staged",
			promotedFrom: "dpl_live",
			readyState: "READY",
		});
		expect(relay.probed).toContain(`${PRODUCTION_ORIGIN}/readyz`);
	});

	it("rolls production back to the deployment it served before when production verification fails", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);

		const ran = await deploy([...PINNED, "--target", "production", "--wait"], {
			fetch: vercel.fetch,
			build: fakeVercelBuild(vercel).run,
			env: PRODUCTION_ENV,
			hoboHome: home,
			probe: relayAt(SHA, false).http,
			...clock,
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			code: "HOBO_CI_DEPLOY_ROLLED_BACK",
			message: expect.stringContaining("rolled back to dpl_live"),
		});
		expect(vercel.state.sent).toContain(
			`POST /v1/projects/${PROJECT_ID}/rollback/dpl_live`,
		);
		expect(vercel.state.production).toBe("dpl_live");
		expect(ran.data).toMatchObject({
			failedDeployment: "dpl_staged",
			rolledBackTo: "dpl_live",
		});
		expect(JSON.stringify(ran.envelope)).not.toContain(TOKEN);
	});
});

describe("hobo ci deploy --build prebuilt: a relay whose store lacks entries", () => {
	it("rolls back when /readyz names missing or refused entries", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);

		const ran = await deploy([...PINNED, "--target", "production", "--wait"], {
			fetch: vercel.fetch,
			build: fakeVercelBuild(vercel).run,
			env: PRODUCTION_ENV,
			hoboHome: home,
			probe: unconfiguredRelay(SHA).http,
			...clock,
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({ code: "HOBO_CI_DEPLOY_ROLLED_BACK" });
		expect(vercel.state.production).toBe("dpl_live");
	});
});

describe("hobo ci deploy --build prebuilt --dry-run", () => {
	function requestsOf(data: JsonObject): string[] {
		const plan = data.plan;
		const requests = isJsonObject(plan) ? plan.requests : undefined;
		if (!isJsonArray(requests)) return [];
		return requests.flatMap((request) =>
			isJsonObject(request) &&
			isJsonString(request.method) &&
			isJsonString(request.path)
				? [`${request.method} ${request.path}`]
				: [],
		);
	}

	it("plans staging with no store coordinate as a setting and never a git deployment", async () => {
		const vercel = prebuiltVercel();
		const build = fakeVercelBuild(vercel);
		const ran = await deploy([...PINNED, "--dry-run"], {
			fetch: vercel.fetch,
			build: build.run,
			env: ENV,
			hoboHome: freshHome(),
		});
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		const requests = requestsOf(ran.data);
		expect(requests.some((r) => r.includes("/v13/deployments"))).toBe(false);
		expect(requests.some((r) => r.includes("/env"))).toBe(false);
		expect(JSON.stringify(ran.data.plan)).not.toContain("INFISICAL");
		expect(requests.at(-1)).toMatch(/^GET \/v6\/deployments\?/);
		expect(ran.data.plan).toMatchObject({ target: "preview" });
		expect(vercel.state.sent).toEqual([]);
		expect(build.runs).toEqual([]);
	});

	it("plans production as a promotion of the staged build, with its rollback", async () => {
		const vercel = prebuiltVercel();
		const build = fakeVercelBuild(vercel);
		const ran = await deploy(
			[...PINNED, "--target", "production", "--dry-run"],
			{
				fetch: vercel.fetch,
				build: build.run,
				env: PRODUCTION_ENV,
				hoboHome: freshHome(),
			},
		);
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		const requests = requestsOf(ran.data);
		expect(requests.some((r) => r.includes("/v13/deployments"))).toBe(false);
		expect(requests.some((r) => r.includes("/env"))).toBe(false);
		expect(requests.some((r) => r.includes("/promote/"))).toBe(true);
		expect(requests.some((r) => r.includes("/rollback/"))).toBe(true);
		expect(vercel.state.sent).toEqual([]);
	});
});

describe("hobo ci deploy --build prebuilt: review guards", () => {
	it("verifies staging by the deployment record even when a preview origin is set, probing nothing", async () => {
		const vercel = prebuiltVercel();
		const probed: string[] = [];
		const ran = await deploy([...PINNED, "--wait"], {
			fetch: vercel.fetch,
			build: fakeVercelBuild(vercel).run,
			env: {
				...ENV,
				HOBO_CI_RELAY_PREVIEW_URL: "https://hobo-ci-git-main.example.test",
			},
			hoboHome: freshHome(),
			probe: async (request) => {
				probed.push(request.url);
				return { status: 200, headers: {}, body: '{"ok":true}' };
			},
			...steppingClock(),
		});
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		expect(ran.data.delivery).toMatchObject({
			node: "preview",
			state: "PROMOTED",
		});
		expect(probed).toEqual([]);
	});

	it("refuses a prebuilt dry run without --sha, before planning", async () => {
		const vercel = prebuiltVercel();
		const ran = await deploy(
			[
				"--repo",
				"example/hobo",
				"--ref",
				"main",
				"--build",
				"prebuilt",
				"--dry-run",
			],
			{
				fetch: vercel.fetch,
				build: fakeVercelBuild(vercel).run,
				env: ENV,
				hoboHome: freshHome(),
			},
		);
		expect(ran.exitCode).toBe(2);
		expect(ran.envelope).toMatchObject({ code: "HOBO_CLI_USAGE" });
	});

	it("fails production verification promptly when Vercel refuses the project read, instead of waiting as PROMOTING", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);
		let reads = 0;
		const refusing: VercelFetch = async (url, init) => {
			if (
				init.method === "GET" &&
				new URL(url).pathname.startsWith("/v9/projects/")
			) {
				reads += 1;
				if (reads > 1)
					return {
						ok: false,
						status: 403,
						async text() {
							return JSON.stringify({
								error: { code: "forbidden", message: "no" },
							});
						},
						async json() {
							return { error: { code: "forbidden", message: "no" } };
						},
					};
			}
			return vercel.fetch(url, init);
		};
		const ran = await deploy([...PINNED, "--target", "production", "--wait"], {
			fetch: refusing,
			build: fakeVercelBuild(vercel).run,
			env: PRODUCTION_ENV,
			hoboHome: home,
			probe: relayAt(SHA).http,
			...clock,
		});
		expect(ran.exitCode).toBe(1);
		expect(JSON.stringify(ran.envelope)).toContain("HTTP 403");
		expect(JSON.stringify(ran.envelope)).not.toContain("PROMOTING");
	});

	it("names the manual rollback when the build that failed was already live", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);
		vercel.state.production = "dpl_staged";
		const ran = await deploy([...PINNED, "--target", "production", "--wait"], {
			fetch: vercel.fetch,
			build: fakeVercelBuild(vercel).run,
			env: PRODUCTION_ENV,
			hoboHome: home,
			probe: relayAt(SHA, false).http,
			...clock,
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			message: expect.stringContaining(
				"roll back by hand with vercel rollback",
			),
		});
		expect(vercel.state.sent.some((s) => s.includes("/rollback/"))).toBe(false);
	});
});

describe("hobo ci deploy --build prebuilt: staged production recovery", () => {
	const STAGED_ENV = {
		...PRODUCTION_ENV,
		HOBO_CI_RELAY_STAGED_PRODUCTION: "true",
		HOBO_CI_RELAY_PUBLIC_URL: PRODUCTION_ORIGIN,
		HOBO_CI_RELAY_PREVIEW_PROBE_OIDC: "false",
	};
	const credentialFetch: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				value: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c2ln",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	const liveUnhealthy: HttpTransport = async (request) => {
		const live = request.url.startsWith(PRODUCTION_ORIGIN);
		return {
			status: live ? 503 : 200,
			headers: { "content-type": "application/json" },
			body: request.url.endsWith("/healthz")
				? JSON.stringify({ ok: !live, commit: SHA })
				: JSON.stringify({ ready: !live }),
		};
	};

	function withFault(
		vercel: ReturnType<typeof prebuiltVercel>,
		fault: "promote-error" | "promote-refused" | "read-missing" | "read-error",
	): VercelFetch {
		let promoted = false;
		let faulted = false;
		return async (url, init) => {
			const path = new URL(url).pathname;
			if (
				init.method === "POST" &&
				path === `/v10/projects/${PROJECT_ID}/promote/dpl_staged`
			) {
				promoted = true;
				const answer =
					fault === "promote-refused"
						? undefined
						: await vercel.fetch(url, init);
				if (answer !== undefined && fault !== "promote-error") return answer;
				vercel.state.sent.push(`${init.method} ${path}`);
				return {
					ok: false,
					status: 500,
					async text() {
						return JSON.stringify({
							error: { code: "internal", message: "promote failed" },
						});
					},
					async json() {
						return {};
					},
				};
			}
			if (
				promoted &&
				!faulted &&
				(fault === "read-missing" || fault === "read-error") &&
				init.method === "GET" &&
				path === `/v9/projects/${PROJECT_ID}`
			) {
				faulted = true;
				vercel.state.sent.push(`${init.method} ${path} (${fault})`);
				const body =
					fault === "read-missing"
						? { id: PROJECT_ID, name: "hobo-ci", targets: {} }
						: { error: { code: "internal", message: "read failed" } };
				const status = fault === "read-missing" ? 200 : 500;
				return {
					ok: status === 200,
					status,
					async text() {
						return JSON.stringify(body);
					},
					async json() {
						return body;
					},
				};
			}
			return vercel.fetch(url, init);
		};
	}

	async function production(
		home: string,
		clock: ReturnType<typeof steppingClock>,
		vercel: ReturnType<typeof prebuiltVercel>,
		options: { fetch?: VercelFetch; probe?: HttpTransport } = {},
	) {
		return deploy([...PINNED, "--target", "production", "--wait"], {
			fetch: options.fetch ?? vercel.fetch,
			build: fakeVercelBuild(vercel).run,
			env: STAGED_ENV,
			hoboHome: home,
			probe: options.probe ?? relayAt(SHA).http,
			credentialFetch,
			...clock,
		});
	}

	it("recovers when production already serves the staged build and the public relay is healthy", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);
		vercel.state.production = "dpl_staged";
		const ran = await production(home, clock, vercel);
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		expect(ran.envelope).toMatchObject({ ok: true, code: "HOBO_CI_DEPLOYED" });
		expect(ran.data.delivery).toMatchObject({
			node: "production",
			state: "PROMOTED",
		});
		expect(vercel.state.sent.some((line) => line.includes("/promote/"))).toBe(
			false,
		);
	});

	it("fails with explicit manual recovery when the staged build is already live and the public relay is unhealthy", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);
		vercel.state.production = "dpl_staged";
		const ran = await production(home, clock, vercel, { probe: liveUnhealthy });
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_ROLLBACK_TARGET_UNKNOWN",
		});
		expect(String(ran.envelope.message)).toContain(
			"manual recovery is required",
		);
		expect(String(ran.envelope.message)).toContain(
			"no previous production deployment was recorded",
		);
		expect(vercel.state.sent.some((line) => line.includes("/rollback/"))).toBe(
			false,
		);
	});

	it.each([
		["an unreadable promotion read-back", "read-error"],
		["a promotion read-back naming no production deployment", "read-missing"],
		["a promotion error after Vercel promoted", "promote-error"],
	] as const)("treats %s as possibly promoted, verifies the public relay, and rolls back on failure", async (_name, fault) => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);
		const ran = await production(home, clock, vercel, {
			fetch: withFault(vercel, fault),
			probe: liveUnhealthy,
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_ROLLED_BACK",
		});
		expect(vercel.state.sent).toContain(
			`POST /v10/projects/${PROJECT_ID}/promote/dpl_staged`,
		);
		expect(vercel.state.sent).toContain(
			`POST /v1/projects/${PROJECT_ID}/rollback/dpl_live`,
		);
		expect(vercel.state.production).toBe("dpl_live");
		expect(JSON.stringify(ran.envelope)).not.toContain(TOKEN);
	});

	it("refuses without rolling back when Vercel refused the promotion and production still serves the earlier build", async () => {
		const home = freshHome();
		const clock = steppingClock();
		const vercel = prebuiltVercel();
		expect((await stage(home, vercel, clock)).ran.exitCode).toBe(0);
		const ran = await production(home, clock, vercel, {
			fetch: withFault(vercel, "promote-refused"),
		});
		expect(ran.exitCode).toBe(1);
		expect(ran.envelope).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_PROMOTE_FAILED",
		});
		expect(vercel.state.production).toBe("dpl_live");
		expect(vercel.state.sent.some((line) => line.includes("/rollback/"))).toBe(
			false,
		);
	});
});
