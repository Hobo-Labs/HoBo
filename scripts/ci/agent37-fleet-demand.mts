#!/usr/bin/env node

export const AGENT37_QUEUE_LABELS = ["agent37", "hobo-agent37"] as const;

export const MERGE_GROUP_SCRIPTS_SHARD_COUNT = 4;

export const DEFAULT_AGENT37_SLOTS_PER_BOX = 1;

export const DEFAULT_RESERVED_IDLE_SLOTS_PER_BOX = 1;

const AGENT37_LABELS = new Set<string>(AGENT37_QUEUE_LABELS);

export type Agent37FleetJob = Readonly<{
	status?: string | null | undefined;
	labels?: readonly string[] | null | undefined;
}>;

const QUEUED = new Set(["queued", "waiting", "pending"]);

export function jobRequiresAgent37Runner(job: Agent37FleetJob): boolean {
	const status = job.status?.trim().toLowerCase() ?? "";
	if (!QUEUED.has(status)) return false;
	const labels = job.labels ?? [];
	return labels.some((label) => AGENT37_LABELS.has(label));
}

export function countAgent37QueuedJobs(
	jobs: readonly Agent37FleetJob[],
): number {
	return jobs.filter(jobRequiresAgent37Runner).length;
}

export type Agent37FleetDemandInput = Readonly<{
	queuedAgent37Jobs: number;
	idleRunnerSlots: number;
	onlineBoxes?: number;
	provisioningBoxes?: number;
	slotsPerBox?: number;
	reservedIdleSlotsPerBox?: number;
	mergeGroupRunsActive?: number;
	scriptsShardsPerMergeGroup?: number;
}>;

export function agent37RunnerSlotsPerBox(
	slotsPerBox = DEFAULT_AGENT37_SLOTS_PER_BOX,
	reservedIdleSlotsPerBox = DEFAULT_RESERVED_IDLE_SLOTS_PER_BOX,
): number {
	const slots = Math.max(1, Math.floor(slotsPerBox));
	const reserve = Math.max(0, Math.floor(reservedIdleSlotsPerBox));
	return Math.max(1, slots - reserve);
}

export function mergeGroupAgent37BoxFloor(
	mergeGroupRunsActive: number,
	options?: Readonly<{
		scriptsShardsPerMergeGroup?: number;
		slotsPerBox?: number;
	}>,
): number {
	if (mergeGroupRunsActive <= 0) return 0;
	const shards =
		options?.scriptsShardsPerMergeGroup ?? MERGE_GROUP_SCRIPTS_SHARD_COUNT;
	const slots = Math.max(
		1,
		options?.slotsPerBox ?? DEFAULT_AGENT37_SLOTS_PER_BOX,
	);
	return Math.ceil((shards * mergeGroupRunsActive) / slots);
}

export function agent37BoxesToCreate(input: Agent37FleetDemandInput): number {
	const slotsPerBox = Math.max(
		1,
		input.slotsPerBox ?? DEFAULT_AGENT37_SLOTS_PER_BOX,
	);
	const reserved =
		input.reservedIdleSlotsPerBox ?? DEFAULT_RESERVED_IDLE_SLOTS_PER_BOX;
	const effectiveSlotsPerBox = agent37RunnerSlotsPerBox(slotsPerBox, reserved);
	const provisioning = Math.max(0, input.provisioningBoxes ?? 0);
	const supply =
		Math.max(0, input.idleRunnerSlots) + provisioning * slotsPerBox;
	const queueShortfall = Math.max(0, input.queuedAgent37Jobs - supply);
	const boxesForQueue =
		queueShortfall === 0 ? 0 : Math.ceil(queueShortfall / effectiveSlotsPerBox);
	const floor = mergeGroupAgent37BoxFloor(
		input.mergeGroupRunsActive ?? 0,
		input.scriptsShardsPerMergeGroup === undefined
			? { slotsPerBox }
			: {
					slotsPerBox,
					scriptsShardsPerMergeGroup: input.scriptsShardsPerMergeGroup,
				},
	);
	const online = Math.max(0, input.onlineBoxes ?? 0);
	const boxesForFloor = Math.max(0, floor - online - provisioning);
	return Math.max(boxesForQueue, boxesForFloor);
}

export type Agent37DemandSnapshot = Readonly<{
	queuedAgent37Jobs: number;
	boxesToCreate: number;
	effectiveSlotsPerBox: number;
	mergeGroupBoxFloor: number;
}>;

export function agent37DemandSnapshot(
	jobs: readonly Agent37FleetJob[],
	capacity: Omit<Agent37FleetDemandInput, "queuedAgent37Jobs">,
): Agent37DemandSnapshot {
	const queuedAgent37Jobs = countAgent37QueuedJobs(jobs);
	const slotsPerBox = capacity.slotsPerBox ?? DEFAULT_AGENT37_SLOTS_PER_BOX;
	const reserved =
		capacity.reservedIdleSlotsPerBox ?? DEFAULT_RESERVED_IDLE_SLOTS_PER_BOX;
	const mergeGroupBoxFloor = mergeGroupAgent37BoxFloor(
		capacity.mergeGroupRunsActive ?? 0,
		capacity.scriptsShardsPerMergeGroup === undefined
			? { slotsPerBox }
			: {
					slotsPerBox,
					scriptsShardsPerMergeGroup: capacity.scriptsShardsPerMergeGroup,
				},
	);
	return {
		queuedAgent37Jobs,
		boxesToCreate: agent37BoxesToCreate({
			queuedAgent37Jobs,
			...capacity,
		}),
		effectiveSlotsPerBox: agent37RunnerSlotsPerBox(slotsPerBox, reserved),
		mergeGroupBoxFloor,
	};
}
