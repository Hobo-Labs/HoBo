/** One job as GitHub's `runs/{id}/jobs` lists it. */
export type JobObservation = Readonly<{
	repository: string;
	id: number;
	name: string;
	conclusion?: string | null | undefined;
	startedAt?: string | null | undefined;
	completedAt?: string | null | undefined;
}>;

export interface JobDurations {
	/** Learns a job's name, and its duration once it succeeded. Idempotent per job id. */
	observe(job: JobObservation): void;
	/** Median of the last successful runs of the job's name in its repository; 0 when unknown. */
	expectedMs(repository: string, jobId: number): number;
}

const SAMPLES = 5;
const LIMIT = 2000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.delete(key);
	if (map.size >= LIMIT) {
		const oldest = map.keys().next();
		if (!oldest.done) map.delete(oldest.value);
	}
	map.set(key, value);
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const upper = sorted[middle] ?? 0;
	return sorted.length % 2 === 1
		? upper
		: ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/**
 * In-memory duration history keyed by repository and job name. Only
 * successful runs count: a skipped job takes no time and a failed one may stop
 * early, and neither says how long the job holds a slot when it passes.
 */
export function createJobDurations(): JobDurations {
	const names = new Map<number, string>();
	const samples = new Map<string, number[]>();
	const counted = new Map<number, true>();
	return {
		observe(job) {
			const key = `${job.repository.toLowerCase()}\n${job.name}`;
			if (names.get(job.id) !== key) remember(names, job.id, key);
			if (job.conclusion !== "success" || counted.has(job.id)) return;
			const durationMs =
				Date.parse(job.completedAt ?? "") - Date.parse(job.startedAt ?? "");
			if (!Number.isFinite(durationMs) || durationMs < 0) return;
			remember(counted, job.id, true);
			remember(
				samples,
				key,
				[...(samples.get(key) ?? []), durationMs].slice(-SAMPLES),
			);
		},
		expectedMs(repository, jobId) {
			const key = names.get(jobId);
			if (key === undefined || !key.startsWith(`${repository.toLowerCase()}\n`))
				return 0;
			const recent = samples.get(key);
			return recent ? median(recent) : 0;
		},
	};
}
