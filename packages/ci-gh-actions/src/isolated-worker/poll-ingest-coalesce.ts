const QUIET_RESULTS = new Set([
	"duplicate",
	"ignored",
	"waiting-for-budget-or-capacity",
	"waiting-for-assignment-recovery",
	"queued",
]);

export type PollIngestCoalesceOptions = Readonly<{
	now?: () => number;
	minMs?: number;
	maxMs?: number;
}>;

/** Back off re-ingesting the same queued job when the store already holds it. */
export function createPollIngestCoalesce(
	options: PollIngestCoalesceOptions = {},
) {
	const now = options.now ?? Date.now;
	const minMs = options.minMs ?? 15_000;
	const maxMs = options.maxMs ?? 300_000;
	if (
		!Number.isInteger(minMs) ||
		minMs < 5_000 ||
		!Number.isInteger(maxMs) ||
		maxMs < minMs
	)
		throw new Error("invalid poll ingest coalesce bounds");
	const untilByKey = new Map<string, number>();
	const streakByKey = new Map<string, number>();

	function key(
		repositoryId: number,
		jobId: number,
		runAttempt: number,
	): string {
		return `${repositoryId}:${jobId}:${runAttempt}`;
	}

	return {
		shouldSkip(
			repositoryId: number,
			jobId: number,
			runAttempt: number,
		): boolean {
			const until = untilByKey.get(key(repositoryId, jobId, runAttempt));
			return until !== undefined && now() < until;
		},
		observe(
			repositoryId: number,
			jobId: number,
			runAttempt: number,
			result: string,
		): void {
			const jobKey = key(repositoryId, jobId, runAttempt);
			if (!QUIET_RESULTS.has(result)) {
				untilByKey.delete(jobKey);
				streakByKey.delete(jobKey);
				return;
			}
			const streak = (streakByKey.get(jobKey) ?? 0) + 1;
			streakByKey.set(jobKey, streak);
			const backoffMs = Math.min(maxMs, minMs * 2 ** Math.min(streak - 1, 4));
			untilByKey.set(jobKey, now() + backoffMs);
		},
	};
}

export type PollIngestCoalesce = ReturnType<typeof createPollIngestCoalesce>;
