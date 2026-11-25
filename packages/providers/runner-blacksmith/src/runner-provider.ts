import type {
	GithubActionsClient,
	RunnerEvent,
	RunnerJob,
	RunnerProvider,
	RunnerResult,
	RunTrackingOptions,
} from "@hobo/runner-github";
import { RUNNER_CATEGORY, trackDispatchedRun } from "@hobo/runner-github";

import {
	BLACKSMITH_PROVIDER_ID,
	BLACKSMITH_RUNS_ON_DEFAULT,
	executionHostManifest,
} from "./manifest.js";

// public-contract: the default workflow file `run(job)` dispatches.
export const BLACKSMITH_RUNNER_WORKFLOW_DEFAULT = "hobo-runner-blacksmith.yml";

export interface BlacksmithRunnerProviderOptions {
	// The real GitHub Actions client (injected fetch inside) — Blacksmith is a
	// drop-in runs-on substitution, so jobs still dispatch through GitHub.
	readonly client: GithubActionsClient;
	readonly id?: string;
	readonly workflow?: string;
	readonly ref?: string;
	// The Blacksmith runner class the workflow runs on.
	readonly runsOn?: string;
	readonly tracking?: RunTrackingOptions;
}

// The REAL Blacksmith.sh RunnerProvider (`hobo:runner`): the SAME job spec
// that runs on runner-github runs unmodified here — `run(job)` fires the same
// workflow_dispatch shape, but the workflow executes on Blacksmith-managed
// fast runners (`runs-on: blacksmith-*`), carried as the `runs_on` input so
// the substitution is recorded on the run itself.
export function createBlacksmithRunnerProvider(
	options: BlacksmithRunnerProviderOptions,
): RunnerProvider {
	const id = options.id ?? BLACKSMITH_PROVIDER_ID;
	const workflow = options.workflow ?? BLACKSMITH_RUNNER_WORKFLOW_DEFAULT;
	const ref = options.ref ?? "main";
	const runsOn = options.runsOn ?? BLACKSMITH_RUNS_ON_DEFAULT;

	return {
		id,
		category: RUNNER_CATEGORY,
		capabilityManifest() {
			return executionHostManifest(RUNNER_CATEGORY, { providerId: id });
		},
		async run(job: RunnerJob): Promise<RunnerResult> {
			if (job.jobId.length === 0) {
				throw new Error(
					"runner-blacksmith: job.jobId must be a non-empty string",
				);
			}
			await options.client.dispatchWorkflow({
				workflow: job.workflow ?? workflow,
				ref: job.ref ?? ref,
				inputs: {
					...job.inputs,
					job_id: job.jobId,
					runs_on: runsOn,
					...(job.command === undefined ? undefined : { command: job.command }),
				},
			});
			const run = await trackDispatchedRun(
				options.client,
				job.workflow ?? workflow,
				options.tracking,
			);
			const succeeded = run.conclusion === "success";
			const events: RunnerEvent[] = [
				{
					type: "runner.JobStarted",
					jobId: job.jobId,
					providerId: id,
					runId: run.id,
					runUrl: run.htmlUrl,
				},
				{
					type: succeeded ? "runner.JobSucceeded" : "runner.JobFailed",
					jobId: job.jobId,
					providerId: id,
					runId: run.id,
					runUrl: run.htmlUrl,
				},
			];
			return {
				providerId: id,
				category: RUNNER_CATEGORY,
				jobId: job.jobId,
				status: succeeded ? "succeeded" : "failed",
				command: job.command ?? "",
				runId: run.id,
				runUrl: run.htmlUrl,
				events,
			};
		},
	};
}
