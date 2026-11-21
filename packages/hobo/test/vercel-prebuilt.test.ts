import { describe, expect, it } from "vitest";

import type {
	VercelClient,
	VercelProjectDeployment,
} from "../src/vercel-client.js";
import {
	promoteStagedBuild,
	servesProduction,
	stageVercelBuild,
	VERCEL_PREBUILT_REFUSAL,
	type VercelBuildRunner,
	vercelBuildEnvironment,
} from "../src/vercel-prebuilt.js";

// Build once, promote the same build: the build runs in the Freight's
// checkout, the upload is a staged production deployment found by its meta,
// and production is pointed at that exact deployment with no rebuild.
// NO network and NO CLI: the client and the runner are fakes.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const FREIGHT = "frt_relay_0123";
const PROJECT_ID = "prj_relay";

function fakeClient(state: {
	deployments: VercelProjectDeployment[];
	production?: string;
	promoteRefusal?: Error;
}) {
	const calls: string[] = [];
	const client: VercelClient = {
		async readProject(project) {
			calls.push(`read ${project}`);
			return {
				id: PROJECT_ID,
				...(state.production !== undefined
					? { productionDeploymentId: state.production }
					: undefined),
			};
		},
		async listProjectDeployments(input) {
			calls.push(`list ${input.project} ${input.target ?? "any"}`);
			return state.deployments;
		},
		async promoteDeployment(project, deploymentId) {
			calls.push(`promote ${project} ${deploymentId}`);
			if (state.promoteRefusal) throw state.promoteRefusal;
			state.production = deploymentId;
		},
		async rollbackProduction(project, deploymentId) {
			calls.push(`rollback ${project} ${deploymentId}`);
			state.production = deploymentId;
		},
		async getDeployment() {
			throw new Error("not used");
		},
		async deleteDeployment() {
			throw new Error("not used");
		},
		async createDeployment() {
			throw new Error(
				"not used: a prebuilt delivery never asks Vercel to build",
			);
		},
		async setProjectEnv() {
			throw new Error("not used");
		},
		async createProject() {
			throw new Error("not used");
		},
	};
	return { client, calls };
}

function staged(
	overrides: Partial<VercelProjectDeployment> = {},
): VercelProjectDeployment {
	return {
		id: "dpl_staged",
		url: "https://hobo-ci-staged.vercel.app",
		readyState: "READY",
		target: "production",
		createdAt: 2,
		meta: { hoboFreight: FREIGHT, hoboSha: SHA },
		...overrides,
	};
}

function recordingRunner(
	exitCodes: Readonly<Record<string, number>> = {},
	onDeploy?: () => void,
) {
	const runs: { args: readonly string[]; cwd: string }[] = [];
	const run: VercelBuildRunner = async (args, options) => {
		runs.push({ args, cwd: options.cwd });
		const code = exitCodes[args[0] ?? ""] ?? 0;
		if (args[0] === "deploy" && code === 0) onDeploy?.();
		return {
			code,
			stdout: "",
			stderr: code === 0 ? "" : `${args[0]} exploded\nline two`,
		};
	};
	return { run, runs };
}

describe("staging a Freight's build", () => {
	it("pulls, builds and uploads a staged production build in the checkout, tagged with the Freight", async () => {
		const state = { deployments: [] as VercelProjectDeployment[] };
		const { client } = fakeClient(state);
		const runner = recordingRunner({}, () => state.deployments.push(staged()));
		const result = await stageVercelBuild({
			run: runner.run,
			client,
			project: "hobo-ci",
			cwd: "/repo",
			head: `${SHA}\n`,
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toEqual({ ok: true, deployment: staged() });
		expect(runner.runs.map((r) => r.args)).toEqual([
			["pull", "--yes", "--environment=production"],
			["build", "--prod", "--yes"],
			[
				"deploy",
				"--prebuilt",
				"--prod",
				"--skip-domain",
				"--yes",
				"--meta",
				`hoboFreight=${FREIGHT}`,
				"--meta",
				`hoboSha=${SHA}`,
			],
		]);
		expect(runner.runs.every((r) => r.cwd === "/repo")).toBe(true);
	});

	it("refuses to build a checkout that is not at the Freight's commit, running nothing", async () => {
		const { client } = fakeClient({ deployments: [] });
		const runner = recordingRunner();
		const result = await stageVercelBuild({
			run: runner.run,
			client,
			project: "hobo-ci",
			cwd: "/repo",
			head: "f".repeat(40),
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.checkoutMismatch,
		});
		expect(runner.runs).toHaveLength(0);
	});

	it("stops at the first failing step and says which, with the end of its output", async () => {
		const { client } = fakeClient({ deployments: [] });
		const runner = recordingRunner({ build: 2 });
		const result = await stageVercelBuild({
			run: runner.run,
			client,
			project: "hobo-ci",
			cwd: "/repo",
			head: SHA,
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.buildFailed,
		});
		expect(result.ok ? "" : result.message).toContain("build exploded");
		expect(runner.runs.map((r) => r.args[0])).toEqual(["pull", "build"]);
	});

	it("fails when the upload reports success but no build carries the Freight", async () => {
		const { client } = fakeClient({ deployments: [] });
		const runner = recordingRunner();
		const result = await stageVercelBuild({
			run: runner.run,
			client,
			project: "hobo-ci",
			cwd: "/repo",
			head: SHA,
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.stageFailed,
		});
	});
});

describe("promoting the staged build", () => {
	it("points production at the newest build staged for the Freight, by the canonical project id, and names what it replaced", async () => {
		const state = {
			deployments: [
				staged({ id: "dpl_older", createdAt: 1 }),
				staged(),
				staged({
					id: "dpl_other",
					meta: { hoboFreight: "frt_other", hoboSha: SHA },
				}),
			],
			production: "dpl_live",
		};
		const { client, calls } = fakeClient(state);
		const result = await promoteStagedBuild({
			client,
			project: "hobo-ci",
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toEqual({
			ok: true,
			deployment: staged(),
			projectId: PROJECT_ID,
			previousDeploymentId: "dpl_live",
		});
		expect(calls).toContain(`promote ${PROJECT_ID} dpl_staged`);
		expect(await servesProduction(client, "hobo-ci", "dpl_staged")).toBe(true);
	});

	it("does nothing when production already serves the staged build", async () => {
		const { client, calls } = fakeClient({
			deployments: [staged()],
			production: "dpl_staged",
		});
		const result = await promoteStagedBuild({
			client,
			project: "hobo-ci",
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toMatchObject({ ok: true, projectId: PROJECT_ID });
		expect(result.ok && "previousDeploymentId" in result).toBe(false);
		expect(calls.some((call) => call.startsWith("promote"))).toBe(false);
	});

	it("refuses to promote when nothing was staged for the Freight: production never builds", async () => {
		const { client, calls } = fakeClient({ deployments: [] });
		const result = await promoteStagedBuild({
			client,
			project: "hobo-ci",
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.notStaged,
		});
		expect(calls.some((call) => call.startsWith("promote"))).toBe(false);
	});

	it("refuses a staged build of another commit, or one not READY", async () => {
		const wrongCommit = fakeClient({
			deployments: [
				staged({ meta: { hoboFreight: FREIGHT, hoboSha: "e".repeat(40) } }),
			],
		});
		expect(
			await promoteStagedBuild({
				client: wrongCommit.client,
				project: "hobo-ci",
				freightId: FREIGHT,
				sha: SHA,
				emit: () => {},
			}),
		).toMatchObject({ ok: false, code: VERCEL_PREBUILT_REFUSAL.notStaged });
		const building = fakeClient({
			deployments: [staged({ readyState: "BUILDING" })],
		});
		expect(
			await promoteStagedBuild({
				client: building.client,
				project: "hobo-ci",
				freightId: FREIGHT,
				sha: SHA,
				emit: () => {},
			}),
		).toMatchObject({
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.stagedNotReady,
		});
	});

	it("reports Vercel's refusal to promote as a typed failure", async () => {
		const { client } = fakeClient({
			deployments: [staged()],
			production: "dpl_live",
			promoteRefusal: new Error("409 deployment_not_ready"),
		});
		const result = await promoteStagedBuild({
			client,
			project: "hobo-ci",
			freightId: FREIGHT,
			sha: SHA,
			emit: () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			code: VERCEL_PREBUILT_REFUSAL.promoteFailed,
		});
	});
});

describe("the CLI's environment", () => {
	it("drops every credential-looking variable and Vercel's own, then adds the deploy coordinates", () => {
		const env = vercelBuildEnvironment(
			{
				PATH: "/bin",
				HOME: "/home/runner",
				PNPM_HOME: "/pnpm",
				GITHUB_TOKEN: "ghs_secret",
				NPM_AUTH: "x",
				SOME_API_KEY: "k",
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc",
				VERCEL_TOKEN: "stale",
				UNDEFINED: undefined,
			},
			{ VERCEL_TOKEN: "fresh", VERCEL_PROJECT_ID: "hobo-ci" },
		);
		expect(env).toEqual({
			PATH: "/bin",
			HOME: "/home/runner",
			PNPM_HOME: "/pnpm",
			NO_COLOR: "1",
			CI: "1",
			VERCEL_TOKEN: "fresh",
			VERCEL_PROJECT_ID: "hobo-ci",
		});
	});
});
