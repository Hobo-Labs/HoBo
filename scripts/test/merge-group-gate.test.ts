import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
	const workspace = job("merge_workspace");
	const gate = job("pr-gate");

	it("runs both validations before the required check and preserves the selected scope", () => {
		assert.match(validation, /name: S0 gate set/u);
		assert.match(validation, /pnpm agent:check -- --base="\$BASE"/u);
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
		assert.match(workspace, /scripts\/ci\/dependent-tests\.mts/u);
		assert.match(workspace, /pnpm exec turbo run test/u);
		assert.match(gate, /needs: \[pr_gate_validation, merge_workspace\]/u);
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
					const run = spawnSync("bash", ["-c", script], {
						env: {
							...process.env,
							EVENT_NAME: event,
							VALIDATION_RESULT: validationResult,
							WORKSPACE_RESULT: workspaceResult,
						},
					});
					const expected =
						validationResult === "success" &&
						((event === "pull_request" && workspaceResult === "skipped") ||
							(event === "merge_group" && workspaceResult === "success"));
					assert.equal(
						run.status === 0,
						expected,
						`${event}/${validationResult}/${workspaceResult}`,
					);
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
				env: { ...process.env, TESTS: tests, BASE: base },
			});
			assert.notEqual(run.status, 0, `${tests}/${base}`);
		}
	});

	it("prefers the same-run validation cache before older cache entries", () => {
		assert.match(workspace, /preferred-job: pr_gate_validation/u);
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
