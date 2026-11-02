import { z } from "zod";
import type { GithubTransport } from "./github.js";
import { getJob, getRun } from "./github.js";

const QueuedRun = z.object({
	id: z.number().int().positive(),
});

export interface JobPollAdmissionOptions {
	github: GithubTransport;
	repository: string;
	installationId: number;
	processWorkflowJobWebhook: (body: Buffer) => Promise<string>;
	intervalMs?: number;
	logger?: (message: string) => void;
}

/** Poll GitHub for queued `hobo` jobs and admit them without a public webhook URL. */
export function createJobPollAdmissionWorker(options: JobPollAdmissionOptions) {
	const intervalMs = options.intervalMs ?? 15_000;
	if (!Number.isInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 300_000)
		throw new Error("invalid poll interval");
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;

	async function tick(): Promise<void> {
		if (running) return;
		running = true;
		try {
			const response = await options.github.request(
				options.installationId,
				`/repos/${options.repository}/actions/runs?status=queued&per_page=20`,
			);
			if (!response.ok) return;
			const runs = z
				.object({ workflow_runs: z.array(QueuedRun) })
				.parse(await response.json()).workflow_runs;
			for (const run of runs) {
				const workflowRun = await getRun(
					options.github,
					options.installationId,
					options.repository,
					run.id,
				);
				const jobsResponse = await options.github.request(
					options.installationId,
					`/repos/${options.repository}/actions/runs/${run.id}/jobs?per_page=100`,
				);
				if (!jobsResponse.ok) continue;
				const jobs = z
					.object({
						jobs: z.array(
							z.object({
								id: z.number().int().positive(),
								status: z.string(),
								labels: z.array(z.string()),
							}),
						),
					})
					.parse(await jobsResponse.json()).jobs;
				for (const job of jobs) {
					if (
						job.status !== "queued" ||
						job.labels.length !== 1 ||
						job.labels[0]?.toLowerCase() !== "hobo"
					)
						continue;
					const current = await getJob(
						options.github,
						options.installationId,
						options.repository,
						job.id,
					);
					const body = Buffer.from(
						JSON.stringify({
							action: "queued",
							installation: { id: options.installationId },
							repository: {
								id: workflowRun.repository.id,
								full_name: options.repository,
							},
							workflow_job: {
								id: job.id,
								run_id: run.id,
								run_attempt: workflowRun.run_attempt,
								labels: job.labels,
								runner_name: current.runner_name ?? null,
							},
						}),
					);
					const result = await options.processWorkflowJobWebhook(body);
					options.logger?.(
						`poll-admission job ${job.id} run ${run.id}: ${result}`,
					);
				}
			}
		} finally {
			running = false;
		}
	}

	return {
		start(): void {
			if (timer) return;
			timer = setInterval(() => {
				void tick().catch(() => {});
			}, intervalMs);
			void tick().catch(() => {});
		},
		stop(): void {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
		tick,
	};
}
