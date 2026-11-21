import { FleetRejectionCode } from "../_generated/fleet_v2_pb.js";
import { rejectFleet } from "./state-machine.js";

/** CapacityGroup.seq is uint32 on the wire. Never persist an unparseable
 * revision or reuse an earlier revision when the counter is exhausted. */
export function nextCapacitySequence(sequence: number): number {
	if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 0xffffffff)
		rejectFleet(
			FleetRejectionCode.CAPACITY_CONFLICT,
			"capacity sequence exhausted; no further changes can be recorded",
		);
	return sequence + 1;
}
