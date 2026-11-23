import { z } from "zod";

export type MachineJobOffer = Readonly<{
	jobId: number;
	runId: number;
	repository: string;
	labels: readonly string[];
	private: boolean;
	fork: boolean;
}>;

export interface MachineJobSource {
	take(limit: number, nowMs: number): Promise<readonly MachineJobOffer[]>;
}

export interface MachineGithub {
	request(
		path: string,
		init?: Readonly<{ method?: string; body?: string }>,
	): Promise<Response>;
}

// public-contract: GitHub's REST API origin.
export const GITHUB_API_URL = "https://api.github.com";

export function userGithub(
	options: Readonly<{ fetch: typeof fetch; token: string; baseUrl?: string }>,
): MachineGithub {
	const base = (options.baseUrl ?? GITHUB_API_URL).replace(/\/+$/u, "");
	return {
		request: (path, init = {}) => {
			const headers = new Headers({
				authorization: `Bearer ${options.token}`,
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
			});
			if (init.body !== undefined)
				headers.set("content-type", "application/json");
			return options.fetch(`${base}${path}`, {
				method: init.method ?? "GET",
				headers,
				body: init.body ?? null,
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
			});
		},
	};
}

export function assignedJobSource(): MachineJobSource &
	Readonly<{ assign(offer: MachineJobOffer): void }> {
	const waiting: MachineJobOffer[] = [];
	const seen = new Set<number>();
	return {
		assign(offer) {
			if (seen.has(offer.jobId)) return;
			seen.add(offer.jobId);
			waiting.push(offer);
		},
		async take(limit) {
			return waiting.splice(0, Math.max(0, limit));
		},
	};
}

const Repository = z.object({ private: z.boolean() });
const Run = z.object({
	id: z.number().int().positive(),
	repository: z.object({ id: z.number().int() }),
	head_repository: z.object({ id: z.number().int() }).nullish(),
});
const Runs = z.object({ workflow_runs: z.array(Run) });
const Job = z.object({
	id: z.number().int().positive(),
	run_id: z.number().int().positive(),
	status: z.string(),
	labels: z.array(z.string()),
});
const Jobs = z.object({ jobs: z.array(Job) });

async function read<T>(
	github: MachineGithub,
	path: string,
	schema: z.ZodType<T>,
): Promise<T | undefined> {
	const response = await github.request(path);
	if (!response.ok) return undefined;
	const parsed = schema.safeParse(await response.json());
	return parsed.success ? parsed.data : undefined;
}

// public-contract: how often a machine with no relay reads GitHub's queue.
export const MACHINE_QUEUE_POLL_MS = 15_000;
const OFFERED_FOR_MS = 10 * 60_000;

export function githubQueueJobSource(
	options: Readonly<{
		github: MachineGithub;
		repositories: readonly string[];
		label: string;
		pollMs?: number;
	}>,
): MachineJobSource {
	const pollMs = options.pollMs ?? MACHINE_QUEUE_POLL_MS;
	const label = options.label.toLowerCase();
	const offered = new Map<number, number>();
	let lastPollMs: number | undefined;
	return {
		async take(limit, nowMs) {
			if (limit <= 0) return [];
			if (lastPollMs !== undefined && nowMs - lastPollMs < pollMs) return [];
			lastPollMs = nowMs;
			for (const [jobId, atMs] of offered)
				if (nowMs - atMs > OFFERED_FOR_MS) offered.delete(jobId);
			const found: MachineJobOffer[] = [];
			for (const repository of options.repositories) {
				if (found.length >= limit) break;
				const repo = await read(
					options.github,
					`/repos/${repository}`,
					Repository,
				);
				if (!repo) continue;
				const runs = new Map<number, z.infer<typeof Run>>();
				for (const status of ["queued", "in_progress"]) {
					const listed = await read(
						options.github,
						`/repos/${repository}/actions/runs?status=${status}&per_page=50`,
						Runs,
					);
					for (const run of listed?.workflow_runs ?? []) runs.set(run.id, run);
				}
				for (const run of runs.values()) {
					if (found.length >= limit) break;
					const jobs = await read(
						options.github,
						`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
						Jobs,
					);
					for (const job of jobs?.jobs ?? []) {
						if (found.length >= limit) break;
						if (job.status !== "queued" || offered.has(job.id)) continue;
						if (!job.labels.some((asked) => asked.toLowerCase() === label))
							continue;
						offered.set(job.id, nowMs);
						found.push({
							jobId: job.id,
							runId: run.id,
							repository,
							labels: [...job.labels],
							private: repo.private,
							fork:
								run.head_repository !== null &&
								run.head_repository !== undefined &&
								run.head_repository.id !== run.repository.id,
						});
					}
				}
			}
			return found;
		},
	};
}

export type OneJobRunner = Readonly<{
	id: number;
	name: string;
	repository: string;
	encodedJitConfig: string;
}>;

const JitResponse = z.object({
	runner: z.object({ id: z.number().int().positive() }),
	encoded_jit_config: z.string().min(1),
});

export class OneJobRunnerError extends Error {
	override readonly name = "OneJobRunnerError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export async function createOneJobRunner(
	github: MachineGithub,
	request: Readonly<{
		repository: string;
		name: string;
		labels: readonly string[];
	}>,
): Promise<OneJobRunner> {
	const response = await github.request(
		`/repos/${request.repository}/actions/runners/generate-jitconfig`,
		{
			method: "POST",
			body: JSON.stringify({
				name: request.name,
				runner_group_id: 1,
				labels: [...request.labels],
				work_folder: "_work",
			}),
		},
	);
	if (!response.ok)
		throw new OneJobRunnerError(
			response.status,
			`GitHub would not make a one-job runner on ${request.repository} (HTTP ${response.status}); the signed-in user needs admin rights on it.`,
		);
	const parsed = JitResponse.safeParse(await response.json());
	if (!parsed.success)
		throw new OneJobRunnerError(
			response.status,
			"GitHub's one-job runner answer was not understood.",
		);
	return {
		id: parsed.data.runner.id,
		name: request.name,
		repository: request.repository,
		encodedJitConfig: parsed.data.encoded_jit_config,
	};
}

export async function removeOneJobRunner(
	github: MachineGithub,
	runner: Pick<OneJobRunner, "id" | "repository">,
): Promise<boolean> {
	const response = await github.request(
		`/repos/${runner.repository}/actions/runners/${runner.id}`,
		{ method: "DELETE" },
	);
	return response.ok;
}
