import { ACTIVE_STATES, type Lease } from "@hobo/ci";
import { hasIsolatedStopIntent } from "./isolated-worker/lease-reconciler.js";

export function leaseOccupiesWorkerMemory(lease: Lease): boolean {
	if (!ACTIVE_STATES.has(lease.state)) return false;
	if (hasIsolatedStopIntent(lease)) return false;
	if (lease.sandboxStage === "stopped") return false;
	if (
		lease.state === "reserved" &&
		!lease.sandboxName &&
		!lease.sandboxSessionId
	)
		return true;
	return leaseOccupiesWorkerResources(lease);
}

export function leaseOccupiesWorkerResources(lease: Lease): boolean {
	if (!ACTIVE_STATES.has(lease.state)) return false;
	if (hasIsolatedStopIntent(lease)) return false;
	if (
		lease.state === "reserved" &&
		!lease.sandboxName &&
		!lease.sandboxSessionId
	)
		return false;
	if (lease.sandboxStage === "stopped") return false;
	return true;
}

export function leaseOccupiesMergeGroupCap(lease: Lease): boolean {
	return leaseOccupiesWorkerResources(lease);
}
