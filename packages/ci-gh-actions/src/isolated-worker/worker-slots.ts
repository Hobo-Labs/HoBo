export type WorkerSlotConfig = Readonly<{
	slots: number;
	trunkSlots: number;
	mergeGroupLeases: number;
	prCapWithTrunk: number;
}>;

export type WorkerSlotPolicy = Readonly<Partial<WorkerSlotConfig>>;

export const DEFAULT_WORKER_SLOTS = 2;
export const DEFAULT_WORKER_MERGE_GROUP_LEASES = 1;
export const DEFAULT_WORKER_PR_CAP_WITH_TRUNK = 1;

const whole = (value: number, min: number, max: number) =>
	Number.isInteger(value) && value >= min && value <= max;

export function resolveWorkerSlotConfig(
	policy: WorkerSlotPolicy = {},
): WorkerSlotConfig {
	const slots = policy.slots ?? DEFAULT_WORKER_SLOTS;
	if (!whole(slots, 1, 8)) throw new Error("invalid runnerRouting.box.slots");
	const trunkSlots = policy.trunkSlots ?? (slots >= 2 ? 1 : 0);
	if (!whole(trunkSlots, 0, slots - 1))
		throw new Error("invalid runnerRouting.box.trunkSlots");
	const mergeGroupLeases =
		policy.mergeGroupLeases ?? DEFAULT_WORKER_MERGE_GROUP_LEASES;
	if (!whole(mergeGroupLeases, 1, 8))
		throw new Error("invalid runnerRouting.box.mergeGroupLeases");
	const prCapWithTrunk =
		policy.prCapWithTrunk ?? DEFAULT_WORKER_PR_CAP_WITH_TRUNK;
	if (!whole(prCapWithTrunk, 0, 8))
		throw new Error("invalid runnerRouting.box.prCapWithTrunk");
	return { slots, trunkSlots, mergeGroupLeases, prCapWithTrunk };
}
