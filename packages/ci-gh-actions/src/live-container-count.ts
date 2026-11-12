import type { Lease } from "@hobo/ci";

const LIVE_BOX_CONTAINER_STATES = new Set([
	"dispatching",
	"dispatched",
	"claiming",
	"running",
	"uncertain",
]);

/** Box/K8s leases that already hold a launch slot (reserved-only does not). */
export function countLiveBoxContainers(leases: readonly Lease[]): number {
	return leases.filter(
		(lease) =>
			(lease.provider === "kubernetes" ||
				lease.provider === "hobo-box-worker") &&
			LIVE_BOX_CONTAINER_STATES.has(lease.state),
	).length;
}

/** Worker launch slots not consumed by a live box container. */
export function localWorkerFreeSlots(
	launchSlots: number,
	leases: readonly Lease[],
): number {
	return Math.max(0, launchSlots - countLiveBoxContainers(leases));
}
