export type WorkerSlotConfig = Readonly<{
	slots: number;
	trunkSlots: number;
	mergeGroupLeases: number;
	prCapWithTrunk: number;
}>;

export function resolveWorkerSlotConfig(
	env: Readonly<Record<string, string | undefined>>,
): WorkerSlotConfig {
	const slots = Number(env.HOBO_CI_WORKER_SLOTS ?? "2");
	if (!Number.isInteger(slots) || slots < 1 || slots > 8)
		throw new Error("invalid HOBO_CI_WORKER_SLOTS");
	const trunkSlots = Number(
		env.HOBO_CI_WORKER_TRUNK_SLOTS ?? (slots >= 2 ? "1" : "0"),
	);
	if (!Number.isInteger(trunkSlots) || trunkSlots < 0 || trunkSlots >= slots)
		throw new Error("invalid HOBO_CI_WORKER_TRUNK_SLOTS");
	const mergeGroupLeases = Number(env.HOBO_CI_WORKER_MERGE_GROUP_LEASES ?? "1");
	if (!Number.isInteger(mergeGroupLeases) || mergeGroupLeases < 1)
		throw new Error("invalid HOBO_CI_WORKER_MERGE_GROUP_LEASES");
	const prCapValue = env.HOBO_CI_WORKER_PR_CAP_WITH_TRUNK ?? "1";
	if (!/^(?:0|[1-9]\d*)$/u.test(prCapValue))
		throw new Error("invalid HOBO_CI_WORKER_PR_CAP_WITH_TRUNK");
	const prCapWithTrunk = Number(prCapValue);
	if (prCapWithTrunk > 8)
		throw new Error("invalid HOBO_CI_WORKER_PR_CAP_WITH_TRUNK");
	return { slots, trunkSlots, mergeGroupLeases, prCapWithTrunk };
}
