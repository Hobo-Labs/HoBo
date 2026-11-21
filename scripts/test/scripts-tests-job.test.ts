import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { describe, it } from "node:test";
import {
	asList,
	asObject,
	asText,
	type JsonValue,
} from "../ci/attestation.mts";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";
import {
	gitLsFiles,
	readShard,
	selectShard,
} from "../lib/unit-test-selection.ts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";

// The scope step's git commands must act on the temporary repositories below,
// never on the one a pre-commit hook is committing.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

const jobs = asObject(
	workflowDocument(readFileSync(".github/workflows/hobo-ci.yml", "utf8")).jobs,
);

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

/** The fields of one job these tests read; an absent field reads as empty. */
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

/** The routed `runs-on` expression, as the route job's other consumers use it. */
const ROUTED = "${{ needs.route.outputs.runner || 'ubuntu-24.04' }}";

const scripts = job("scripts-tests");
const gate = job("pr-gate");
const SCOPE = "Decide whether the change reaches scripts, tests or workflows";
const LANE = "Scripts tests";
const GATE_STEP = "Require successful validation and workspace tests";
const BUILD = "Build the packages the scripts tests import";

const RELATIVE_IMPORT = /(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/gu;

function packageNameAt(file: string): string | undefined {
	let dir = dirname(file);
	while (dir === "packages" || dir.startsWith("packages/")) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const name = asText(
				asObject(JSON.parse(readFileSync(manifest, "utf8")) as JsonValue)?.name,
			);
			return name ?? undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * Workspace packages a scripts test reaches through relative imports, including
 * `dist/` (scripts/ci/*.mts imports built files, not `src/`). Nested packages
 * (`packages/providers/provider-vercel`) own their own package.json.
 */
function packagesScriptsTestsImport(): readonly string[] {
	const queue = readdirSync("scripts/test")
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => join("scripts/test", name));
	const seen = new Set<string>();
	const names = new Set<string>();
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(
			RELATIVE_IMPORT,
		)) {
			const target = normalize(join(dirname(file), specifier));
			if (target.startsWith("packages/")) {
				const name = packageNameAt(target);
				if (name !== undefined) names.add(name);
				continue;
			}
			if (target.startsWith("scripts/")) {
				const source = [
					target,
					target.replace(/\.js$/u, ".ts"),
					target.replace(/\.mjs$/u, ".mts"),
				].find((candidate) => existsSync(candidate));
				if (source !== undefined) queue.push(source);
			}
		}
	}
	return [...names].sort();
}

function git(cwd: string, ...args: string[]): string {
	const run = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim();
}

/** A repository whose head commit adds `changed` on top of a base commit. */
function repository(changed: readonly string[]) {
	const root = mkdtempSync(join(tmpdir(), "hobo-scripts-scope-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "config", "user.name", "test");
	git(root, "config", "commit.gpgsign", "false");
	writeFileSync(join(root, "README.md"), "base\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "base");
	const base = git(root, "rev-parse", "HEAD");
	for (const file of changed) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), "changed\n");
	}
	git(root, "add", "-A");
	git(root, "commit", "-q", "--allow-empty", "-m", "change");
	return { root, base };
}

/** Runs the scope step in `cwd` and returns what it wrote to GITHUB_OUTPUT. */
function scope(cwd: string, mergeGroupBase: string): string {
	const output = join(cwd, ".github-output");
	writeFileSync(output, "");
	const run = spawnSync("bash", ["-c", step(scripts, SCOPE).run], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_OUTPUT: output,
			MERGE_GROUP_BASE_SHA: mergeGroupBase,
		},
	});
	assert.equal(run.status, 0, run.stderr);
	return readFileSync(output, "utf8").trim();
}

describe("the scripts lane is a pull-request gate", () => {
	it("runs pnpm run test:scripts on the routed runner for pull requests and merge groups", () => {
		assert.equal(scripts.name, "Scripts tests");
		assert.deepEqual(scripts.needs, ["route", "scripts-tests-build"]);
		assert.ok(!scripts.needs.includes("ci-runner-image"));
		assert.equal(scripts.runsOn, ROUTED);
		assert.match(scripts.if, /!cancelled\(\)/u);
		assert.match(scripts.if, /github\.event_name == 'pull_request'/u);
		assert.match(scripts.if, /github\.event_name == 'merge_group'/u);
		assert.match(scripts.if, /attested-jobs.*scripts-tests/u);
		assert.match(
			scripts.if,
			/needs\.scripts-tests-build\.result == 'success'/u,
		);
		const lane = step(scripts, LANE);
		assert.equal(
			lane.run.trim(),
			'pnpm run test:scripts --shard="$SHARD/$SHARD_TOTAL"',
		);
		assert.equal(lane.if, "steps.scope.outputs.run == 'true'");
		// The pinned toolchain (Node 24 from mise.toml) is in place first:
		// under Node 22 pnpm prints an engine warning into turbo's JSON.
		const names = scripts.steps.map((entry) => entry.uses || entry.name);
		const preflight = names.indexOf("$/.github/actions/ci-runner-preflight");
		assert.ok(preflight >= 0, "the job runs ci-runner-preflight");
		assert.ok(preflight < names.indexOf(LANE));
		assert.ok(names.indexOf(SCOPE) < names.indexOf(LANE));
	});

	it("runs all scripts test files once across the required matrix", () => {
		const source = asObject(jobs?.["scripts-tests"]);
		const strategy = asObject(source?.strategy);
		assert.equal(strategy?.["fail-fast"], false);
		const matrix = asObject(strategy?.matrix);
		const shards = asList(matrix?.shard);
		assert.ok(shards);
		assert.deepEqual(shards, [0, 1, 2, 3]);
		const steps = asList(source?.steps) ?? [];
		const lane = steps.map(asObject).find((entry) => entry?.name === LANE);
		const env = asObject(lane?.env);
		assert.equal(env?.SHARD, "${{ strategy.job-index }}");
		assert.equal(env?.SHARD_TOTAL, "${{ strategy.job-total }}");
		const files = gitLsFiles(["scripts/test/*.test.ts"]).sort();
		assert.ok(files.length > 0);
		const partitions = shards.map((_, index) => {
			const shard = readShard([`--shard=${index}/${shards.length}`]);
			assert.ok(shard);
			return selectShard(files, shard);
		});
		assert.ok(partitions.every((partition) => partition.length > 0));
		assert.deepEqual(partitions.flat().sort(), files);
		const trace = steps
			.map(asObject)
			.find((entry) => entry?.name === "CI trace");
		assert.equal(asObject(trace?.with)?.disambiguator, "${{ matrix.shard }}");
		const save = steps
			.map(asObject)
			.find((entry) => entry?.name === "Save Turbo cache");
		assert.match(asText(save?.if) ?? "", /matrix\.shard == 0/u);
	});

	it("builds affected packages from a tree diff, failing closed on an empty base", () => {
		const build = step(scripts, BUILD);
		assert.equal(build.if, "steps.scope.outputs.run == 'true'");
		assert.match(build.run, /turbo run build\b/u);
		assert.match(build.run, /turbo-scm-base\.mts/u);
		assert.match(build.run, /turbo-scm-base produced an empty base/u);
		assert.match(build.run, /affected-lanes\.mts/u);
		assert.match(build.run, /git diff --name-only "\$BASE" HEAD/u);
		assert.doesNotMatch(build.run, /--filter="\.\.\.\[\$\{BASE\}\]"/u);
		const imported = packagesScriptsTestsImport();
		assert.ok(imported.includes("@hobo/hobo"));
		assert.ok(imported.includes("@hobo/provider-vercel"));
		assert.ok(imported.includes("@hobo/adapter-infisical"));
		for (const name of imported) {
			assert.ok(
				build.run.includes(`--filter=${name}...`),
				`the no-package-change branch misses --filter=${name}...`,
			);
			assert.equal(
				build.run.includes(`--filter=${name}^...`),
				false,
				`the build step still walks dependents (^...) for ${name}`,
			);
		}
		assert.match(
			build.run,
			/No package source changed since \$\{BASE\}; materialize import-root dist from Turbo cache/u,
		);
		assert.match(build.run, /ROOTS=\(/u);
		assert.match(build.run, /"\$\{ROOTS\[@\]\}"/u);
		assert.match(build.run, /"\$\{FILTERS\[@\]\}"/u);
		const names = scripts.steps.map((entry) => entry.uses || entry.name);
		assert.ok(names.indexOf("Install dependencies") < names.indexOf(BUILD));
		assert.ok(names.indexOf("Turbo cache") < names.indexOf(BUILD));
		assert.ok(names.indexOf(BUILD) < names.indexOf(LANE));
		const prune = step(scripts, "Prune Turbo cache");
		assert.match(prune.if, /matrix\.shard == 0/u);
	});

	it("builds once per run, then shards restore that Turbo cache", () => {
		const buildJob = job("scripts-tests-build");
		assert.equal(buildJob.name, "Scripts tests build");
		assert.deepEqual(buildJob.needs, ["route"]);
		assert.equal(buildJob.runsOn, ROUTED);
		assert.doesNotMatch(buildJob.if, /attested/u);
		assert.match(buildJob.if, /github\.event_name == 'pull_request'/u);
		assert.match(buildJob.if, /github\.event_name == 'merge_group'/u);
		assert.ok(!buildJob.steps.some((entry) => entry.name === LANE));
		const build = step(buildJob, BUILD);
		assert.match(build.run, /turbo run build\b/u);
		assert.match(build.run, /--filter=@hobo\/provider-vercel\.\.\./u);
		const source = asObject(jobs?.["scripts-tests"]);
		const cache = (asList(source?.steps) ?? [])
			.map(asObject)
			.find((entry) => entry?.name === "Turbo cache");
		assert.equal(
			asText(asObject(cache?.with)?.["preferred-job"]),
			"scripts-tests-build",
		);
		const buildCache = (
			asList(asObject(jobs?.["scripts-tests-build"])?.steps) ?? []
		)
			.map(asObject)
			.find((entry) => entry?.name === "Turbo cache");
		assert.equal(
			asText(asObject(buildCache?.with)?.["preferred-job"]),
			"scripts-tests",
		);
		assert.equal(
			asObject(asObject(jobs?.["scripts-tests-build"])?.strategy)?.matrix,
			undefined,
		);
	});

	it("never waits for the deps image", () => {
		assert.ok(!scripts.needs.includes("ci-deps-image"));
	});

	for (const [changed, expected] of [
		[["scripts/ci/route-runner.mts"], "run=true"],
		[["scripts/test/route-runner.test.ts"], "run=true"],
		[["test/actions-policy.test.ts"], "run=true"],
		[[".github/workflows/hobo-ci.yml"], "run=true"],
		[["docs/ci/performance.md", "packages/ci/src/index.ts"], "run=false"],
		[["scriptsx/a.ts", "testing/a.ts", "x/.github/a.yml"], "run=false"],
	] as const)
		it(`decides ${expected} for a merge group that changes ${changed.join(", ")}`, () => {
			const { root, base } = repository(changed);
			try {
				assert.equal(scope(root, base), expected);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

	it("compares a pull request's merge commit with its first parent", () => {
		const { root, base } = repository(["docs/a.md"]);
		try {
			git(root, "checkout", "-q", "-b", "topic", base);
			mkdirSync(join(root, "scripts"));
			writeFileSync(join(root, "scripts", "a.ts"), "x\n");
			git(root, "add", "-A");
			git(root, "commit", "-q", "-m", "topic");
			git(root, "checkout", "-q", "main");
			git(root, "merge", "-q", "--no-ff", "-m", "merge", "topic");
			assert.equal(scope(root, ""), "run=true");
			git(root, "reset", "-q", "--hard", "HEAD^1");
			git(root, "checkout", "-q", "-b", "docs-only", base);
			writeFileSync(join(root, "docs.md"), "x\n");
			git(root, "add", "-A");
			git(root, "commit", "-q", "-m", "docs");
			git(root, "checkout", "-q", "main");
			git(root, "merge", "-q", "--no-ff", "-m", "merge", "docs-only");
			assert.equal(scope(root, ""), "run=false");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the lane when there is nothing to compare with", () => {
		const { root } = repository(["docs/a.md"]);
		try {
			assert.equal(scope(root, ""), "run=true");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is required by the PR impact gate", () => {
		assert.equal(gate.name, "PR impact gate");
		assert.ok(gate.needs.includes("scripts-tests"));
		assert.match(gate.if, /always\(\)/u);
	});

	it("accepts scripts success or a complete verified local run", () => {
		const script = step(gate, GATE_STEP).run;
		const passing = {
			PLAN_RESULT: "success",
			FORMAL_RESULT: "success",
			VALIDATION_RESULT: "success",
			WORKSPACE_RESULT: "success",
			ROUTE_RESULT: "success",
			ATTESTED: "",
			ATTESTED_JOBS: "",
		};
		const attestedAll = {
			PLAN_RESULT: "skipped",
			FORMAL_RESULT: "success",
			VALIDATION_RESULT: "skipped",
			WORKSPACE_RESULT: "skipped",
			ROUTE_RESULT: "success",
			ATTESTED: "true",
			ATTESTED_JOBS:
				'["pr_gate_plan","pr_gate_validation","workspace_tests","pr_affected","scripts-tests"]',
		};
		for (const [event, affected] of [
			["pull_request", "success"],
			["pull_request", "skipped"],
			["merge_group", "skipped"],
		] as const)
			for (const others of [passing, attestedAll]) {
				// A skipped affected-lanes job passes a pull request only when attested.
				if (
					event === "pull_request" &&
					affected === "skipped" &&
					others === passing
				)
					continue;
				for (const result of [
					"success",
					"failure",
					"cancelled",
					"skipped",
					"",
				]) {
					const run = spawnSync("bash", ["-c", script], {
						encoding: "utf8",
						env: {
							...process.env,
							...others,
							EVENT_NAME: event,
							AFFECTED_RESULT: affected,
							SCRIPTS_RESULT: result,
						},
					});
					const expected =
						result === "success" ||
						(result === "skipped" && others === attestedAll);
					assert.equal(
						run.status === 0,
						expected,
						`${event} ${JSON.stringify(others)} scripts=${result}: ${run.stderr}`,
					);
					if (!expected)
						assert.match(run.stderr, /Scripts tests did not succeed/u);
				}
			}
	});

	it("rejects a skipped scripts job without its own verified evidence", () => {
		const script = step(gate, GATE_STEP).run;
		for (const [route, attested, jobs] of [
			["failure", "true", '["scripts-tests"]'],
			["success", "false", '["scripts-tests"]'],
			["success", "true", '["workspace_tests"]'],
			["success", "true", '["scripts-tests-extra"]'],
		] as const) {
			const run = spawnSync("bash", ["-c", script], {
				encoding: "utf8",
				env: {
					...process.env,
					EVENT_NAME: "pull_request",
					PLAN_RESULT: "success",
					VALIDATION_RESULT: "success",
					WORKSPACE_RESULT: "success",
					AFFECTED_RESULT: "success",
					SCRIPTS_RESULT: "skipped",
					FORMAL_RESULT: "success",
					ROUTE_RESULT: route,
					ATTESTED: attested,
					ATTESTED_JOBS: jobs,
				},
			});
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /Scripts tests did not succeed/u);
		}
	});
});
