import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	ATTESTATION_EVENTS,
	asObject,
	asText,
	COVERED_JOBS,
	GATE_JOBS,
} from "../ci/attestation.mts";
import {
	conditionHolds,
	evaluateExpression,
	ExpressionError,
	expressionsOf,
	loadPlan,
	parsePlan,
	substituteExpressions,
} from "../ci/attested-jobs.mts";
import { localContext, type StepValues } from "../ci/local-attest.mts";
import { workflowDocument, workflowJob } from "../lib/workflow-job-steps.mts";

const plan = loadPlan();

/** The condition that skips a job the route job verified a signed local run for. */
const skipWhenAttested = (job: string) =>
	`!(needs.route.outputs.attested == 'true' && contains(needs.route.outputs.attested-jobs, '"${job}"'))`;

describe("the description of the covered jobs", () => {
	it("describes exactly the covered jobs, the gate's first and in order", () => {
		assert.deepEqual(
			plan.map((job) => job.id),
			[...COVERED_JOBS],
		);
		assert.deepEqual(
			plan.slice(0, GATE_JOBS.length).map((job) => job.id),
			[...GATE_JOBS],
		);
	});

	// The drift test: the local runner executes this description, never the
	// workflow, so the two must say the same thing. When this fails, copy the
	// workflow's change into scripts/ci/attested-jobs.json and decide what a
	// local run does with any new step (`local: run`, or `skip` with a reason).
	for (const job of plan)
		it(`${job.id} matches its workflow job step for step`, () => {
			const inWorkflow = workflowJob(
				readFileSync(job.workflow, "utf8"),
				job.id,
			);
			const {
				id: _id,
				workflow: _workflow,
				uncoveredWhen: _when,
				...described
			} = job;
			assert.deepEqual(
				{
					...described,
					steps: job.steps.map(
						({ local: _local, reason: _reason, ...step }) => step,
					),
				},
				inWorkflow,
			);
		});

	it("runs every command of a covered job, or says why one is not needed here", () => {
		for (const job of plan)
			for (const [index, step] of job.steps.entries()) {
				const at = `${job.id} step ${index + 1}`;
				if (step.local === "skip") {
					assert.ok((step.reason ?? "").length > 20, `${at} needs a reason`);
					continue;
				}
				assert.ok(step.run, `${at} has nothing to run`);
				assert.equal(step.uses, undefined, `${at} cannot run an action`);
			}
	});

	it("only leaves out a step that sets up or tidies the CI machine, or builds an image", () => {
		const left = plan.flatMap((job) =>
			job.steps
				.filter((step) => step.local === "skip" && step.run !== undefined)
				.map((step) => `${job.id}: ${step.name}`),
		);
		assert.deepEqual(left, [
			"pr_gate_validation: Prune Turbo cache",
			"workspace_tests: Prune Turbo cache",
			"pr_affected: Prune Turbo cache",
			"pr-offpath: Prune Turbo cache",
			"release-contract: Ensure worker toolchain image",
			"release-contract: Build affected images + live OCI config contract",
			"release-contract: Clean up OCI build artifacts",
			"release-contract: Prune Turbo cache",
		]);
	});

	it("does not cover the release contract once a release image is affected", () => {
		const release = plan.find((job) => job.id === "release-contract");
		assert.deepEqual(release?.uncoveredWhen, {
			step: "affected",
			output: "image_ids",
			reason:
				"a release image is affected, and building it needs the CI image pipeline",
		});
		// Every step left out for that reason is one the workflow itself only
		// runs when an image is affected.
		for (const step of release?.steps ?? [])
			if (step.reason?.includes("release image"))
				assert.match(
					step.if ?? "",
					/steps\.affected\.outputs\.image_ids != ''/,
				);
		assert.ok(
			release?.steps.some(
				(step) => step.id === "affected" && step.local === "run",
			),
		);
	});

	it("rejects a description that is not the shape the runner expects", () => {
		const job = {
			id: "ci-guard",
			workflow: ".github/workflows/hobo-ci.yml",
			workflowEnv: {},
			env: {},
			outputs: {},
			steps: [{ run: "true", local: "run" }],
		};
		assert.equal(parsePlan(JSON.stringify({ jobs: [job] })).length, 1);
		for (const broken of [
			{ ...job, id: "ci-runner-image" },
			{ ...job, steps: [{ run: "true" }] },
			{ ...job, steps: [{ run: "true", local: "maybe" }] },
			{ ...job, steps: [{ uses: "./x", local: "run" }] },
			{ ...job, steps: [{ run: "true", local: "skip" }] },
			{ ...job, env: { A: 1 } },
		])
			assert.throws(
				() => parsePlan(JSON.stringify({ jobs: [broken] })),
				JSON.stringify(broken),
			);
		assert.throws(() => parsePlan(JSON.stringify({ jobs: [job, job] })));
		assert.throws(() => parsePlan("{}"));
	});
});

describe("skipping a covered job in the workflows", () => {
	const workflows = [...new Set(plan.map((job) => job.workflow))];

	it("skips each covered job on its own id, and no other job", () => {
		for (const path of workflows) {
			const jobs = Object.entries(
				workflowDocument(readFileSync(path, "utf8")).jobs ?? {},
			);
			assert.ok(jobs.length > 0, path);
			for (const [id, job] of jobs) {
				// The gate reads the attestation in its step, not its condition.
				const condition = asText(asObject(job)?.if) ?? "";
				const covered = plan.some(
					(planned) => planned.id === id && planned.workflow === path,
				);
				if (!covered) {
					assert.doesNotMatch(
						condition,
						/attested/u,
						`${path}: ${id} is not a covered job and must not be skipped for an attestation`,
					);
					continue;
				}
				assert.ok(
					condition.includes(skipWhenAttested(id)),
					`${path}: ${id} must be skipped when attested, by its own id`,
				);
				assert.equal(
					condition.split("attested-jobs").length - 1,
					1,
					`${path}: ${id} must name only itself`,
				);
			}
		}
	});

	it("checks for an attestation in the route job of each workflow with a covered job", () => {
		for (const path of workflows) {
			const text = readFileSync(path, "utf8");
			const route = text.slice(
				text.indexOf("\n  route:\n"),
				text.indexOf(
					"\n  ",
					text.indexOf("uses: ./.github/actions/route-runner"),
				),
			);
			for (const needed of [
				"scripts/ci/attestation.mts",
				"scripts/ci/verify-attestation.mts",
				"attested: ${{ steps.route.outputs.attested }}",
				"attested-jobs: ${{ steps.route.outputs.attested-jobs }}",
			])
				assert.ok(route.includes(needed), `${path}: route job lacks ${needed}`);
		}
	});
});

describe("expressions in the description", () => {
	const context = (
		event: (typeof ATTESTATION_EVENTS)[number],
		values: StepValues = {},
	) =>
		localContext({
			event,
			target: {
				mergeCommit: "c".repeat(40),
				base: "b".repeat(40),
				baseBranch: "main",
			},
			steps: new Map([["scope", values]]),
			env: values,
			shard: { index: 2, total: 4, value: 5 },
			jobResults: new Map(plan.map((job) => [job.id, "success" as const])),
			jobOutputs: new Map([["pr_gate_validation", values]]),
		});

	it("can all be given a value on a developer's machine, for both events", () => {
		for (const event of ATTESTATION_EVENTS)
			for (const job of plan)
				for (const expression of expressionsOf(job))
					assert.doesNotThrow(
						() => evaluateExpression(expression, context(event)),
						`${job.id}: ${expression}`,
					);
	});

	it("runs each covered job on the events its workflow condition names", () => {
		const runsOn = (id: string, event: (typeof ATTESTATION_EVENTS)[number]) =>
			conditionHolds(plan.find((job) => job.id === id)?.if, context(event));
		for (const id of [
			"pr_gate_validation",
			"workspace_tests",
			"release-contract",
		]) {
			assert.equal(runsOn(id, "pull_request"), true, id);
			assert.equal(runsOn(id, "merge_group"), true, id);
		}
		for (const id of [
			"pr_affected",
			"pr-offpath",
			"artifact-trust",
			"ci-guard",
			"secret-scan",
		]) {
			assert.equal(runsOn(id, "pull_request"), true, id);
			assert.equal(runsOn(id, "merge_group"), false, id);
		}
	});

	it("gives the base, the event and the shard their local values", () => {
		const pr = context("pull_request");
		const group = context("merge_group");
		assert.equal(
			evaluateExpression("github.event.pull_request.base.sha", pr),
			"b".repeat(40),
		);
		assert.equal(
			evaluateExpression("github.event.pull_request.base.sha", group),
			"",
		);
		assert.equal(
			evaluateExpression("github.event.merge_group.base_sha", group),
			"b".repeat(40),
		);
		assert.equal(
			evaluateExpression("github.event.merge_group.base_sha", pr),
			"",
		);
		assert.equal(
			substituteExpressions("origin/${{ github.base_ref }}", pr),
			"origin/main",
		);
		assert.equal(
			substituteExpressions("${{ github.sha }}", pr),
			"c".repeat(40),
		);
		assert.equal(
			substituteExpressions(
				"${{ strategy.job-index }}/${{ strategy.job-total }}",
				pr,
			),
			"2/4",
		);
		assert.equal(
			evaluateExpression("vars.HOBO_IMPACT_GATE || 'shadow'", pr),
			"shadow",
		);
		assert.equal(
			substituteExpressions(
				"${{ needs.pr_gate_validation.outputs.pr_base }}",
				context("pull_request", { pr_base: "abc" }),
			),
			"abc",
		);
	});

	it("never has an attestation of its own to skip a job for", () => {
		for (const job of COVERED_JOBS)
			assert.equal(
				evaluateExpression(skipWhenAttested(job), context("pull_request")),
				true,
			);
	});

	it("refuses a context it has no value for, and a function it does not know", () => {
		const pr = context("pull_request");
		for (const expression of [
			"github.actor",
			"runner.os",
			"needs.ci-runner-image.result",
			"hashFiles('pnpm-lock.yaml')",
			"github.event_name ==",
			"(github.event_name",
			"github.event_name 'x'",
			"a ? b : c",
		])
			assert.throws(
				() => evaluateExpression(expression, pr),
				ExpressionError,
				expression,
			);
	});

	it("follows GitHub's rules for the operators the jobs use", () => {
		const values = {
			run: "true",
			match: "",
			shards: "[0, 1, 2]",
		};
		const at = context("pull_request", values);
		const value = (expression: string) => evaluateExpression(expression, at);
		assert.equal(value("github.event_name == 'pull_request'"), true);
		assert.equal(value("github.event_name == 'PULL_REQUEST'"), true);
		assert.equal(value("github.event_name != 'push'"), true);
		assert.equal(
			value(
				"github.event_name == 'pull_request' || github.event_name == 'merge_group'",
			),
			true,
		);
		assert.equal(value("steps.scope.outputs.run == 'true'"), true);
		assert.equal(value("steps.scope.outputs.match != 'true'"), true);
		assert.equal(value("steps.unknown.outputs.anything == ''"), true);
		assert.equal(
			value("!cancelled() && always() && success() && !failure()"),
			true,
		);
		assert.equal(value("env.match == '' && env.run"), "true");
		assert.equal(value("'' || 'fallback'"), "fallback");
		assert.equal(value("'it''s'"), "it's");
		assert.equal(value("true && 'yes' || 'no'"), "yes");
		assert.equal(value("false && 'yes' || 'no'"), "no");
		assert.equal(value("null == ''"), true);
		assert.equal(value('contains(\'["a","b"]\', \'"a"\')'), true);
		assert.equal(value("contains('[\"ab\"]', '\"a\"')"), false);
		assert.deepEqual(
			value("fromJSON(steps.scope.outputs.shards || '[9]')"),
			[0, 1, 2],
		);
		assert.deepEqual(value("fromJSON(steps.scope.outputs.none || '[9]')"), [9]);
		assert.equal(
			value(
				'contains(fromJSON(\'["push","merge_group"]\'), github.event_name)',
			),
			false,
		);
		assert.equal(conditionHolds(undefined, at), true);
		assert.equal(
			conditionHolds("${{ github.event_name == 'push' }}", at),
			false,
		);
		assert.equal(
			conditionHolds("github.event_name == 'pull_request'", at),
			true,
		);
	});
});
