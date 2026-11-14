import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const workflowDir = join(root, ".github", "workflows");

/** Only main-gate may branch above 20 minutes for the weekly schedule sweep. */
const SCHEDULE_JOB_TIMEOUT = /^hobo-ci\.yml:main-gate$/;

/**
 * Jobs that may run longer than 20 minutes, each with its ceiling and why.
 * Keep this list short: a job here is one whose work cannot be split below
 * the limit without losing what it proves.
 */
type LongJob = Readonly<{ minutes: number; why: string }>;
const LONG_JOB_TIMEOUTS = new Map<string, LongJob>([
	[
		"fleet-integration.yml:fleet-verify",
		{
			minutes: 60,
			why: "HoBo Fleet (ADR-0183): one job provisions nats-server, the pinned iroh relay and the gVisor sandbox runtime (D58) on the self-hosted runner, then runs every fleet:verify outcome against them; the outcomes share that provisioning and only run on fleet/** pushes and on demand",
		},
	],
	[
		"fleet-integration.yml:fleet-integration-tests",
		{
			minutes: 45,
			why: "HoBo Fleet (ADR-0183): the same sandbox, NATS and relay provisioning as fleet-verify, then every fleet *.integration.test.ts; splitting it would provision the sandbox runtime once per shard",
		},
	],
]);

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
	const long = LONG_JOB_TIMEOUTS.get(`${file}:${jobId}`);
	if (long !== undefined) {
		assert.ok(long.why.length > 0, `${label} long timeout has no reason`);
		assert.match(raw, /^\d+$/u, `${label} long timeout must be a number`);
		assert.ok(
			Number(raw) <= long.minutes,
			`${label} timeout-minutes=${raw} exceeds its documented ${long.minutes}`,
		);
		return;
	}
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
		it(`${file} gives every job an explicit timeout-minutes ≤20 (schedule exception on main-gate only, documented long jobs excepted)`, () => {
			const text = readFileSync(join(workflowDir, file), "utf8");
			const jobs = jobBlocks(text);
			assert.ok(jobs.length > 0, `${file} has no jobs`);
			for (const { id, block } of jobs) {
				assertJobTimeout(file, id, jobTimeoutLine(block));
			}
		});
	}

	it("lists only long jobs that still exist", () => {
		for (const key of LONG_JOB_TIMEOUTS.keys()) {
			const [file = "", jobId = ""] = key.split(":");
			const text = readFileSync(join(workflowDir, file), "utf8");
			assert.ok(
				jobBlocks(text).some(({ id }) => id === jobId),
				`${key} is not a job any more`,
			);
		}
	});
});
