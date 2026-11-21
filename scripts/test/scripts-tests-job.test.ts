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
import { join } from "node:path";
import {
	asList,
	asObject,
	asText,
	type JsonValue,
} from "../ci/attestation.mts";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";
import { packagesScriptsTestsImport } from "../ci/scripts-test-imports.mts";
import {
	gitLsFiles,
	readShard,
	selectShard,
} from "../lib/unit-test-selection.ts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";
import { testRunner } from "./support/test-runner.ts";

const { describe, it } = await testRunner();

// The scope step's git commands must act on the temporary repositories below,
// never on the one a pre-commit hook is committing.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

const jobs = asObject(
	workflowDocument(readFileSync(".github/workflows/hobo-ci.yml", "utf8")).jobs,
);

type Step = Readonly<{
	name: string;
	uses: string;
	run: string;
	if: string;
	timeout: JsonValue | undefined;
	with: Readonly<Record<string, JsonValue>>;
}>;
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
		timeout: source?.["timeout-minutes"],
		with: asObject(source?.with) ?? {},
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

const buildJob = job("scripts-tests-build");
const scripts = job("scripts-tests");
const gate = job("pr-gate");
const SCOPE = "Decide whether the change reaches scripts, tests or workflows";
const LANE = "Scripts tests";
const GATE_STEP = "Require successful validation and workspace tests";
const BUILD = "Build the packages the scripts tests import";

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
function scope(
	cwd: string,
	mergeGroupBase: string,
	eventName = mergeGroupBase ? "merge_group" : "pull_request",
): string {
	const output = join(cwd, ".github-output");
	writeFileSync(output, "");
	const run = spawnSync("bash", ["-c", step(scripts, SCOPE).run], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_EVENT_NAME: eventName,
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
		assert.ok(scripts.needs.includes("route"));
		assert.ok(scripts.needs.includes("ci-runner-image"));
		assert.ok(buildJob.needs.includes("ci-runner-image"));
		assert.equal(scripts.runsOn, ROUTED);
		assert.match(scripts.if, /!cancelled\(\)/u);
		assert.match(scripts.if, /github\.event_name == 'pull_request'/u);
		assert.match(scripts.if, /github\.event_name == 'merge_group'/u);
		assert.match(scripts.if, /attested-jobs.*scripts-tests/u);
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
		assert.ok(
			!scripts.steps.some((entry) => entry.name === "Save Turbo cache"),
		);
	});

	it("builds every scripts-test import root and the affected-lanes union once per run", () => {
		const build = step(buildJob, BUILD);
		assert.equal(build.if, "steps.scope.outputs.run == 'true'");
		assert.match(build.run, /turbo run build\b/u);
		assert.match(build.run, /git diff --name-only "\$BASE" HEAD/u);
		assert.match(
			build.run,
			/scripts\/ci\/affected-lanes\.mts --base="\$BASE"/u,
		);
		assert.ok(build.run.includes('"${AFFECTED[@]}"'));
		assert.match(
			build.run,
			/node --import tsx scripts\/ci\/scripts-test-imports\.mts/u,
		);
		assert.ok(build.run.includes('"${IMPORTED[@]}"'));
		const imported = packagesScriptsTestsImport();
		for (const name of [
			"@hobo/hobo",
			"@hobo/bindings",
			"@hobo/provider-vercel",
			"@hobo/adapter-infisical",
			"@hobo/secret-store-claim",
		])
			assert.ok(imported.includes(name), `the import graph misses ${name}`);
		const derived = spawnSync(
			"node",
			["--import", "tsx", "scripts/ci/scripts-test-imports.mts"],
			{ encoding: "utf8" },
		);
		assert.equal(derived.status, 0, derived.stderr);
		const filters = derived.stdout.trim().split("\n");
		for (const name of imported)
			assert.ok(
				filters.includes(`--filter=${name}...`),
				`the derived build filters miss --filter=${name}...`,
			);
		const names = buildJob.steps.map((entry) => entry.uses || entry.name);
		assert.ok(names.indexOf("Install dependencies") < names.indexOf(BUILD));
		assert.ok(scripts.needs.includes("scripts-tests-build"));
		assert.equal(
			buildJob.steps.filter((entry) => /turbo run build\b/u.test(entry.run))
				.length,
			1,
		);
		const local = step(scripts, "Build current sources for local attestation");
		assert.equal(
			local.if,
			"steps.scope.outputs.run == 'true' && env.GITHUB_ACTIONS != 'true'",
		);
		assert.match(local.run, /turbo run build\b/u);
		assert.match(local.run, /scripts\/ci\/scripts-test-imports\.mts/u);
		assert.match(
			local.run,
			/scripts\/ci\/affected-lanes\.mts --base="\$BASE"/u,
		);
		assert.ok(local.run.includes('"${IMPORTED[@]}"'));
		assert.ok(local.run.includes('"${AFFECTED[@]}"'));
		assert.ok(!scripts.steps.some((entry) => entry.name === BUILD));
	});

	it("restores older scripts caches for the build and the new build cache in every shard", () => {
		assert.equal(
			asText(step(buildJob, "Turbo cache").with["preferred-job"]),
			"scripts-tests",
		);
		assert.equal(
			asText(step(scripts, "Turbo cache").with["preferred-job"]),
			"scripts-tests-build",
		);
		assert.equal(
			step(buildJob, "Save Turbo cache").uses,
			"$/.github/actions/turbo-cache",
		);
	});

	it("keeps Turbo credentials for same-repository pull requests and withholds them from merge groups and forks", () => {
		for (const entry of [buildJob, scripts]) {
			const cache = step(entry, "Turbo cache").with;
			assert.equal(
				cache["turbo-token"],
				"${{ (github.event_name == 'pull_request' && !github.event.pull_request.head.repo.fork) && secrets.TURBO_TOKEN || '' }}",
			);
			assert.equal(
				cache["remote-mode"],
				"${{ (github.event_name == 'pull_request' && !github.event.pull_request.head.repo.fork) && 'remote:rw' || 'remote:ro' }}",
			);
		}
	});

	it("passes one nonempty dist tarball to every test shard", () => {
		const pack = step(buildJob, "Pack scripts-test build outputs");
		const upload = step(buildJob, "Upload scripts-test build outputs");
		const download = step(scripts, "Download scripts-test build outputs");
		const extract = step(scripts, "Extract scripts-test build outputs");
		assert.match(upload.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/u);
		assert.match(download.uses, /^actions\/download-artifact@[a-f0-9]{40}$/u);
		assert.equal(upload.with.name, "scripts-tests-dist-${{ github.run_id }}");
		assert.equal(upload.with.name, download.with.name);
		assert.equal(upload.with.path, "${{ runner.temp }}/scripts-tests-dist.tar");
		assert.equal(download.with.path, "${{ runner.temp }}");
		assert.equal(upload.with.overwrite, true);
		assert.equal(upload.with["if-no-files-found"], "error");
		assert.equal(upload.with["retention-days"], 1);
		assert.equal(pack.timeout, 3);
		assert.equal(upload.timeout, 3);
		assert.equal(extract.timeout, 3);
		assert.match(pack.run, /find packages external\/ts-autocode\/packages/u);
		assert.match(pack.run, /test -s "\$ARCHIVE"/u);
		assert.match(extract.run, /test -s "\$ARCHIVE"/u);
		assert.match(extract.run, /tar -xf "\$ARCHIVE" -C \./u);
		assert.equal(
			extract.if,
			"steps.scope.outputs.run == 'true' && env.GITHUB_ACTIONS == 'true'",
		);
		const buildNames = buildJob.steps.map((entry) => entry.name);
		const testNames = scripts.steps.map((entry) => entry.name);
		assert.ok(buildNames.indexOf(BUILD) < buildNames.indexOf(pack.name));
		assert.ok(buildNames.indexOf(pack.name) < buildNames.indexOf(upload.name));
		assert.ok(
			buildNames.indexOf(upload.name) < buildNames.indexOf("Save Turbo cache"),
		);
		assert.ok(
			testNames.indexOf(download.name) < testNames.indexOf(extract.name),
		);
		assert.ok(testNames.indexOf(extract.name) < testNames.indexOf(LANE));
	});

	it("round-trips the dist tarball and rejects missing or empty archives", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-scripts-dist-"));
		const source = join(root, "source");
		const target = join(root, "target");
		const runnerTemp = join(root, "runner-temp");
		const archive = join(runnerTemp, "scripts-tests-dist.tar");
		const env = { ...process.env, RUNNER_TEMP: runnerTemp };
		const extract = () =>
			spawnSync(
				"bash",
				["-c", step(scripts, "Extract scripts-test build outputs").run],
				{ cwd: target, encoding: "utf8", env },
			);
		try {
			for (const directory of [source, target, runnerTemp])
				mkdirSync(directory, { recursive: true });
			for (const file of [
				"packages/example/dist/index.js",
				"external/ts-autocode/packages/example/dist/index.js",
				"packages/example/node_modules/dependency/dist/index.js",
			]) {
				mkdirSync(join(source, file, ".."), { recursive: true });
				writeFileSync(join(source, file), "built\n");
			}
			const packed = spawnSync(
				"bash",
				["-c", step(buildJob, "Pack scripts-test build outputs").run],
				{ cwd: source, encoding: "utf8", env },
			);
			assert.equal(packed.status, 0, packed.stderr);
			const extracted = extract();
			assert.equal(extracted.status, 0, extracted.stderr);
			assert.equal(
				readFileSync(join(target, "packages/example/dist/index.js"), "utf8"),
				"built\n",
			);
			assert.equal(
				readFileSync(
					join(target, "external/ts-autocode/packages/example/dist/index.js"),
					"utf8",
				),
				"built\n",
			);
			assert.throws(() =>
				readFileSync(
					join(
						target,
						"packages/example/node_modules/dependency/dist/index.js",
					),
				),
			);
			rmSync(archive);
			assert.notEqual(extract().status, 0);
			writeFileSync(archive, "");
			assert.notEqual(extract().status, 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when the two-commit build base is empty", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-scripts-build-"));
		try {
			git(root, "init", "-q", "-b", "main");
			const run = spawnSync("bash", ["-c", step(buildJob, BUILD).run], {
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, RUNNER_TEMP: root },
			});
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /build base is empty/u);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("never waits for the deps image", () => {
		assert.ok(!scripts.needs.includes("ci-deps-image"));
		assert.ok(!buildJob.needs.includes("ci-deps-image"));
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

	it("re-verifies a fetched merge-group base in both scripts scopes", () => {
		for (const entry of [buildJob, scripts]) {
			const run = step(entry, SCOPE).run;
			assert.match(run, /if ! git cat-file -e /u);
			assert.match(
				run,
				/git fetch --no-tags --depth=1 origin "\$MERGE_GROUP_BASE_SHA"\n\s+git cat-file -e /u,
			);
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

	it("runs the lane when the merge-group base is missing", () => {
		const { root } = repository(["docs/a.md"]);
		try {
			assert.equal(scope(root, "", "merge_group"), "run=true");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is required by the PR impact gate", () => {
		assert.equal(gate.name, "PR impact gate");
		assert.ok(gate.needs.includes("scripts-tests-build"));
		assert.ok(gate.needs.includes("scripts-tests"));
		assert.match(gate.if, /always\(\)/u);
	});

	it("accepts scripts and build success or a complete verified local run", () => {
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
				for (const result of ["success", "failure", "cancelled", "skipped", ""])
					for (const buildResult of [
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
								SCRIPTS_BUILD_RESULT: buildResult,
								SCRIPTS_RESULT: result,
							},
						});
						const expected =
							(result === "success" ||
								(result === "skipped" && others === attestedAll)) &&
							(buildResult === "success" ||
								(buildResult === "skipped" && others === attestedAll));
						assert.equal(
							run.status === 0,
							expected,
							`${event} ${JSON.stringify(others)} build=${buildResult} scripts=${result}: ${run.stderr}`,
						);
						if (!expected)
							assert.match(
								run.stderr,
								/Scripts tests(?: build)? did not succeed/u,
							);
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
					SCRIPTS_BUILD_RESULT: "success",
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
