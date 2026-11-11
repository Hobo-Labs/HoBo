import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const ACTION = readFileSync(
	join(root, ".github/actions/ci-trace/action.yml"),
	"utf8",
);
const WORKFLOW = readFileSync(
	join(root, ".github/workflows/hobo-ci.yml"),
	"utf8",
);

function traceArtifactName(
	jobId: string,
	disambiguator: string,
	attempt: string,
) {
	const match = ACTION.match(
		/Upload trace artifact[\s\S]*?\n\s+name:\s*(.+)$/m,
	);
	const template = match?.[1]?.trim();
	expect(template, "ci-trace action declares artifact name").toBeTruthy();
	return template!
		.replace(/\$\{\{\s*github\.job\s*\}\}/gu, jobId)
		.replace(/\$\{\{\s*inputs\.disambiguator\s*\}\}/gu, disambiguator)
		.replace(/\$\{\{\s*github\.run_attempt\s*\}\}/gu, attempt);
}

describe("ci-trace action artifact names", () => {
	it("skips export when the trace script is absent", () => {
		expect(ACTION).toMatch(/CI trace skipped/u);
		expect(ACTION).toMatch(/scripts\/ci\/ci-trace\.mts/u);
	});

	it("includes the disambiguator between job id and run attempt", () => {
		expect(ACTION).toMatch(
			/name: ci-trace-\$\{\{ github\.job \}\}-\$\{\{ inputs\.disambiguator \}\}-\$\{\{ github\.run_attempt \}\}/,
		);
	});

	it("gives each workspace test matrix shard a distinct artifact name", () => {
		const workspaceBlock = WORKFLOW.slice(
			WORKFLOW.indexOf("workspace_tests:"),
			WORKFLOW.indexOf("\n  pr_affected:"),
		);
		expect(workspaceBlock).toMatch(/matrix:\s*\n\s+shard:/);
		const defaultShards = ["0", "1", "2", "3", "4", "5", "6", "7"];
		expect(workspaceBlock).toContain(
			"fromJSON(needs.pr_gate_validation.outputs.shards || '[0, 1, 2, 3, 4, 5, 6, 7]')",
		);
		const shards = defaultShards;
		const attempt = "1";
		const names = new Set(
			shards.map((shard) =>
				traceArtifactName("workspace_tests", shard, attempt),
			),
		);
		expect(names.size).toBe(shards.length);
		expect(workspaceBlock).toMatch(
			/uses: \.\/\.github\/actions\/ci-trace[\s\S]*disambiguator: \$\{\{ matrix\.shard \}\}/,
		);
	});
});
