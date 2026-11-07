import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		assert.match(workspace, /needs: pr_gate_validation/u);
		assert.match(workspace, /needs\.pr_gate_validation\.result == 'success'/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.merge_base/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.merge_tests/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.pr_base/u);
		assert.match(workspace, /shard: \[0, 1, 2, 3, 4, 5, 6, 7\]/u);
		assert.match(workspace, /fail-fast: false/u);
		assert.match(workspace, /scripts\/ci\/dependent-tests\.mts/u);
		assert.match(workspace, /--shard="\$SHARD\/8"/u);
		assert.match(affected, /needs: pr_gate_validation/u);
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
