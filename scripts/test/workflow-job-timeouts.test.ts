import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const workflowDir = join(root, ".github", "workflows");

/** Only main-gate may branch above 20 minutes for the weekly schedule sweep. */
const SCHEDULE_JOB_TIMEOUT = /^hobo-ci\.yml:main-gate$/;

function jobBlocks(text: string): { id: string; block: string }[] {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const jobsIndex = lines.indexOf("jobs:");
	assert.notEqual(jobsIndex, -1, "missing jobs:");
	const starts = lines
		.map((line, index) => ({ line, index }))
		.filter(
			({ index, line }) =>
				index > jobsIndex && /^  [A-Za-z0-9_-]+:$/.test(line),
		)
		.map(({ line, index }) => ({
			id: line.slice(2, -1),
			index,
		}));
	return starts.map(({ id, index }, position) => ({
		id,
		block: lines
			.slice(index, starts[position + 1]?.index ?? lines.length)
			.join("\n"),
	}));
}

function jobTimeoutLine(block: string): string | undefined {
	const stepsIndex = block.indexOf("\n    steps:");
	const head = stepsIndex === -1 ? block : block.slice(0, stepsIndex);
	const match = head.match(/^    timeout-minutes:\s*(.*)$/m);
	return match?.[1]?.trim();
}

function numericLiteralsInExpression(expr: string): number[] {
	const out: number[] = [];
	for (const match of expr.matchAll(/\b(\d+)\b/g)) {
		out.push(Number(match[1]));
	}
	return out;
}

function assertJobTimeout(
	file: string,
	jobId: string,
	raw: string | undefined,
): void {
	const label = `${file} job ${jobId}`;
	assert.ok(raw !== undefined, `${label} missing timeout-minutes`);
	if (/^\d+$/.test(raw)) {
		const minutes = Number(raw);
		assert.ok(
			minutes <= 20,
			`${label} timeout-minutes=${minutes} exceeds 20 (use schedule exception on main-gate only)`,
		);
		return;
	}
	const key = `${file}:${jobId}`;
	if (SCHEDULE_JOB_TIMEOUT.test(key)) {
		assert.match(
			raw,
			/github\.event_name == 'schedule' && 60 \|\| 20/u,
			`${label} must keep schedule 60 / default 20 branching`,
		);
		return;
	}
	for (const n of numericLiteralsInExpression(raw)) {
		assert.ok(n <= 20, `${label} expression mentions ${n} > 20: ${raw}`);
	}
}

describe("GitHub Actions job timeouts", () => {
	const files = readdirSync(workflowDir).filter((name) =>
		/\.ya?ml$/i.test(name),
	);
	assert.ok(files.length > 0, "expected workflow files");

	for (const file of files) {
		it(`${file} gives every job an explicit timeout-minutes ≤20 (schedule exception on main-gate only)`, () => {
			const text = readFileSync(join(workflowDir, file), "utf8");
			const jobs = jobBlocks(text);
			assert.ok(jobs.length > 0, `${file} has no jobs`);
			for (const { id, block } of jobs) {
				assertJobTimeout(file, id, jobTimeoutLine(block));
			}
		});
	}
});
