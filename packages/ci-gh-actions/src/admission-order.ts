import { type GithubTransport, getRun } from "./github.js";
import type { JobDurations } from "./job-durations.js";
import type { MergeQueuePositionSource } from "./merge-queue-order.js";
import { servedRunnerLabel, TRUNK_RUNNER_LABEL } from "./runner-labels.js";

/** Where a job's run stands in line for a host: lower `rank` first, then the older run. */
export type AdmissionKey = Readonly<{
	rank: number;
	startedAtMs: number;
	event: string;
	headSha?: string | undefined;
}>;

/** The rank of merge_group, push and workflow_dispatch runs: the ones that gate trunk. */
export const TRUNK_RANK = 0;

/** Merge-group checks outrank main-push gates on a shared trunk host. */
export function trunkEventPriority(event: string): number {
	switch (event) {
		case "merge_group":
			return 0;
		case "push":
		case "workflow_dispatch":
			return 1;
		default:
			return 2;
	}
}

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
	jobName?: string | undefined;
}>;

const MAIN_WORKSPACE_SHARD = /^Main workspace test shard (\d+)$/u;

function mainWorkspaceShardIndex(
	jobName: string | undefined,
): number | undefined {
	if (!jobName) return undefined;
	const match = MAIN_WORKSPACE_SHARD.exec(jobName);
	return match ? Number(match[1]) : undefined;
}

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
type MergeGroupSortKey = Readonly<{ position: number; stale: boolean }>;

function mergeGroupSortKey(
	headSha: string | undefined,
	snapshot: ReturnType<MergeQueuePositionSource> | undefined,
): MergeGroupSortKey {
	if (!headSha || headSha.length < 40)
		return { position: Number.POSITIVE_INFINITY, stale: false };
	if (!snapshot) return { position: Number.POSITIVE_INFINITY, stale: false };
	const position = snapshot.byHeadSha.get(headSha);
	if (position !== undefined) return { position, stale: false };
	return { position: Number.POSITIVE_INFINITY, stale: true };
}

export function createAdmissionOrder(
	github: GithubTransport,
	durations?: Pick<JobDurations, "expectedMs">,
	mergeQueuePositions?: MergeQueuePositionSource,
) {
	const runs = new Map<number, AdmissionKey>();
	function remember(
		runId: number,
		event: string,
		runStartedAt: string | null | undefined,
		runHeadSha?: string,
	): AdmissionKey {
		const parsed = Date.parse(runStartedAt ?? "");
		const cached = runs.get(runId);
		const key = {
			rank: admissionRank(event),
			startedAtMs: Number.isFinite(parsed)
				? parsed
				: (cached?.startedAtMs ?? Number.POSITIVE_INFINITY),
			event,
			headSha: runHeadSha ?? cached?.headSha,
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
			return withLabelRank(
				remember(ref.runId, run.event, run.run_started_at, run.head_sha),
			);
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
			ref: AdmissionRef;
			key: AdmissionKey;
			expectedMs: number;
			jobId: number;
		}[] = [];
		for (const item of items) {
			const ref = refOf(item);
			keyed.push({
				item,
				ref,
				key: await keyFor(ref),
				expectedMs: durations?.expectedMs(ref.repository, ref.jobId) ?? 0,
				jobId: ref.jobId,
			});
		}
		const mqSnapshot = mergeQueuePositions?.();
		return keyed
			.sort((a, b) => {
				if (a.key.rank !== b.key.rank) return a.key.rank - b.key.rank;
				if (trunkEventPriority(a.key.event) !== trunkEventPriority(b.key.event))
					return (
						trunkEventPriority(a.key.event) - trunkEventPriority(b.key.event)
					);
				if (a.key.event === "merge_group" && b.key.event === "merge_group") {
					const ga = mergeGroupSortKey(a.key.headSha, mqSnapshot);
					const gb = mergeGroupSortKey(b.key.headSha, mqSnapshot);
					if (ga.stale !== gb.stale) return ga.stale ? 1 : -1;
					if (mqSnapshot && ga.position !== gb.position)
						return ga.position - gb.position;
					return a.jobId - b.jobId;
				}
				// A superseded main push still holds cancelled jobs in GitHub's queue until the
				// workflow winds down; admit the newest push first so slots serve live trunk.
				if (a.key.event === "push" && b.key.event === "push") {
					const pushStart = (ms: number) => (Number.isFinite(ms) ? ms : 0);
					if (pushStart(a.key.startedAtMs) !== pushStart(b.key.startedAtMs))
						return pushStart(b.key.startedAtMs) - pushStart(a.key.startedAtMs);
				} else if (a.key.startedAtMs !== b.key.startedAtMs)
					return a.key.startedAtMs - b.key.startedAtMs;
				if (a.ref.runId === b.ref.runId) {
					const shardA = mainWorkspaceShardIndex(a.ref.jobName);
					const shardB = mainWorkspaceShardIndex(b.ref.jobName);
					if (shardA !== undefined && shardB !== undefined && shardA !== shardB)
						return shardA - shardB;
				}
				if (b.expectedMs !== a.expectedMs) return b.expectedMs - a.expectedMs;
				return a.jobId - b.jobId;
			})
			.map((entry) => entry.item);
	}
	return Object.assign(order, {
		prime: (run: {
			runId: number;
			event: string;
			runStartedAt?: string | null | undefined;
			headSha?: string | undefined;
		}) => {
			remember(run.runId, run.event, run.runStartedAt, run.headSha);
		},
		rank: async (ref: AdmissionRef) => (await keyFor(ref)).rank,
		event: async (ref: AdmissionRef) => (await keyFor(ref)).event,
		headSha: async (ref: AdmissionRef) => (await keyFor(ref)).headSha,
		mergeGroupKey: async (ref: AdmissionRef) => {
			const key = await keyFor(ref);
			if (key.event !== "merge_group") return undefined;
			return key.headSha ?? `run:${ref.runId}`;
		},
		mergeGroupKeyForLease: async (lease: {
			installationId: number;
			repository: string;
			originalRunId: number;
			jobId: number;
			actualJobId: number;
			labels?: readonly string[];
		}) => {
			const ref: AdmissionRef =
				lease.labels === undefined
					? {
							installationId: lease.installationId,
							repository: lease.repository,
							runId: lease.originalRunId,
							jobId: lease.actualJobId > 0 ? lease.actualJobId : lease.jobId,
						}
					: {
							installationId: lease.installationId,
							repository: lease.repository,
							runId: lease.originalRunId,
							jobId: lease.actualJobId > 0 ? lease.actualJobId : lease.jobId,
							labels: lease.labels,
						};
			const key = await keyFor(ref);
			if (key.event !== "merge_group") return undefined;
			return key.headSha ?? `run:${ref.runId}`;
		},
	});
}

export type AdmissionOrder = ReturnType<typeof createAdmissionOrder>;
