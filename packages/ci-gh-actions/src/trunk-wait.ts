export type TrunkWaitReason =
	| "lease-capacity"
	| "storage"
	| "headroom"
	| "fleet-capacity";

export type TrunkWaitState = Readonly<{
	sinceMs: number;
	logged: boolean;
	reason: TrunkWaitReason;
}>;

export type TrunkWaitCache = Map<string, TrunkWaitState>;

/** Default wait before a headroom/storage-blocked trunk job is offered to fleet. */
// public-contract: bounds box memory hold without lowering standard class sizes.
export const DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS = 45_000;

export function trunkWaitKey(
	job: Readonly<{ repository: string; id: number; runAttempt: number }>,
): string {
	return `${job.repository}:${job.id}:${job.runAttempt}`;
}

export function trunkWaitFleetDeferEligible(
	wait: TrunkWaitState | undefined,
	deferMs: number,
	nowMs: number,
): boolean {
	if (!wait) return false;
	if (wait.reason !== "headroom" && wait.reason !== "storage") return false;
	return nowMs - wait.sinceMs >= deferMs;
}
