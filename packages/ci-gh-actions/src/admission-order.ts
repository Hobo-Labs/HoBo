import { type GithubTransport, getRun } from "./github.js";
import type { JobDurations } from "./job-durations.js";

/** Where a job's run stands in line for a host: lower `rank` first, then the older run. */
export type AdmissionKey = Readonly<{ rank: number; startedAtMs: number }>;

/**
 * Merge-queue entries and trunk runs gate every other merge, so a shared host
 * admits them before pull-request work. A weekly sweep waits for both.
 */
export function admissionRank(event: string): number {
	switch (event) {
		case "merge_group":
		case "push":
		case "workflow_dispatch":
			return 0;
		case "schedule":
			return 2;
		default:
			return 1;
	}
}

const UNKNOWN: AdmissionKey = {
	rank: 1,
	startedAtMs: Number.POSITIVE_INFINITY,
};
const CACHE_LIMIT = 1000;

export type AdmissionRef = Readonly<{
	installationId: number;
	repository: string;
	runId: number;
	jobId: number;
}>;

/**
 * Orders demand for a host. A run's event and start time never change for an
 * attempt, so each run is looked up once; a failed lookup ranks the job with
 * pull requests and behind them, and is retried on the next tick. Within one
 * rank and run age, the job expected to take longest goes first, so the run's
 * long pole is not left to start last on a freed slot; a job with no history
 * expects 0 and the job id breaks remaining ties.
 */
export function createAdmissionOrder(
	github: GithubTransport,
	durations?: Pick<JobDurations, "expectedMs">,
) {
	const runs = new Map<number, AdmissionKey>();
	async function keyFor(ref: AdmissionRef): Promise<AdmissionKey> {
		const cached = runs.get(ref.runId);
		if (cached) return cached;
		let run: Awaited<ReturnType<typeof getRun>>;
		try {
			run = await getRun(github, ref.installationId, ref.repository, ref.runId);
		} catch {
			return UNKNOWN;
		}
		const startedAtMs = Date.parse(run.run_started_at ?? "");
		const key = {
			rank: admissionRank(run.event),
			startedAtMs: Number.isFinite(startedAtMs)
				? startedAtMs
				: Number.POSITIVE_INFINITY,
		};
		if (runs.size >= CACHE_LIMIT) {
			const oldest = runs.keys().next();
			if (!oldest.done) runs.delete(oldest.value);
		}
		runs.set(ref.runId, key);
		return key;
	}
	return async function order<T>(
		items: readonly T[],
		refOf: (item: T) => AdmissionRef,
	): Promise<T[]> {
		const keyed: {
			item: T;
			key: AdmissionKey;
			expectedMs: number;
			jobId: number;
		}[] = [];
		for (const item of items) {
			const ref = refOf(item);
			keyed.push({
				item,
				key: await keyFor(ref),
				expectedMs: durations?.expectedMs(ref.repository, ref.jobId) ?? 0,
				jobId: ref.jobId,
			});
		}
		return keyed
			.sort(
				(a, b) =>
					a.key.rank - b.key.rank ||
					a.key.startedAtMs - b.key.startedAtMs ||
					b.expectedMs - a.expectedMs ||
					a.jobId - b.jobId,
			)
			.map((entry) => entry.item);
	};
}
