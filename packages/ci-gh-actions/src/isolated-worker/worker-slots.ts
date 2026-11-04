export type WorkerSlotConfig = Readonly<{
	slots: number;
	trunkSlots: number;
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
	return { slots, trunkSlots };
}
