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
import { evaluateExpression } from "../ci/attested-jobs.mts";
import {
	ALLOWLISTED_EXTRA_PULL_REQUEST_TYPES,
	CANONICAL_ENTRY_JOB_DRAFT_IF,
	draftGateEntryJobs,
	jobLevelIfHasRequiredDraftGate,
	type LintActionsResult,
	lintActionsRepository,
	normalizeDraftIfExpression,
	PROBE_READY_IF,
	REQUIRED_JOB_DRAFT_IF_MESSAGE,
	REQUIRED_PULL_REQUEST_TYPES,
} from "../lint-actions.ts";
import { testRunner } from "./support/test-runner.ts";

const { describe, it } = await testRunner();

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowDir = join(repoRoot, ".github", "workflows");

const pullRequestOn =
	"on:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n  push:\n    branches: [main]\n";
const routeJobGood =
	"  route:\n    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n      - id: route\n        uses: ./.github/actions/route-runner\n";
const trunkJob =
	'  trunk:\n    if: github.event_name != \'pull_request\'\n    runs-on: ${{ contains(fromJSON(\'["push","workflow_dispatch","merge_group","workflow_run"]\'), github.event_name) && \'hobo-trunk\' || \'hobo\' }}\n    steps:\n      - run: "true"\n';

const actionsLockOn = `on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
`;
const actionsLockJob = (jobIf: string) => `  actions-lock:
    if: \${{ ${jobIf} }}
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
          fetch-depth: 1
      - run: echo ok
`;

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

function errLines(stderr: string): string[] {
	return stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("ERR "));
}

function draftGateErrors(stderr: string): string[] {
	return errLines(stderr).filter((line) =>
		line.includes("must skip draft pull_request runs"),
	);
}

function nonDraftGateErrors(stderr: string): string[] {
	return errLines(stderr).filter(
		(line) => !line.includes("must skip draft pull_request runs"),
	);
}

async function lintFixtureWorkflow(
	file: string,
	body: string,
): Promise<LintActionsResult> {
	const root = mkdtempSync(join(tmpdir(), "hobo-draft-pr-lint-"));
	try {
		const dir = join(root, ".github", "workflows");
		mkdirSync(dir, { recursive: true });
		mkdirSync(join(root, ".github", "actions", "route-runner"), {
			recursive: true,
		});
		writeFileSync(
			join(root, ".github", "actions", "route-runner", "action.yml"),
			"name: route\nruns:\n  using: composite\n  steps:\n    - run: echo route\n",
		);
		writeFileSync(
			join(dir, file),
			`name: fixture\npermissions:\n  contents: read\n${body}`,
			"utf8",
		);
		process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = "1";
		return await lintActionsRepository(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function assertDraftPolicyOnlyFailure(
	result: LintActionsResult,
	jobRef: string,
): void {
	assert.equal(result.exitCode, 1, result.stderr);
	assert.deepEqual(
		nonDraftGateErrors(result.stderr),
		[],
		`unexpected non-draft lint errors:\n${result.stderr}`,
	);
	const draftErrors = draftGateErrors(result.stderr);
	assert.equal(draftErrors.length, 1, result.stderr);
	assert.match(draftErrors[0] ?? "", new RegExp(jobRef));
	assert.ok((draftErrors[0] ?? "").includes(REQUIRED_JOB_DRAFT_IF_MESSAGE));
}

describe("draft pull request CI policy", () => {
	it("only starts PR fleet probes for ready events while retaining trunk and manual probes", () => {
		const text = readFileSync(join(workflowDir, "fleet-probe.yml"), "utf8");
		for (const job of ["pr-fleet", "trunk-fleet", "local-box-enrolled"]) {
			const block = jobBlockFromText(text, job);
			assert.ok(block.includes(`    if: ${PROBE_READY_IF}`), job);
			for (const [event, draft, upstream, expected] of [
				["pull_request_target", true, "", false],
				["pull_request_target", false, "", true],
				["workflow_run", false, "pull_request", false],
				["workflow_run", false, "push", true],
				["workflow_run", false, "merge_group", true],
				["workflow_dispatch", false, "", true],
			] as const) {
				const values = new Map<string, string | boolean>([
					["github.event_name", event],
					["github.event.pull_request.draft", draft],
					["github.event.workflow_run.event", upstream],
				]);
				assert.equal(
					evaluateExpression(
						PROBE_READY_IF,
						(path) => values.get(path) ?? null,
					),
					expected,
					`${job} ${event} draft=${draft} upstream=${upstream}`,
				);
			}
		}
		assert.match(
			text,
			/ref: \$\{\{ github\.event_name == 'pull_request_target' && github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/u,
		);
		const local = jobBlockFromText(text, "local-box").join("\n");
		assert.match(local, /needs: local-box-enrolled/u);
	});

	it("schedules zero HoBo CI Fabric jobs for draft pull_request events", () => {
		const text = readFileSync(join(workflowDir, "hobo-ci.yml"), "utf8");
		const lines = text.split(/\r?\n/);
		const jobsIndex = lines.findIndex((line) => line === "jobs:");
		assert.notEqual(jobsIndex, -1);
		const jobIds = lines
			.slice(jobsIndex + 1)
			.filter((line) => /^  [A-Za-z0-9_-]+:$/.test(line))
			.map((line) => line.slice(2, -1));
		const values = new Map<string, string | boolean>([
			["github.event_name", "pull_request"],
			["github.event.pull_request.draft", true],
			["github.event.action", "synchronize"],
			["needs.route.result", "skipped"],
		]);
		for (const jobId of draftGateEntryJobs("hobo-ci.yml", jobIds)) {
			const block = jobBlockFromText(text, jobId);
			assert.equal(
				jobLevelIfHasRequiredDraftGate("hobo-ci.yml", jobId, block),
				true,
				jobId,
			);
			assert.equal(
				evaluateExpression(
					CANONICAL_ENTRY_JOB_DRAFT_IF,
					(path) => values.get(path) ?? null,
				),
				false,
				jobId,
			);
		}
		assert.equal(
			evaluateExpression(
				"always() && (github.event_name == 'merge_group' || (github.event_name == 'pull_request' && github.event.pull_request.draft == false))",
				(path) => values.get(path) ?? null,
			),
			false,
			"pr-gate",
		);
	});

	it("starts the HoBo CI Fabric route for ready pull_request events", () => {
		for (const action of [
			"ready_for_review",
			"synchronize",
			"opened",
		] as const) {
			const values = new Map<string, string | boolean>([
				["github.event_name", "pull_request"],
				["github.event.pull_request.draft", false],
				["github.event.action", action],
			]);
			assert.equal(
				evaluateExpression(
					CANONICAL_ENTRY_JOB_DRAFT_IF,
					(path) => values.get(path) ?? null,
				),
				true,
				action,
			);
		}
	});

	it("does not run draft heads, even when the old opt-in label is added", () => {
		for (const [event, draft, action, label, expected] of [
			["pull_request", true, "opened", "", false],
			["pull_request", true, "synchronize", "", false],
			["pull_request", true, "labeled", "other", false],
			["pull_request", true, "labeled", "ci:run-draft-checks", false],
			["pull_request", false, "ready_for_review", "", true],
			["merge_group", false, "checks_requested", "", true],
		] as const) {
			const values = new Map<string, string | boolean>([
				["github.event_name", event],
				["github.event.pull_request.draft", draft],
				["github.event.action", action],
				["github.event.label.name", label],
			]);
			assert.equal(
				evaluateExpression(
					CANONICAL_ENTRY_JOB_DRAFT_IF,
					(path) => values.get(path) ?? null,
				),
				expected,
			);
		}
	});

	it("skips the required PR impact gate on drafts but keeps it fail-closed for ready PRs and the queue", () => {
		const block = jobBlockFromText(
			readFileSync(join(workflowDir, "hobo-ci.yml"), "utf8"),
			"pr-gate",
		).join("\n");
		assert.match(
			block,
			/always\(\).*github\.event\.pull_request\.draft == false/u,
		);
		assert.match(
			block,
			/\[ "\$\{ROUTE_RESULT:-\}" = "success" \] \|\| return 1/u,
		);
	});

	it("allows labeled only on the examples E2E workflow for ready label-gated lanes", () => {
		assert.deepEqual(
			ALLOWLISTED_EXTRA_PULL_REQUEST_TYPES.get("examples-e2e.yml"),
			["labeled"],
		);
		const text = readFileSync(join(workflowDir, "examples-e2e.yml"), "utf8");
		assert.match(text, /ready_for_review, labeled/);
		assert.equal(
			jobLevelIfHasRequiredDraftGate(
				"examples-e2e.yml",
				"hello-bindle-fixture",
				jobBlockFromText(text, "hello-bindle-fixture"),
			),
			true,
		);
		const quarantine = jobBlockFromText(text, "hello-bindle-fixture-quarantine");
		assert.equal(
			jobLevelIfHasRequiredDraftGate(
				"examples-e2e.yml",
				"hello-bindle-fixture-quarantine",
				quarantine,
			),
			true,
		);
		assert.match(quarantine.join("\n"), /hobo\/e2e-quarantine/);
	});

	it("rejects a pull_request.types list that still listens on labeled", async () => {
		const withLabel = pullRequestOn.replace(
			"ready_for_review]",
			"ready_for_review, labeled]",
		);
		const result = await lintFixtureWorkflow(
			"hobo-ci.yml",
			`${withLabel}jobs:\n${routeJobGood}${trunkJob}`,
		);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /pull_request\.types must match/u);
	});

	it("does not start always-running aggregate jobs on drafts", () => {
		for (const [file, id, queue] of [
			["hobo-ci.yml", "pr-gate", true],
			["release-hobo-pr.yml", "release-integration-gate", true],
			["release-hobo.yml", "release-pr-gate", true],
			["release-hobo.yml", "release-integration-measure-gate", false],
		] as const) {
			const text = readFileSync(join(workflowDir, file), "utf8");
			const block = jobBlockFromText(text, id);
			const line = block.find((entry) => entry.startsWith("    if:"));
			assert.ok(line, `${file}:${id} must have a job condition`);
			const expression = line
				.replace(/^\s*if:\s*/, "")
				.replace(/^\$\{\{\s*/, "")
				.replace(/\s*\}\}$/, "");
			for (const [event, draft, expected] of [
				["pull_request", true, false],
				["pull_request", false, true],
				["merge_group", false, queue],
			] as const) {
				const values = new Map<string, string | boolean>([
					["github.event_name", event],
					["github.event.pull_request.draft", draft],
				]);
				assert.equal(
					evaluateExpression(expression, (path) => values.get(path) ?? null),
					expected,
					`${file}:${id} ${event} draft=${draft}`,
				);
			}
		}
	});

	it("rejects the old label-based draft override", async () => {
		const oldRoute = routeJobGood.replace(
			"github.event.pull_request.draft == false }}",
			"github.event.pull_request.draft == false || (github.event.action == 'labeled' && github.event.label.name == 'ci:run-draft-checks') }}",
		);
		assertDraftPolicyOnlyFailure(
			await lintFixtureWorkflow(
				"hobo-ci.yml",
				`${pullRequestOn}jobs:\n${oldRoute}${trunkJob}`,
			),
			"hobo-ci.yml:.*: job route",
		);
	});

	it("rejects an aggregate gate that starts after a skipped draft route", async () => {
		const gate = `  pr-gate:
    if: \${{ always() && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}
    needs: [route]
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;
		const result = await lintFixtureWorkflow(
			"hobo-ci.yml",
			`${pullRequestOn}jobs:\n${routeJobGood}${gate}${trunkJob}`,
		);
		assert.equal(result.exitCode, 1, result.stderr);
		assert.match(
			result.stderr,
			/job pr-gate must skip draft pull_request runs/u,
		);
	});

	it("rejects a new job that overrides the skipped route with a status function", async () => {
		const gate = `  extra:
    if: \${{ !cancelled() }}
    needs: [route]
    runs-on: hobo
    steps:
      - run: echo ok
`;
		const result = await lintFixtureWorkflow(
			"hobo-ci.yml",
			`${pullRequestOn}jobs:\n${routeJobGood}${gate}${trunkJob}`,
		);
		assert.equal(result.exitCode, 1, result.stderr);
		assert.match(result.stderr, /job extra must skip draft pull_request runs/u);
	});

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
			for (const jobId of draftGateEntryJobs(file, jobIds)) {
				const block = jobBlockFromText(text, jobId);
				assert.equal(
					jobLevelIfHasRequiredDraftGate(file, jobId, block),
					true,
					`${file} job ${jobId} must match the canonical or allowlisted job-level draft if`,
				);
			}
		}
	});

	it("rejects a route job if of only draft == false", async () => {
		const body = `${pullRequestOn}jobs:\n  route:\n    if: \${{ github.event.pull_request.draft == false }}\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n      - id: route\n        uses: ./.github/actions/route-runner\n${trunkJob}`;
		assertDraftPolicyOnlyFailure(
			await lintFixtureWorkflow("hobo-ci.yml", body),
			"hobo-ci.yml:.*: job route",
		);
	});

	it("rejects a draft check on a step if instead of the job if", async () => {
		const body = `${pullRequestOn}jobs:\n  route:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n      - id: route\n        uses: ./.github/actions/route-runner\n      - if: \${{ github.event.pull_request.draft == false }}\n        run: echo ok\n${trunkJob}`;
		assertDraftPolicyOnlyFailure(
			await lintFixtureWorkflow("hobo-ci.yml", body),
			"hobo-ci.yml:.*: job route",
		);
	});

	it("rejects a route if missing the event_name guard", async () => {
		const body = `${pullRequestOn}jobs:\n  route:\n    if: \${{ github.event.pull_request.draft == false && github.event_name == 'pull_request' }}\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n      - id: route\n        uses: ./.github/actions/route-runner\n${trunkJob}`;
		assertDraftPolicyOnlyFailure(
			await lintFixtureWorkflow("hobo-ci.yml", body),
			"hobo-ci.yml:.*: job route",
		);
	});

	it("rejects a route conjunct that adds event_name == pull_request after the OR gate", async () => {
		const body = `${pullRequestOn}jobs:\n  route:\n    if: \${{ (github.event_name != 'pull_request' || github.event.pull_request.draft == false || (github.event.action == 'labeled' && github.event.label.name == 'ci:run-draft-checks')) && github.event_name == 'pull_request' }}\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n      - id: route\n        uses: ./.github/actions/route-runner\n${trunkJob}`;
		assertDraftPolicyOnlyFailure(
			await lintFixtureWorkflow("hobo-ci.yml", body),
			"hobo-ci.yml:.*: job route",
		);
	});

	it("rejects an actions-lock AND draft gate that skips merge_group", async () => {
		const body = `${actionsLockOn}jobs:\n${actionsLockJob("github.event_name == 'pull_request' && github.event.pull_request.draft == false")}`;
		assertDraftPolicyOnlyFailure(
			await lintFixtureWorkflow("actions-lock.yml", body),
			"actions-lock.yml:.*: job actions-lock",
		);
	});

	it("accepts the canonical job-level draft gate on route", () => {
		const block = jobBlockFromText(
			`name: x\n${pullRequestOn}jobs:\n${routeJobGood}`,
			"route",
		);
		assert.equal(
			jobLevelIfHasRequiredDraftGate("hobo-ci.yml", "route", block),
			true,
		);
		assert.equal(
			normalizeDraftIfExpression(CANONICAL_ENTRY_JOB_DRAFT_IF),
			CANONICAL_ENTRY_JOB_DRAFT_IF,
		);
	});

	it("passes actions lint on the repository workflows", async () => {
		process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = "1";
		const result = await lintActionsRepository(repoRoot);
		assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
	});
});
