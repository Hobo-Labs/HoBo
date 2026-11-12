import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
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

describe("main_gate_finish workspace prerequisites", () => {
	const finish = job("main_gate_finish");
	const script = shellForStep(finish, "Require main gate and workspace shards");

	it("waits on main-gate-plan so a failed plan cannot hide behind skipped shards", () => {
		assert.match(
			finish,
			/needs: \[main-gate, main-gate-plan, main_workspace_tests\]/u,
		);
	});

	it("passes finish when the plan emitted no shards (skipped or empty-matrix failure)", () => {
		type Case = Readonly<{
			plan: string;
			shards: string;
			workspace: string;
			ok: boolean;
		}>;
		const cases: Case[] = [
			{ plan: "success", shards: "[]", workspace: "skipped", ok: true },
			{ plan: "success", shards: "[0]", workspace: "success", ok: true },
			{ plan: "failure", shards: "", workspace: "skipped", ok: false },
			{ plan: "cancelled", shards: "", workspace: "skipped", ok: false },
			{ plan: "success", shards: "[0]", workspace: "skipped", ok: false },
			{ plan: "success", shards: "[]", workspace: "failure", ok: true },
		];
		for (const entry of cases) {
			const run = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					MAIN_RESULT: "success",
					PLAN_RESULT: entry.plan,
					PLAN_SHARDS: entry.shards,
					WORKSPACE_RESULT: entry.workspace,
				},
			});
			assert.equal(
				run.status === 0,
				entry.ok,
				`plan=${entry.plan} shards=${entry.shards} workspace=${entry.workspace}`,
			);
		}
	});
});
