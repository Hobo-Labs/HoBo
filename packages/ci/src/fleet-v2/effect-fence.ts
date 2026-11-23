import { FleetRejectionCode } from "../_generated/fleet_v2_pb.js";
import { rejectFleet } from "./state-machine.js";

export function nextEffectFence(previous: number): number {
	if (!Number.isSafeInteger(previous) || previous < 0 || previous >= 0xffffffff)
		rejectFleet(
			FleetRejectionCode.EFFECT_NOT_CLAIMABLE,
			"effect delivery fence exhausted; no further claims can be issued",
		);
	return previous + 1;
}
