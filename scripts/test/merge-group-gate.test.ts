import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
const cacheAction = readFileSync(
	".github/actions/turbo-cache/action.yml",
	"utf8",
);

function job(name: string): string {
	const lines = workflow.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	assert.ok(start >= 0, `missing job ${name}`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^  [A-Za-z0-9_-]+:$/u.test(line));
	return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

function shellForStep(block: string, name: string): string {
	const start = block.indexOf(`      - name: ${name}\n`);
	assert.ok(start >= 0, `missing step ${name}`);
	const step = block.slice(start);
	const match = step.match(/\n        run: \|\n((?: {10}[^\n]*\n?)+)/u);
	const body = match?.[1];
	assert.ok(body !== undefined, `missing shell for ${name}`);
	return body.replace(/^ {10}/gmu, "");
}

describe("merge-group required gate", () => {
	const validation = job("pr_gate_validation");
	const workspace = job("workspace_tests");
	const affected = job("pr_affected");
	const gate = job("pr-gate");

	it("requires validation, all workspace shards, and the PR package lanes", () => {
		assert.match(validation, /name: S0 gate set/u);
		assert.match(
			validation,
			/pnpm agent:check -- --base="\$BASE" --external-workspace-tests/u,
		);
		assert.match(
			validation,
			/merge_base: \$\{\{ steps\.merge-group-base\.outputs\.base \}\}/u,
		);
		assert.match(
			validation,
			/merge_tests: \$\{\{ steps\.merge-group-base\.outputs\.tests \}\}/u,
		);
		assert.match(workspace, /needs: \[route, pr_gate_validation\]/u);
		assert.match(workspace, /needs\.pr_gate_validation\.result == 'success'/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.merge_base/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.merge_tests/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.pr_base/u);
		assert.match(
			validation,
			/shards: \$\{\{ steps\.shard-plan\.outputs\.shards \}\}/u,
		);
		assert.match(workspace, /fail-fast: false/u);
		assert.match(workspace, /scripts\/ci\/dependent-tests\.mts/u);
		assert.match(affected, /needs: \[route, pr_gate_validation\]/u);
		assert.match(
			affected,
			/turbo run build typecheck lint test:unit test:schema test:contract:consumer/u,
		);
		assert.match(
			gate,
			/needs: \[pr_gate_validation, workspace_tests, pr_affected\]/u,
		);
		assert.match(gate, /if: \$\{\{ always\(\)/u);
	});

	it("runs the planned shards, all eight when the plan is missing, and splits by job position", () => {
		const plan = validation.slice(
			validation.indexOf("name: Plan workspace test shards"),
		);
		// Every way of not having a plan keeps the eight shards.
		assert.match(plan, /shards='\[0, 1, 2, 3, 4, 5, 6, 7\]'/u);
		assert.match(plan, /--plan-shards=8\)" \|\| planned=""/u);
		assert.match(
			plan,
			/\[\[ "\$planned" =~ \^\\\[\[0-7\]\(,\\ \[0-7\]\)\*\\\]\$ \]\]/u,
		);
		assert.match(plan, /\[ "\$TESTS" = "affected" \] && \[ -n "\$BASE" \]/u);
		assert.match(
			workspace,
			/shard: \$\{\{ fromJSON\(needs\.pr_gate_validation\.outputs\.shards \|\| '\[0, 1, 2, 3, 4, 5, 6, 7\]'\) \}\}/u,
		);
		// The split follows the matrix GitHub actually built, not the plan's
		// own count: a list and a count could disagree and drop a suite.
		assert.match(workspace, /SHARD: \$\{\{ strategy\.job-index \}\}/u);
		assert.match(workspace, /SHARD_TOTAL: \$\{\{ strategy\.job-total \}\}/u);
		assert.equal(
			workspace.match(/--shard="\$SHARD\/\$SHARD_TOTAL"/gu)?.length,
			2,
		);
		assert.doesNotMatch(workspace, /--shard="\$SHARD\/8"/u);
	});

	it("never treats a failed, cancelled, skipped, or unknown prerequisite as success", () => {
		const script = shellForStep(
			gate,
			"Require successful validation and workspace tests",
		);
		const statuses = [
			"success",
			"failure",
			"cancelled",
			"skipped",
			"timed_out",
			"",
		];
		for (const event of ["pull_request", "merge_group", "push"]) {
			for (const validationResult of statuses) {
				for (const workspaceResult of statuses) {
					for (const affectedResult of statuses) {
						const run = spawnSync("bash", ["-c", script], {
							env: {
								...process.env,
								EVENT_NAME: event,
								VALIDATION_RESULT: validationResult,
								WORKSPACE_RESULT: workspaceResult,
								AFFECTED_RESULT: affectedResult,
							},
						});
						const expected =
							validationResult === "success" &&
							workspaceResult === "success" &&
							((event === "pull_request" && affectedResult === "success") ||
								(event === "merge_group" && affectedResult === "skipped"));
						assert.equal(
							run.status === 0,
							expected,
							`${event}/${validationResult}/${workspaceResult}/${affectedResult}`,
						);
					}
				}
			}
		}
	});

	it("rejects a missing scope or an unreachable affected base", () => {
		const script = shellForStep(workspace, "Workspace tests");
		for (const [tests, base] of [
			["", ""],
			["unexpected", ""],
			["affected", ""],
			["affected", "not-a-commit"],
		]) {
			const run = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					EVENT_NAME: "merge_group",
					MERGE_TESTS: tests,
					MERGE_BASE: base,
					SHARD: "0",
				},
			});
			assert.notEqual(run.status, 0, `${tests}/${base}`);
		}
	});

	it("fails the PR package lane if the impact planner fails", () => {
		const script = shellForStep(affected, "Affected package lanes");
		const directory = mkdtempSync(join(tmpdir(), "hobo-affected-plan-"));
		try {
			writeFileSync(
				join(directory, "git"),
				'#!/bin/sh\n[ "$1" != diff ] || echo packages/ci/src/x.ts\n',
				{ mode: 0o755 },
			);
			writeFileSync(join(directory, "node"), "#!/bin/sh\nexit 42\n", {
				mode: 0o755,
			});
			const run = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH ?? ""}`,
					RUNNER_TEMP: directory,
					TURBO_SCM_BASE: "valid",
				},
			});
			assert.equal(run.status, 42);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("pins the PR merge base before passing it between jobs", () => {
		const script = shellForStep(validation, "Resolve Turbo SCM base");
		const directory = mkdtempSync(join(tmpdir(), "hobo-pr-base-"));
		try {
			const sha = "a".repeat(40);
			const eventBase = "b".repeat(40);
			const output = join(directory, "output");
			const marker = join(directory, "injected");
			writeFileSync(
				join(directory, "git"),
				`#!/bin/sh\ncase "$1" in\n  cat-file) exit 0;;\n  merge-base) printf '%s' "$2" > "$CAPTURE"; printf '${sha}';;\n  *) exit 1;;\nesac\n`,
				{ mode: 0o755 },
			);
			const run = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH ?? ""}`,
					PR_BASE_SHA: eventBase,
					GITHUB_OUTPUT: output,
					CAPTURE: join(directory, "base"),
				},
			});
			assert.equal(run.status, 0, String(run.stderr));
			assert.equal(readFileSync(output, "utf8"), `base=${sha}\n`);
			assert.equal(readFileSync(join(directory, "base"), "utf8"), eventBase);
			const invalid = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH ?? ""}`,
					PR_BASE_SHA: `main$(touch ${marker})`,
					GITHUB_OUTPUT: output,
					CAPTURE: join(directory, "base"),
				},
			});
			assert.notEqual(invalid.status, 0);
			assert.equal(existsSync(marker), false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses external workspace coverage without an explicit CI diff base", () => {
		for (const args of [
			["--external-workspace-tests"],
			["--external-workspace-tests", "--staged", "--base=HEAD"],
		]) {
			const run = spawnSync(process.execPath, [
				"--import",
				"tsx",
				"scripts/run-relevant-checks.ts",
				...args,
			]);
			assert.equal(run.status, 2);
		}
	});

	it("builds @hobo/core and @hobo/data before the bindles schema lane", () => {
		const pkg = readFileSync("package.json", "utf8");
		const marker = pkg.indexOf('"test:schema":');
		assert.ok(marker >= 0, "missing root test:schema script");
		const script = pkg.slice(marker, pkg.indexOf("\n", marker));
		const build = script.indexOf(
			"turbo run build --filter=@hobo/core --filter=@hobo/data",
		);
		const bindles = script.indexOf("--filter @hobo/bindles run test:schema");
		assert.ok(build >= 0, "test:schema does not build core/data first");
		assert.ok(
			bindles > build,
			"bindles test:schema must run after the core/data build",
		);
	});

	it("prefers the same-run validation cache before older cache entries", () => {
		assert.match(workspace, /preferred-job: pr_gate_validation/u);
		assert.match(affected, /preferred-job: pr_gate_validation/u);
		assert.match(
			cacheAction,
			/inputs\.preferred-job.*github\.sha.*github\.run_attempt/u,
		);
		assert.match(
			cacheAction,
			/steps\.prerequisite\.outputs\.cache-hit != 'true'/u,
		);
	});
});
