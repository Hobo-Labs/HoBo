/**
 * The box's slot split. It comes from the committed `runnerRouting.box` in
 * `.hobo/ci.json` (ADR-0181, decision 4), never from the environment: whether the
 * box serves `hobo-trunk` decides routing, so it is committed policy.
 */
export type WorkerSlotConfig = Readonly<{
	slots: number;
	trunkSlots: number;
	mergeGroupLeases: number;
	prCapWithTrunk: number;
}>;

/** The slot fields of `runnerRouting.box`; a field left out takes its default. */
export type WorkerSlotPolicy = Readonly<Partial<WorkerSlotConfig>>;

/** The code's defaults, which the committed `runnerRouting.box` equals. */
export const DEFAULT_WORKER_SLOTS = 2;
export const DEFAULT_WORKER_MERGE_GROUP_LEASES = 1;
export const DEFAULT_WORKER_PR_CAP_WITH_TRUNK = 1;

const whole = (value: number, min: number, max: number) =>
	Number.isInteger(value) && value >= min && value <= max;

/**
 * The slot split, from the committed policy. One slot is reserved for trunk
 * by default when there are at least two. Throws on a value the policy
 * schema would refuse, so a daemon handed one refuses to start.
 */
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
