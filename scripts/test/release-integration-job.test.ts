import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	asList,
	asObject,
	asText,
	type JsonValue,
} from "../ci/attestation.mts";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";
import {
	anyPathMatchesReleaseHoboFilters,
	parseReleaseHoboMergeGroupPathFilters,
	parseReleaseHoboPullRequestPathFilters,
} from "../lib/release-hobo-path-filters.mts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";

for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

const workflow = readFileSync(".github/workflows/release-hobo.yml", "utf8");
const jobs = asObject(workflowDocument(workflow).jobs);

type Step = Readonly<{ name: string; uses: string; run: string; if: string }>;
type Job = Readonly<{
	name: string;
	needs: readonly string[];
	if: string;
	runsOn: string;
	steps: readonly Step[];
}>;

function parseStep(value: JsonValue): Step {
	const source = asObject(value);
	return {
		name: asText(source?.name) ?? "",
		uses: asText(source?.uses) ?? "",
		run: asText(source?.run) ?? "",
		if: asText(source?.if) ?? "",
	};
}

function job(id: string): Job {
	const source = asObject(jobs?.[id]);
	assert.ok(source, `missing job ${id}`);
	const single = asText(source.needs);
	return {
		name: asText(source.name) ?? "",
		needs:
			single === undefined
				? (asList(source.needs) ?? []).flatMap((entry) => asText(entry) ?? [])
				: [single],
		if: asText(source.if) ?? "",
		runsOn: asText(source["runs-on"]) ?? "",
		steps: (asList(source.steps) ?? []).map(parseStep),
	};
}

function step(entry: Job, name: string): Step {
	const found = entry.steps.find((candidate) => candidate.name === name);
	assert.ok(found, `missing step ${name}`);
	return found;
}

const integration = job("release-hobo-integration");
const gate = job("release-pr-gate");
const SCOPE = "Decide whether the diff reaches the slow integration suites";
const LANE = "HoBo slow integration suites";

function git(cwd: string, ...args: string[]): string {
	const run = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim();
}

function scopeEntries(): readonly string[] {
	const matches = [
		...workflow.matchAll(
			/scripts\/ci\/job-scope\.mts \\\n((?:\s+\S+ \\\n)+)\s+>> "\$GITHUB_OUTPUT"/g,
		),
	];
	assert.equal(matches.length, 1, "expected one job-scope invocation");
	return (matches[0]?.[1] ?? "")
		.split("\\")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

describe("the slow integration lane is a merge-group gate", () => {
	it("stays a required check on pull requests and merge groups", () => {
		assert.equal(
			integration.name,
			"HoBo slow integration suites (release gate)",
		);
		assert.match(integration.if, /github\.event_name == 'pull_request'/u);
		assert.match(integration.if, /github\.event_name == 'merge_group'/u);
		assert.ok(gate.needs.includes("release-hobo-integration"));
		const lane = step(integration, LANE);
		assert.equal(lane.if, "steps.scope.outputs.run == 'true'");
		assert.match(lane.run, /test:release-integration/u);
		assert.match(lane.run, /--shard="\$SHARD\/\$SHARD_TOTAL"/u);
		assert.doesNotMatch(lane.run, /--passWithNoTests/u);
		assert.deepEqual(integration.needs, ["route"]);
		assert.doesNotMatch(integration.if, /release-main-train-gate/u);
	});

	it("shards the four suites on GitHub-hosted runners so the merge queue does not wait for fleet slots", () => {
		const source = asObject(jobs?.["release-hobo-integration"]);
		assert.equal(integration.runsOn, "ubuntu-24.04");
		const strategy = asObject(source?.strategy);
		assert.equal(strategy?.["fail-fast"], false);
		const matrix = asObject(strategy?.matrix);
		assert.deepEqual(asList(matrix?.shard), [0, 1, 2, 3]);
		const lane = asList(source?.steps)
			?.map(asObject)
			.find((entry) => entry?.name === LANE);
		const env = asObject(lane?.env);
		assert.equal(env?.SHARD, "${{ strategy.job-index + 1 }}");
		assert.equal(env?.SHARD_TOTAL, "${{ strategy.job-total }}");
		const listed = [
			...readFileSync(
				"packages/hobo/test/support/release-integration-test-files.ts",
				"utf8",
			).matchAll(/"(test\/[^"]+)"/g),
		].map((match) => match[1]);
		assert.equal(listed.length, 4);
		assert.equal(asList(matrix?.shard)?.length, listed.length);
		const save = asList(source?.steps)
			?.map(asObject)
			.find((entry) => entry?.name === "Save Turbo cache");
		assert.match(asText(save?.if) ?? "", /matrix\.shard == 0/u);
		const prune = asList(source?.steps)
			?.map(asObject)
			.find((entry) => entry?.name === "Prune Turbo cache");
		assert.match(asText(prune?.if) ?? "", /matrix\.shard == 0/u);
	});

	it("path filters include the workflow, the four suites, this test, and job-scope", () => {
		const pullRequest = parseReleaseHoboPullRequestPathFilters(workflow);
		const mergeGroup = parseReleaseHoboMergeGroupPathFilters(workflow);
		assert.deepEqual(
			mergeGroup,
			pullRequest.filter((path) => path !== "version.json"),
		);
		assert.deepEqual(pullRequest.slice(0, 8), [
			"version.json",
			".github/workflows/release-hobo.yml",
			"packages/hobo/vitest.release-integration.config.ts",
			"packages/hobo/test/support/release-integration-test-files.ts",
			"scripts/test/release-integration*",
			"scripts/test/release-integration-job.test.ts",
			"scripts/ci/job-scope.mts",
			"scripts/test/release-freight.test.ts",
		]);
		const required = [
			".github/workflows/release-hobo.yml",
			"packages/hobo/vitest.release-integration.config.ts",
			"packages/hobo/test/support/release-integration-test-files.ts",
			"packages/hobo/test/vercel-project.test.ts",
			"packages/hobo/test/evals/ceremony-explorer.eval.test.ts",
			"packages/hobo/test/cd-runner-fleet-delivery.test.ts",
			"packages/hobo/test/cd-md-examples.test.ts",
			"scripts/test/release-integration-job.test.ts",
			"scripts/test/release-freight.test.ts",
			"scripts/ci/job-scope.mts",
		];
		for (const path of required) {
			assert.ok(
				anyPathMatchesReleaseHoboFilters([path], pullRequest),
				`pull_request.paths misses ${path}`,
			);
			assert.ok(
				anyPathMatchesReleaseHoboFilters([path], mergeGroup),
				`merge_group.paths misses ${path}`,
			);
		}
	});

	it("diffs merge_group.base_sha, not a missing HEAD^2 parent", () => {
		const run = step(integration, SCOPE).run;
		assert.match(run, /MERGE_GROUP_BASE_SHA/u);
		assert.match(run, /git diff --name-only "\$BASE" HEAD/u);
		assert.doesNotMatch(
			run,
			/HEAD is not a PR merge commit; running the lane/u,
		);
	});

	it("skips the real entries when the diff cannot reach them, and runs when it can", () => {
		const entries = scopeEntries();
		assert.ok(entries.includes("packages/hobo/test/vercel-project.test.ts"));
		assert.ok(
			!entries.includes(
				"packages/hobo/test/evals/ceremony-explorer.eval.test.ts",
			),
			"that file's relative import fail-closes the walk, so skip never happens",
		);
		assert.ok(
			!entries.includes("packages/hobo/test/cd-runner-fleet-delivery.test.ts"),
			"that file reaches a computed import() and fail-closes the walk",
		);
		const skip = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"scripts/ci/job-scope.mts",
				...entries,
			],
			{
				input: "docs/a.md\n",
				encoding: "utf8",
				stdio: ["pipe", "pipe", "ignore"],
			},
		);
		assert.equal(
			skip,
			"run=false\n",
			"docs-only skip proves the surviving entries' walk is scoped; an unscoped walk would always run",
		);
		for (const path of [
			"packages/hobo/src/index.ts",
			"packages/hobo/test/evals/ceremony-explorer.eval.test.ts",
			"packages/hobo/test/cd-runner-fleet-delivery.test.ts",
		]) {
			const run = execFileSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					"scripts/ci/job-scope.mts",
					...entries,
				],
				{
					input: `${path}\n`,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "ignore"],
				},
			);
			assert.equal(run, "run=true\n", path);
		}
	});

	it("runs the lane when there is nothing to compare with", () => {
		const root = mkdtempSync(
			join(tmpdir(), "hobo-release-integration-nobase-"),
		);
		try {
			git(root, "init", "-q", "-b", "main");
			git(root, "config", "user.email", "test@example.invalid");
			git(root, "config", "user.name", "test");
			git(root, "config", "commit.gpgsign", "false");
			writeFileSync(join(root, "README.md"), "base\n");
			git(root, "add", "-A");
			git(root, "commit", "-q", "-m", "base");
			const output = join(root, ".github-output");
			writeFileSync(output, "");
			const run = spawnSync("bash", ["-c", step(integration, SCOPE).run], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					GITHUB_OUTPUT: output,
					MERGE_GROUP_BASE_SHA: "",
				},
			});
			assert.equal(run.status, 0, run.stderr);
			assert.match(readFileSync(output, "utf8"), /^run=true$/mu);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
