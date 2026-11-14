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

/**
 * The workspace packages whose `src/` a scripts test reaches through relative
 * imports, directly or through other files under scripts/. Their sources import
 * other workspace packages, which resolve through those packages' built dist/.
 */
function packagesScriptsTestsImport(): readonly string[] {
	const queue = readdirSync("scripts/test")
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => join("scripts/test", name));
	const seen = new Set<string>();
	const directories = new Set<string>();
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(
			RELATIVE_IMPORT,
		)) {
			const target = normalize(join(dirname(file), specifier));
			const owner = /^packages\/(.+?)\/src\//u.exec(target)?.[1];
			if (owner !== undefined) directories.add(owner);
			else if (target.startsWith("scripts/")) {
				const source = [
					target,
					target.replace(/\.js$/u, ".ts"),
					target.replace(/\.mjs$/u, ".mts"),
				].find((candidate) => existsSync(candidate));
				if (source !== undefined) queue.push(source);
			}
		}
	}
	return [...directories].sort().map((directory) => {
		const parsed: JsonValue = JSON.parse(
			readFileSync(join("packages", directory, "package.json"), "utf8"),
		);
		const name = asText(asObject(parsed)?.name);
		assert.ok(name, `packages/${directory}/package.json has no name`);
		return name;
	});
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
		assert.ok(scripts.needs.includes("route"));
		assert.equal(scripts.runsOn, ROUTED);
		assert.match(scripts.if, /!cancelled\(\)/u);
		assert.match(scripts.if, /github\.event_name == 'pull_request'/u);
		assert.match(scripts.if, /github\.event_name == 'merge_group'/u);
		// Not a job a signed local run stands in for: it always runs.
		assert.doesNotMatch(scripts.if, /attested/u);
		const lane = step(scripts, LANE);
		assert.equal(lane.run.trim(), "pnpm run test:scripts");
		assert.equal(lane.if, "steps.scope.outputs.run == 'true'");
		// The pinned toolchain (Node 24 from mise.toml) is in place first:
		// under Node 22 pnpm prints an engine warning into turbo's JSON.
		const names = scripts.steps.map((entry) => entry.uses || entry.name);
		const preflight = names.indexOf("./.github/actions/ci-runner-preflight");
		assert.ok(preflight >= 0, "the job runs ci-runner-preflight");
		assert.ok(preflight < names.indexOf(LANE));
		assert.ok(names.indexOf(SCOPE) < names.indexOf(LANE));
	});

	it("builds what every package a scripts test imports depends on, before the lane", () => {
		// A fresh runner has no dist/: scripts/manual/hosting-anonymous-acceptance.mts
		// imports packages/hobo/src, whose @hobo/core resolves through dist/.
		const build = step(scripts, BUILD);
		assert.equal(build.if, "steps.scope.outputs.run == 'true'");
		assert.match(build.run, /turbo run build\b/u);
		const imported = packagesScriptsTestsImport();
		assert.ok(imported.includes("@hobo/hobo"));
		for (const name of imported)
			assert.ok(
				build.run.includes(`--filter=${name}^...`),
				`the build step misses --filter=${name}^...`,
			);
		const names = scripts.steps.map((entry) => entry.uses || entry.name);
		assert.ok(names.indexOf("Install dependencies") < names.indexOf(BUILD));
		assert.ok(names.indexOf(BUILD) < names.indexOf(LANE));
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

	it("fails the gate unless the scripts job succeeded, attested or not", () => {
		const script = step(gate, GATE_STEP).run;
		const passing = {
			VALIDATION_RESULT: "success",
			WORKSPACE_RESULT: "success",
			ROUTE_RESULT: "success",
			ATTESTED: "",
			ATTESTED_JOBS: "",
		};
		const attestedAll = {
			VALIDATION_RESULT: "skipped",
			WORKSPACE_RESULT: "skipped",
			ROUTE_RESULT: "success",
			ATTESTED: "true",
			ATTESTED_JOBS:
				'["pr_gate_validation","workspace_tests","pr_affected","scripts-tests"]',
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
					assert.equal(
						run.status === 0,
						result === "success",
						`${event} ${JSON.stringify(others)} scripts=${result}: ${run.stderr}`,
					);
					if (result !== "success")
						assert.match(run.stderr, /Scripts tests did not succeed/u);
				}
			}
	});
});
