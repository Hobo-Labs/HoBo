/* oxlint-disable no-unused-vars -- stub until the one-active step of L05 lands. */
import { FleetNotImplemented } from "../errors.js";
import type { MemberName } from "../ids.js";
import type { OneActiveDeps, OneActiveTick, Outcome } from "../ports.js";

export function createOneActiveFleet(deps: OneActiveDeps): Readonly<{
	active(): Promise<Outcome<MemberName>>;
	tick(): Promise<OneActiveTick>;
	activate(epoch: number): Promise<void>;
}> {
	throw new FleetNotImplemented("createOneActiveFleet");
}
