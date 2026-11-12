/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * Fleet commands (L32): fleets and policy, sessions, work submission, views
 * and verdicts. Re-exported by `@hobo/fleet/membership`.
 *
 * Contract commit: the body throws `FleetNotImplemented`; L32 replaces it.
 */
import { FleetNotImplemented } from "../errors.js";
import type { AuthorityDeps, FleetCommands } from "../ports.js";

/** `mode` "authority" refuses ONE_ACTIVE in defineFleet (`fleet-policy`, rule `one-active-authority`, D39); "local" accepts it. The authority and createTestAuthority pass "authority"; createLocalFleet passes "local". */
export function createFleetCommands(
	deps: Pick<
		AuthorityDeps,
		| "tenant"
		| "store"
		| "bus"
		| "policy"
		| "decisions"
		| "recordSigner"
		| "now"
		| "log"
	> &
		Readonly<{ mode: "authority" | "local" }>,
): FleetCommands {
	throw new FleetNotImplemented("createFleetCommands");
}
