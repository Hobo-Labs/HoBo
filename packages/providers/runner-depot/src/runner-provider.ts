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
	DEPOT_PROVIDER_ID,
	DEPOT_RUNS_ON_DEFAULT,
	executionHostManifest,
} from "./manifest.js";

// public-contract: the default workflow file `run(job)` dispatches.
export const DEPOT_RUNNER_WORKFLOW_DEFAULT = "hobo-runner-depot.yml";

export interface DepotRunnerProviderOptions {
	// The real GitHub Actions client (injected fetch inside) — Depot-managed
	// runners substitute the runs-on substrate of the GitHub Actions job model.
	readonly client: GithubActionsClient;
	readonly id?: string;
	readonly workflow?: string;
	readonly ref?: string;
	// The Depot runner class the workflow runs on.
	readonly runsOn?: string;
	readonly tracking?: RunTrackingOptions;
}

// The REAL Depot RunnerProvider (`hobo:runner`): the SAME job spec that runs
// on runner-github/runner-blacksmith runs unmodified here — dispatched
// through the shared GitHub job model onto Depot-managed runners
// (`runs-on: depot-*`), carried as the `runs_on` input so the substitution
// is recorded on the run itself.
export function createDepotRunnerProvider(
	options: DepotRunnerProviderOptions,
): RunnerProvider {
	const id = options.id ?? DEPOT_PROVIDER_ID;
	const workflow = options.workflow ?? DEPOT_RUNNER_WORKFLOW_DEFAULT;
	const ref = options.ref ?? "main";
	const runsOn = options.runsOn ?? DEPOT_RUNS_ON_DEFAULT;

	return {
		id,
		category: RUNNER_CATEGORY,
		capabilityManifest() {
			return executionHostManifest(RUNNER_CATEGORY, { providerId: id });
		},
		async run(job: RunnerJob): Promise<RunnerResult> {
			if (job.jobId.length === 0) {
				throw new Error("runner-depot: job.jobId must be a non-empty string");
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
