import type { GithubActionsClient } from "./github-actions-client.js";
import {
	executionHostManifest,
	GITHUB_RUNNER_PROVIDER_ID,
} from "./manifest.js";
import {
	RUNNER_CATEGORY,
	type RunnerEvent,
	type RunnerJob,
	type RunnerProvider,
	type RunnerResult,
} from "./types.js";

// public-contract: the default workflow file `run(job)` dispatches.
export const RUNNER_WORKFLOW_DEFAULT = "hobo-runner.yml";
// public-contract: the default git ref workflow_dispatch targets.
export const RUNNER_REF_DEFAULT = "main";

export interface RunTrackingOptions {
	// Max poll attempts before the run is treated as failed (default 60).
	readonly attempts?: number;
	// Delay between polls in ms (default 5000; the replay lane injects a no-op).
	readonly intervalMs?: number;
	// The wait primitive — injected in tests so polling costs no wall clock.
	readonly wait?: (ms: number) => Promise<void>;
}

export interface GithubRunnerProviderOptions {
	// The real GitHub Actions client (injected fetch inside).
	readonly client: GithubActionsClient;
	readonly id?: string;
	readonly workflow?: string;
	readonly ref?: string;
	readonly tracking?: RunTrackingOptions;
}

const defaultWait = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

// Track a dispatched workflow to completion: correlate the newest
// workflow_dispatch run, then poll until GitHub reports `completed`.
export async function trackDispatchedRun(
	client: GithubActionsClient,
	workflow: string,
	tracking: RunTrackingOptions = {},
): Promise<{ id: number; conclusion: string | null; htmlUrl: string }> {
	const attempts = tracking.attempts ?? 60;
	const intervalMs = tracking.intervalMs ?? 5000;
	const wait = tracking.wait ?? defaultWait;

	let run = await client.findDispatchedRun(workflow);
	for (let attempt = 0; run === undefined && attempt < attempts; attempt += 1) {
		await wait(intervalMs);
		run = await client.findDispatchedRun(workflow);
	}
	if (run === undefined) {
		throw new Error(
			`runner-github: no workflow_dispatch run appeared for ${workflow}`,
		);
	}
	for (
		let attempt = 0;
		run.status !== "completed" && attempt < attempts;
		attempt += 1
	) {
		await wait(intervalMs);
		run = await client.getRun(run.id);
	}
	if (run.status !== "completed") {
		throw new Error(
			`runner-github: run ${run.id} did not complete within ${attempts} polls`,
		);
	}
	return { id: run.id, conclusion: run.conclusion, htmlUrl: run.htmlUrl };
}

// The REAL GitHub Actions RunnerProvider (`hobo:runner`): `run(job)` fires a
// workflow_dispatch carrying the job id + command as inputs, tracks the run to
// completion, and returns the result with past-tense runner facts for the
// caller to append to the durable log.
export function createGithubRunnerProvider(
	options: GithubRunnerProviderOptions,
): RunnerProvider {
	const id = options.id ?? GITHUB_RUNNER_PROVIDER_ID;
	const workflow = options.workflow ?? RUNNER_WORKFLOW_DEFAULT;
	const ref = options.ref ?? RUNNER_REF_DEFAULT;

	return {
		id,
		category: RUNNER_CATEGORY,
		capabilityManifest() {
			return executionHostManifest(RUNNER_CATEGORY, { providerId: id });
		},
		async run(job: RunnerJob): Promise<RunnerResult> {
			if (job.jobId.length === 0) {
				throw new Error("runner-github: job.jobId must be a non-empty string");
			}
			await options.client.dispatchWorkflow({
				workflow: job.workflow ?? workflow,
				ref: job.ref ?? ref,
				inputs: {
					...job.inputs,
					job_id: job.jobId,
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
