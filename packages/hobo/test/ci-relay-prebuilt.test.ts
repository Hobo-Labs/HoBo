import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHoboCli } from "@hobo/cli";
import type { HttpTransport } from "@hobo/core";
import { createTrustedVault } from "@hobo/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCiCommand } from "../src/ci-command.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "../src/json.js";
import type { VercelFetch } from "../src/vercel-client.js";
import type { VercelBuildRunner } from "../src/vercel-prebuilt.js";

// `hobo ci deploy --build prebuilt` against the REAL relay declaration, through
// the CLI shell and @hobo/cd (Freight, the relay pipeline, the gate and the
// conductor) on a temporary journal. HoBo builds the checkout once and stages
// it; production promotes that same build, and a production verification that
// fails rolls production back. Vercel is never asked to build from Git.
// NO network and NO CLI: Vercel and the Vercel CLI are scripted fakes.

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
const INPUTS = [
	"--set",
	"INFISICAL_IDENTITY_ID=3f2b1c9e-8a7d-4e6f-9b0c-1d2e3f4a5b6c",
	"--set",
	"INFISICAL_PROJECT_ID=6512a1b0-c3d4-4e5f-8071-8293a4b5c6d7",
	"--set",
	"INFISICAL_SITE_URL=https://app.infisical.com",
];
const PRODUCTION_ORIGIN = "https://relay.example.test";

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

// Vercel as a prebuilt delivery sees it: the project, its deployment list,
// each deployment, its environment settings, promote and rollback. A
// request to build from Git (POST /v13/deployments) is an error.
function prebuiltVercel(initial: { production?: string } = {}) {
	const state = {
		production: initial.production ?? "dpl_live",
		deployments: [] as Deployment[],
		sent: [] as string[],
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

// The Vercel CLI: pull and build succeed; deploy stages a production build
// carrying the meta it was given, as Vercel lists it afterwards.
function fakeVercelBuild(vercel: ReturnType<typeof prebuiltVercel>) {
	const runs: { args: readonly string[]; cwd: string }[] = [];
	const run: VercelBuildRunner = async (args, options) => {
		runs.push({ args, cwd: options.cwd });
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
	return { run, runs };
}

// The relay at its production origin: /healthz names the commit it serves.
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
	},
) {
	const deployCredentials = createTrustedVault();
	deployCredentials.put("VERCEL_TOKEN", TOKEN);
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: options.env,
				deployCredentials,
				vercelFetch: options.fetch,
				vercelBuild: options.build,
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
		RELAY_DIR,
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
	const ran = await deploy([...PINNED, ...INPUTS, "--wait"], {
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
		// Staging promotes nothing, and Vercel built nothing from Git.
		expect(vercel.state.production).toBe("dpl_live");
		expect(vercel.state.sent.some((s) => s.includes("/promote/"))).toBe(false);
		expect(vercel.state.sent).not.toContain("POST /v13/deployments");
		// Production's settings, set before the build pulls them.
		expect(vercel.state.sent).toContain(`GET /v10/projects/${PROJECT_ID}/env`);
		expect(ran.data.outputs).toMatchObject({
			deploymentId: "dpl_staged",
			build: "prebuilt",
			staged: "true",
		});
	});

	it("refuses to build a checkout at another commit, running no CLI and staging nothing", async () => {
		const vercel = prebuiltVercel();
		const build = fakeVercelBuild(vercel);
		const ran = await deploy([...PINNED, ...INPUTS, "--wait"], {
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
		const ran = await deploy(
			[...PINNED, ...INPUTS, "--target", "production", "--wait"],
			{
				fetch: vercel.fetch,
				build: build.run,
				env: PRODUCTION_ENV,
				hoboHome: home,
				probe: relay.http,
				...clock,
			},
		);
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

		const ran = await deploy(
			[...PINNED, ...INPUTS, "--target", "production", "--wait"],
			{
				fetch: vercel.fetch,
				build: fakeVercelBuild(vercel).run,
				env: PRODUCTION_ENV,
				hoboHome: home,
				// The promoted build never answers ready at the production origin.
				probe: relayAt(SHA, false).http,
				...clock,
			},
		);
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

	it("plans staging with production's settings and never a git deployment", async () => {
		const vercel = prebuiltVercel();
		const build = fakeVercelBuild(vercel);
		const ran = await deploy([...PINNED, ...INPUTS, "--dry-run"], {
			fetch: vercel.fetch,
			build: build.run,
			env: ENV,
			hoboHome: freshHome(),
		});
		expect(ran.exitCode, JSON.stringify(ran.envelope)).toBe(0);
		const requests = requestsOf(ran.data);
		expect(requests.some((r) => r.includes("/v13/deployments"))).toBe(false);
		expect(requests).toContain(
			"GET /v10/projects/hobo-ci/env?teamId=team_hobo",
		);
		expect(requests.at(-1)).toMatch(/^GET \/v6\/deployments\?/);
		expect(ran.data.plan).toMatchObject({ target: "preview" });
		expect(vercel.state.sent).toEqual([]);
		expect(build.runs).toEqual([]);
	});

	it("plans production as a promotion of the staged build, with its rollback", async () => {
		const vercel = prebuiltVercel();
		const build = fakeVercelBuild(vercel);
		const ran = await deploy(
			[...PINNED, ...INPUTS, "--target", "production", "--dry-run"],
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
