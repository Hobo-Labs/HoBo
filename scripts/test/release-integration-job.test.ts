import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import {
	asList,
	asObject,
	asText,
	type JsonValue,
} from "../ci/attestation.mts";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";

for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

type Step = Readonly<{
	name: string;
	run: string;
	if: string;
	env: Readonly<Record<string, string>>;
}>;
type Job = Readonly<{
	if: string;
	needs: readonly string[];
	runsOn: string;
	timeout: number;
	shards: readonly number[];
	steps: readonly Step[];
}>;
type Workflow = Readonly<{
	text: string;
	document: ReturnType<typeof workflowDocument>;
}>;

const readWorkflow = (name: string): Workflow => {
	const text = readFileSync(`.github/workflows/${name}`, "utf8");
	return { text, document: workflowDocument(text) };
};
const pr = readWorkflow("release-hobo-pr.yml");
const train = readWorkflow("release-hobo.yml");
const fabric = readWorkflow("hobo-ci.yml");

function step(value: JsonValue): Step {
	const source = asObject(value);
	return {
		name: asText(source?.name) ?? "",
		run: asText(source?.run) ?? "",
		if: asText(source?.if) ?? "",
		env: Object.fromEntries(
			Object.entries(asObject(source?.env) ?? {}).flatMap(([key, value]) => {
				const text = asText(value);
				return text === undefined ? [] : [[key, text]];
			}),
		),
	};
}

function job(workflow: Workflow, id: string): Job {
	const source = asObject(asObject(workflow.document.jobs)?.[id]);
	assert.ok(source, `missing ${id}`);
	const needs = asText(source.needs);
	return {
		if: asText(source.if) ?? "",
		needs:
			needs === undefined
				? (asList(source.needs) ?? []).flatMap((entry) => asText(entry) ?? [])
				: [needs],
		runsOn: asText(source["runs-on"]) ?? "",
		timeout: Number(source["timeout-minutes"]),
		shards: (
			asList(asObject(asObject(source.strategy)?.matrix)?.shard) ?? []
		).map((value) => Number(value)),
		steps: (asList(source.steps) ?? []).map(step),
	};
}

function namedStep(entry: Job, name: string): Step {
	const found = entry.steps.find((candidate) => candidate.name === name);
	assert.ok(found, `missing step ${name}`);
	return found;
}

function trigger(workflow: Workflow, name: string): JsonValue {
	const triggers = asObject(workflow.document.on);
	assert.ok(
		triggers && Object.hasOwn(triggers, name),
		`missing trigger ${name}`,
	);
	const value = triggers[name];
	assert.ok(value !== undefined, `trigger ${name} has no value`);
	return value;
}

function jobName(workflow: Workflow, id: string): string | undefined {
	return asText(asObject(asObject(workflow.document.jobs)?.[id])?.name);
}

const laneBuildDependencies = (
	asList(
		asObject(
			asObject(
				asObject(JSON.parse(readFileSync("turbo.json", "utf8")))?.tasks,
			)?.["@hobo/hobo#test:release-integration"],
		)?.dependsOn,
	) ?? []
).flatMap((entry) => {
	const text = asText(entry);
	return text?.endsWith("#build") ? [text.slice(0, -"#build".length)] : [];
});

const integrationJobs = [
	["new workflow", pr, "release-integration"],
	["release train", train, "release-hobo-integration"],
	["Fabric shim", fabric, "release-hobo-integration"],
] as const;

function git(cwd: string, ...args: string[]): string {
	const run = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim();
}

function copy(root: string, path: string, contents?: string): void {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents ?? readFileSync(path, "utf8"));
}

function scopeRepository() {
	const root = mkdtempSync(join(tmpdir(), "hobo-release-scope-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "config", "user.name", "test");
	git(root, "config", "commit.gpgsign", "false");
	for (const path of [
		"scripts/ci/job-scope.mts",
		"scripts/ci/affected-lanes.mts",
		"scripts/lib/read-stdin.mts",
	])
		copy(root, path);
	copy(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
	copy(root, "packages/hobo/package.json", '{"name":"@hobo/hobo"}\n');
	for (const path of [
		".github/workflows/release-hobo-pr.yml",
		"scripts/test/release-integration-job.test.ts",
		"packages/hobo/vitest.release-integration.config.ts",
		"packages/hobo/test/support/release-integration-test-files.ts",
		"packages/hobo/test/vercel-project.test.ts",
		"packages/hobo/test/evals/ceremony-explorer.eval.test.ts",
		"packages/hobo/test/cd-runner-fleet-delivery.test.ts",
		"packages/hobo/test/cd-md-examples.test.ts",
	])
		copy(root, path, "\n");
	writeFileSync(join(root, "README.md"), "base\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "base");
	const base = git(root, "rev-parse", "HEAD");
	writeFileSync(join(root, "README.md"), "changed\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "docs");
	return { root, base };
}

function runScope(root: string, base: string, path = process.env.PATH) {
	const output = join(root, "github-output");
	writeFileSync(output, "");
	const run = spawnSync(
		"bash",
		[
			"-c",
			namedStep(
				job(pr, "release-integration"),
				"Decide whether the diff reaches the slow integration suites",
			).run,
		],
		{
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_OUTPUT: output,
				MERGE_GROUP_BASE_SHA: base,
				PATH: path,
			},
		},
	);
	return { ...run, output: readFileSync(output, "utf8").trim() };
}

describe("release integration pull-request and merge-queue lane", () => {
	it("runs for pull requests without path or branch filters and for merge groups", () => {
		const pullRequest = asObject(trigger(pr, "pull_request"));
		assert.deepEqual(asList(pullRequest?.types), [
			"opened",
			"synchronize",
			"reopened",
			"ready_for_review",
		]);
		assert.equal(pullRequest?.paths, undefined);
		assert.equal(pullRequest?.branches, undefined);
		assert.equal(trigger(pr, "merge_group"), null);
	});

	it("runs four hosted shards with bash-derived one-based indexes everywhere it is shimmed", () => {
		for (const [label, workflow, id] of integrationJobs) {
			const entry = job(workflow, id);
			assert.equal(entry.runsOn, "ubuntu-24.04", label);
			assert.equal(entry.timeout, 20, label);
			assert.deepEqual(entry.shards, [0, 1, 2, 3], label);
			const build = namedStep(entry, "Build HoBo integration dependencies");
			assert.match(
				build.run,
				/turbo run build --filter=@hobo\/hobo\.\.\./u,
				label,
			);
			for (const dependency of laneBuildDependencies)
				assert.ok(
					build.run.includes(`--filter=${dependency}...`),
					`${label}: ${dependency}`,
				);
			const lane = namedStep(entry, "HoBo slow integration suites");
			assert.ok(entry.steps.indexOf(build) < entry.steps.indexOf(lane), label);
			assert.match(
				lane.run,
				/^pnpm --filter @hobo\/hobo run test:release-integration /u,
				label,
			);
			assert.doesNotMatch(lane.run, /turbo/u, label);
			assert.equal(lane.env.SHARD_INDEX, "${{ matrix.shard }}", label);
			assert.match(lane.run, /\$\(\(SHARD_INDEX \+ 1\)\)\/4/u, label);
			assert.doesNotMatch(
				lane.run,
				/strategy\.job-index|passWithNoTests/u,
				label,
			);
		}
	});

	it("starts the train lane on pull requests and tags, never on merge groups or ordinary branch pushes", () => {
		const entry = job(train, "release-hobo-integration");
		assert.match(entry.if, /github\.event_name == 'pull_request'/u);
		assert.match(entry.if, /github\.event_name != 'merge_group'/u);
		assert.doesNotMatch(entry.if, /github\.event_name == 'push'/u);
		const push = asObject(trigger(train, "push"));
		assert.equal(push?.branches, undefined);
		assert.deepEqual(asList(push?.tags), ["sdk-v*", "cli-v*"]);
		assert.doesNotMatch(
			job(train, "release-integration-measure-gate").if,
			/github\.event_name == 'push'/u,
		);
	});

	it("keeps Turbo credentials for same-repository pull requests and withholds them from merge groups and forks", () => {
		const token =
			"turbo-token: ${{ (github.event_name == 'pull_request' && !github.event.pull_request.head.repo.fork) && secrets.TURBO_TOKEN || '' }}";
		const remote =
			"remote-mode: ${{ (github.event_name == 'pull_request' && !github.event.pull_request.head.repo.fork) && 'remote:rw' || 'remote:ro' }}";
		for (const workflow of [pr, train, fabric]) {
			assert.ok(workflow.text.includes(token));
			assert.ok(workflow.text.includes(remote));
			assert.doesNotMatch(
				workflow.text,
				/github\.event\.pull_request\.head\.repo\.fork && '' \|\| secrets\.TURBO_TOKEN/u,
			);
			assert.doesNotMatch(
				workflow.text,
				/github\.event\.pull_request\.head\.repo\.fork && 'remote:ro' \|\| 'remote:rw'/u,
			);
		}
	});

	it("keeps the Fabric shim pull-request-only and outside the required Fabric gate", () => {
		const entry = job(fabric, "release-hobo-integration");
		assert.match(entry.if, /github\.event_name == 'pull_request'/u);
		assert.doesNotMatch(entry.if, /github\.event_name == 'merge_group'/u);
		assert.ok(
			!job(fabric, "pr-gate").needs.includes("release-hobo-integration"),
		);
	});

	it("includes the new lane, scope implementation and every suite in both train path filters", () => {
		const required = [
			".github/workflows/release-hobo-pr.yml",
			"scripts/ci/job-scope.mts",
			"scripts/test/release-integration-job.test.ts",
			"packages/hobo/vitest.release-integration.config.ts",
			"packages/hobo/test/support/release-integration-test-files.ts",
			"packages/hobo/test/vercel-project.test.ts",
			"packages/hobo/test/evals/ceremony-explorer.eval.test.ts",
			"packages/hobo/test/cd-runner-fleet-delivery.test.ts",
			"packages/hobo/test/cd-md-examples.test.ts",
		];
		for (const event of ["pull_request", "merge_group"]) {
			const paths = (asList(asObject(trigger(train, event))?.paths) ?? []).map(
				(value) => asText(value),
			);
			for (const path of required)
				assert.ok(paths.includes(path), `${event}: ${path}`);
		}
	});

	it("scopes merge groups from base_sha and skips only a successfully computed out-of-scope diff", () => {
		const scope = namedStep(
			job(pr, "release-integration"),
			"Decide whether the diff reaches the slow integration suites",
		);
		assert.equal(
			scope.env.MERGE_GROUP_BASE_SHA,
			"${{ github.event.merge_group.base_sha }}",
		);
		for (const [, workflow, id] of integrationJobs.slice(1))
			assert.equal(
				namedStep(
					job(workflow, id),
					"Decide whether the diff reaches the slow integration suites",
				).run,
				scope.run,
			);
		const { root, base } = scopeRepository();
		try {
			const run = runScope(root, base);
			assert.equal(run.status, 0, run.stderr);
			assert.equal(run.output, "run=false");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		for (const name of [
			"Fetch pinned ts-autocode",
			"Link deps layer or install",
			"HoBo slow integration suites",
		])
			assert.equal(
				namedStep(job(pr, "release-integration"), name).if,
				"steps.scope.outputs.run == 'true'",
			);
	});

	it("fails scope when a merge-group base cannot be fetched or verified", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-release-bad-base-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		try {
			for (const fetchStatus of [1, 0]) {
				writeFileSync(
					join(bin, "git"),
					`#!/bin/sh\ncase "$1" in\n  cat-file) exit 1;;\n  fetch) exit ${fetchStatus};;\n  diff) exit 0;;\n  *) exit 1;;\nesac\n`,
					{ mode: 0o755 },
				);
				const run = runScope(
					root,
					"a".repeat(40),
					`${bin}:${process.env.PATH ?? ""}`,
				);
				assert.notEqual(run.status, 0, `fetch status ${fetchStatus}`);
				assert.equal(run.output, "");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the lane when the merge-group base is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-release-no-base-"));
		try {
			const run = runScope(root, "");
			assert.equal(run.status, 0, run.stderr);
			assert.equal(run.output, "run=true");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the integration-only gate name without taking the protected release gate name", () => {
		const newGate = job(pr, "release-integration-gate");
		const measureGate = job(train, "release-integration-measure-gate");
		assert.equal(
			jobName(pr, "release-integration-gate"),
			"HoBo release integration PR gate",
		);
		assert.equal(
			jobName(train, "release-integration-measure-gate"),
			"HoBo release integration PR gate",
		);
		assert.deepEqual(newGate.needs, ["release-integration"]);
		assert.deepEqual(measureGate.needs, ["release-hobo-integration"]);
		assert.match(newGate.if, /always\(\)/u);
		assert.match(measureGate.if, /always\(\)/u);
		assert.equal(
			jobName(train, "release-pr-gate"),
			"HoBo release PR gate (required)",
		);
		assert.doesNotMatch(
			newGate.if + measureGate.if,
			/release PR gate \(required\)/u,
		);
	});

	it("rejects skipped release integration shards even for a draft", () => {
		const run = (script: string, env: Record<string, string>) =>
			spawnSync("bash", ["-c", script], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
		for (const [workflow, id] of [
			[pr, "release-integration-gate"],
			[train, "release-integration-measure-gate"],
		] as const) {
			const gate = namedStep(
				job(workflow, id),
				"Require successful release integration shards",
			);
			for (const env of [
				{
					GITHUB_EVENT_NAME: "pull_request",
					PULL_REQUEST_DRAFT: "true",
					INTEGRATION_RESULT: "skipped",
				},
				{
					GITHUB_EVENT_NAME: "pull_request",
					PULL_REQUEST_DRAFT: "false",
					INTEGRATION_RESULT: "skipped",
				},
				{
					GITHUB_EVENT_NAME: "pull_request",
					PULL_REQUEST_DRAFT: "true",
					INTEGRATION_RESULT: "failure",
				},
				{
					GITHUB_EVENT_NAME: "merge_group",
					PULL_REQUEST_DRAFT: "true",
					INTEGRATION_RESULT: "skipped",
				},
			]) {
				const rejected = run(gate.run, env);
				assert.notEqual(rejected.status, 0, `${id}: ${JSON.stringify(env)}`);
				assert.match(rejected.stdout, /must pass/u);
			}
		}
	});

	it("fails both integration-only gates on cancelled, skipped, failed, or missing results", () => {
		for (const [workflow, id] of [
			[pr, "release-integration-gate"],
			[train, "release-integration-measure-gate"],
		] as const) {
			const gate = namedStep(
				job(workflow, id),
				"Require successful release integration shards",
			);
			for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
				const run = spawnSync("bash", ["-c", gate.run], {
					encoding: "utf8",
					env: {
						...process.env,
						GITHUB_EVENT_NAME: "pull_request",
						PULL_REQUEST_DRAFT: "false",
						INTEGRATION_RESULT: result,
					},
				});
				assert.equal(
					run.status === 0,
					result === "success",
					`${id}: ${result}`,
				);
			}
		}
	});

	it("pins every third-party action in the new workflow", () => {
		for (const match of pr.text.matchAll(/uses:\s*([^\s]+)/g)) {
			const uses = match[1] ?? "";
			if (!uses.startsWith("$/")) assert.match(uses, /@[0-9a-f]{40}$/u, uses);
		}
	});
});
