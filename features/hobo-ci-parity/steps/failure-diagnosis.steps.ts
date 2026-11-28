import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { runCiInsights } from "../../../packages/hobo/src/ci-insights.js";
import {
	githubRestFetch,
	installationCredentials,
} from "../../../packages/hobo/test/support/github-app-fake.js";
import { handleExtendedRunForItCommand } from "./parity-extended.steps.js";

const REPOSITORY = "octo/app";
const RUN_ID = 4401;
const JOB_ID = 77;
const at = "2026-11-17T08:09:14Z";

type Diagnosed = Readonly<{
	job: string;
	diagnosis: Readonly<{
		failedStep?: Readonly<{ name: string }>;
		kind: string;
		rerun: string;
		evidence: readonly string[];
	}>;
}>;

type World = {
	responses: Map<string, string>;
	asked: string[];
	fetched: string[];
	message: string;
	jobs: readonly Diagnosed[];
	realFetch: typeof globalThis.fetch | undefined;
};

const world: World = {
	responses: new Map(),
	asked: [],
	fetched: [],
	message: "",
	jobs: [],
	realFetch: undefined,
};

Before({ tags: "@I06" }, () => {
	world.responses = new Map();
	world.asked = [];
	world.fetched = [];
	world.message = "";
	world.jobs = [];
	world.realFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		world.fetched.push(String(input));
		throw new Error("no network in the parity gauntlet");
	};
});

After({ tags: "@I06" }, () => {
	if (world.realFetch !== undefined) globalThis.fetch = world.realFetch;
});

Given("a failed job and the tail of its log", () => {
	const repo = `repos/${REPOSITORY}`;
	const step = (name: string, number: number, conclusion: string) => ({
		name,
		number,
		conclusion,
		started_at: at,
		completed_at: at,
	});
	world.responses.set(
		repo,
		JSON.stringify({ private: false, default_branch: "main" }),
	);
	world.responses.set(
		`${repo}/actions/runs/${RUN_ID}`,
		JSON.stringify({
			id: RUN_ID,
			run_attempt: 1,
			name: "ci",
			path: ".github/workflows/ci.yml",
			event: "pull_request",
			head_branch: "feature",
			head_sha: "abc1234",
			status: "completed",
			conclusion: "failure",
			created_at: at,
			updated_at: at,
			display_title: "Add the mappings",
			html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
			actor: { login: "dev" },
		}),
	);
	world.responses.set(
		`${repo}/actions/runs/${RUN_ID}/attempts/1/jobs?per_page=100`,
		JSON.stringify({
			jobs: [
				{
					id: JOB_ID,
					name: "validation",
					labels: ["ubuntu-24.04"],
					runner_name: "GitHub Actions 1000028758",
					check_run_url: `https://api.github.com/${repo}/check-runs/${JOB_ID}`,
					conclusion: "failure",
					created_at: at,
					started_at: at,
					completed_at: at,
					steps: [
						step("Set up job", 1, "success"),
						step("Relevant checks only", 2, "failure"),
						step("Complete job", 3, "success"),
					],
				},
			],
		}),
	);
	world.responses.set(
		`${repo}/actions/jobs/${JOB_ID}/logs`,
		[
			"2026-11-17T08:20:01.0000000Z > pnpm exec turbo run typecheck:root",
			"2026-11-17T08:20:40.0000000Z src/map.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
			"2026-11-17T08:20:41.0000000Z  ERROR  run failed: command  exited (2)",
			"2026-11-17T08:20:41.0000000Z ##[error]Process completed with exit code 1.",
		].join("\n"),
	);
	world.responses.set(
		`${repo}/check-runs/${JOB_ID}/annotations?per_page=100`,
		JSON.stringify([{ message: "Process completed with exit code 1." }]),
	);
});

When("{string} runs for it", async (command: string) => {
	if (await handleExtendedRunForItCommand(command)) return;
	assert.equal(command, "hobo ci diagnose");
	const github = githubRestFetch((request) => {
		world.asked.push(request.path);
		return world.responses.get(request.path);
	});
	const result = await runCiInsights({
		command: "diagnose",
		repository: REPOSITORY,
		args: [String(RUN_ID)],
		options: {},
		credentials: installationCredentials(),
		fetch: github.fetch,
	});
	world.message = result.message ?? "";
	const data: Readonly<{ jobs?: readonly Diagnosed[] }> = JSON.parse(
		JSON.stringify(result.data ?? {}),
	);
	world.jobs = data.jobs ?? [];
});

Then(
	"it prints the failed step, the matched evidence and a re-run outlook",
	() => {
		assert.equal(world.jobs.length, 1);
		const [entry] = world.jobs;
		assert.ok(entry);
		assert.equal(entry.diagnosis.failedStep?.name, "Relevant checks only");
		assert.equal(entry.diagnosis.kind, "build");
		assert.equal(entry.diagnosis.rerun, "likely-fails");
		assert.ok(
			world.message.includes(
				'Failed at "Relevant checks only": looks like a build error; a re-run will likely fail the same way.',
			),
			world.message,
		);
		assert.ok(entry.diagnosis.evidence.length > 0);
		assert.ok(world.message.includes("error TS2322"), world.message);
		assert.ok(!world.message.includes("2026-11-17T08:20:40"), world.message);
	},
);

Then("no model was called", () => {
	assert.deepEqual(world.fetched, []);
	for (const path of world.asked)
		assert.ok(
			path.startsWith(`repos/${REPOSITORY}`),
			`read something other than the repository: ${path}`,
		);
});
