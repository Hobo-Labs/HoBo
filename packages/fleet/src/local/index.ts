/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * Local mode (L33): a process that owns its whole fleet holds the registry
 * in-process, with no authority and no bus. Re-exported by
 * `@hobo/fleet/membership`.
 *
 * Contract commit: the body throws `FleetNotImplemented`; L33 replaces it.
 */
import type { FleetRecord, MemberRecord } from "../_generated/fleet_pb.js";
import { FleetNotImplemented } from "../errors.js";
import type { LocalFleetInit, RegistryView } from "../ports.js";

export function createLocalFleet(init: LocalFleetInit): Promise<
	Readonly<{
		registry: RegistryView;
		fleet: FleetRecord;
		members: readonly MemberRecord[];
	}>
> {
	throw new FleetNotImplemented("createLocalFleet");
}
