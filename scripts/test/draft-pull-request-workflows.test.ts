import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	draftGateEntryJobs,
	jobLevelIfHasRequiredDraftGate,
	lintActionsRepository,
	REQUIRED_JOB_DRAFT_IF_RE,
	REQUIRED_PULL_REQUEST_TYPES,
} from "../lint-actions.ts";
import { testRunner } from "./support/test-runner.ts";

const { describe, it } = await testRunner();

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowDir = join(repoRoot, ".github", "workflows");

const pullRequestOn =
	"on:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n  workflow_dispatch:\n";
const routeJob =
	"  route:\n    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n";

function workflowsWithPullRequest(): string[] {
	return readdirSync(workflowDir)
		.filter((name) => /\.ya?ml$/i.test(name))
		.filter((name) =>
			/^\s*pull_request:/m.test(readFileSync(join(workflowDir, name), "utf8")),
		)
		.sort();
}

function jobBlockFromText(text: string, jobId: string): string[] {
	const lines = text.split(/\r?\n/);
	const jobsIndex = lines.findIndex((line) => line === "jobs:");
	assert.notEqual(jobsIndex, -1);
	const start = lines.findIndex(
		(line, index) => index > jobsIndex && line === `  ${jobId}:`,
	);
	assert.notEqual(start, -1);
	const nextJob = lines.findIndex(
		(line, index) => index > start && /^  [A-Za-z0-9_-]+:$/.test(line),
	);
	return lines.slice(start, nextJob === -1 ? lines.length : nextJob);
}

async function lintFixtureWorkflow(
	file: string,
	body: string,
): Promise<number> {
	const root = mkdtempSync(join(tmpdir(), "hobo-draft-pr-lint-"));
	try {
		const dir = join(root, ".github", "workflows");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, file),
			`name: fixture\npermissions: {}\n${body}`,
			"utf8",
		);
		const result = await lintActionsRepository(root);
		return result.exitCode;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("draft pull request CI policy", () => {
	it("lists every workflow that listens on pull_request", () => {
		assert.deepEqual(workflowsWithPullRequest(), [
			"actions-lock.yml",
			"dev-env-smoke.yml",
			"examples-e2e.yml",
			"hobo-ci.yml",
			"pricing-ci.yml",
			"release-hobo-pr.yml",
			"release-hobo.yml",
			"release-pricing.yml",
			"release-ts-autocode.yml",
		]);
	});

	it("requires ready_for_review and the job-level draft gate on each entry job", () => {
		for (const file of workflowsWithPullRequest()) {
			const text = readFileSync(join(workflowDir, file), "utf8");
			for (const type of REQUIRED_PULL_REQUEST_TYPES) {
				assert.match(
					text,
					new RegExp(`\\b${type}\\b`),
					`${file} must declare pull_request.types ${type}`,
				);
			}
			const lines = text.split(/\r?\n/);
			const jobsIndex = lines.findIndex((line) => line === "jobs:");
			assert.notEqual(jobsIndex, -1, `${file} must declare jobs`);
			const jobIds = lines
				.slice(jobsIndex + 1)
				.filter((line) => /^  [A-Za-z0-9_-]+:$/.test(line))
				.map((line) => line.slice(2, -1));
			const trunkInOn = lines
				.slice(0, jobsIndex)
				.some((line) =>
					/^  (push|workflow_dispatch|merge_group|workflow_run):/.test(line),
				);
			for (const jobId of draftGateEntryJobs(file, jobIds)) {
				const block = jobBlockFromText(text, jobId);
				assert.equal(
					jobLevelIfHasRequiredDraftGate(block, trunkInOn, jobId),
					true,
					`${file} job ${jobId} must use ${REQUIRED_JOB_DRAFT_IF_RE}`,
				);
			}
		}
	});

	it("rejects a route job if of only draft == false", async () => {
		const bad = `${pullRequestOn}jobs:\n  route:\n    if: \${{ github.event.pull_request.draft == false }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n`;
		assert.notEqual(await lintFixtureWorkflow("hobo-ci.yml", bad), 0);
	});

	it("rejects a draft check on a step if instead of the job if", async () => {
		const bad = `${pullRequestOn}jobs:\n  route:\n    runs-on: ubuntu-24.04\n    steps:\n      - if: \${{ github.event.pull_request.draft == false }}\n        run: echo ok\n`;
		assert.notEqual(await lintFixtureWorkflow("hobo-ci.yml", bad), 0);
	});

	it("rejects a job if missing the event_name guard", async () => {
		const bad = `${pullRequestOn}jobs:\n  route:\n    if: \${{ github.event.pull_request.draft == false && github.event_name == 'pull_request' }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n`;
		assert.notEqual(await lintFixtureWorkflow("hobo-ci.yml", bad), 0);
	});

	it("accepts the canonical job-level draft gate on route", () => {
		const block = jobBlockFromText(
			`name: x\n${pullRequestOn}jobs:\n${routeJob}`,
			"route",
		);
		assert.equal(jobLevelIfHasRequiredDraftGate(block, true, "route"), true);
	});

	it("passes actions lint on the repository workflows", async () => {
		const result = await lintActionsRepository(repoRoot);
		assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
	});
});
