import { type GithubTransport, getRun } from "./github.js";
import type { JobDurations } from "./job-durations.js";
import { servedRunnerLabel, TRUNK_RUNNER_LABEL } from "./runner-labels.js";

/** Where a job's run stands in line for a host: lower `rank` first, then the older run. */
export type AdmissionKey = Readonly<{
	rank: number;
	startedAtMs: number;
	event: string;
}>;

/** The rank of merge_group, push and workflow_dispatch runs: the ones that gate trunk. */
export const TRUNK_RANK = 0;

/**
 * Merge-queue entries and trunk runs gate every other merge, so a shared host
 * admits them before pull-request work. A weekly sweep waits for both.
 */
export function admissionRank(event: string): number {
	switch (event) {
		case "merge_group":
		case "push":
		case "workflow_dispatch":
			return TRUNK_RANK;
		case "schedule":
			return 2;
		default:
			return 1;
	}
}

const UNKNOWN: AdmissionKey = {
	rank: 1,
	startedAtMs: Number.POSITIVE_INFINITY,
	event: "unknown",
};
const CACHE_LIMIT = 1000;

export type AdmissionRef = Readonly<{
	installationId: number;
	repository: string;
	runId: number;
	jobId: number;
	labels?: readonly string[];
}>;

/**
 * Orders demand for a host. A run's event and start time never change for an
 * attempt, so a complete entry is looked up once. The rank is remembered before
 * the start time arrives; a failed lookup keeps it, while an unseen run ranks
 * behind pull requests and retries next tick. The trunk-only label proves trunk
 * rank even without run metadata. Within one rank and run age, the job expected
 * to take longest goes first, so the run's long pole is not left to start last
 * on a freed slot; a job with no history expects 0 and the job id breaks
 * remaining ties.
 */
export function createAdmissionOrder(
	github: GithubTransport,
	durations?: Pick<JobDurations, "expectedMs">,
) {
	const runs = new Map<number, AdmissionKey>();
	function remember(
		runId: number,
		event: string,
		runStartedAt: string | null | undefined,
	): AdmissionKey {
		const parsed = Date.parse(runStartedAt ?? "");
		const cached = runs.get(runId);
		const key = {
			rank: admissionRank(event),
			startedAtMs: Number.isFinite(parsed)
				? parsed
				: (cached?.startedAtMs ?? Number.POSITIVE_INFINITY),
			event,
		};
		if (!runs.has(runId) && runs.size >= CACHE_LIMIT) {
			const oldest = runs.keys().next();
			if (!oldest.done) runs.delete(oldest.value);
		}
		runs.set(runId, key);
		return key;
	}
	async function keyFor(ref: AdmissionRef): Promise<AdmissionKey> {
		const cached = runs.get(ref.runId);
		const withLabelRank = (key: AdmissionKey): AdmissionKey =>
			servedRunnerLabel(ref.labels ?? []) === TRUNK_RUNNER_LABEL
				? { ...key, rank: TRUNK_RANK }
				: key;
		if (cached && Number.isFinite(cached.startedAtMs))
			return withLabelRank(cached);
		try {
			const run = await getRun(
				github,
				ref.installationId,
				ref.repository,
				ref.runId,
			);
			return withLabelRank(remember(ref.runId, run.event, run.run_started_at));
		} catch {
			return withLabelRank(cached ?? UNKNOWN);
		}
	}
	async function order<T>(
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
	}
	return Object.assign(order, {
		prime: (run: {
			runId: number;
			event: string;
			runStartedAt?: string | null | undefined;
		}) => {
			remember(run.runId, run.event, run.runStartedAt);
		},
		rank: async (ref: AdmissionRef) => (await keyFor(ref)).rank,
		event: async (ref: AdmissionRef) => (await keyFor(ref)).event,
	});
}

export type AdmissionOrder = ReturnType<typeof createAdmissionOrder>;
