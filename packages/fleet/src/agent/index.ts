/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/agent` (L07): the device agent core: enrollment, credentials,
 * the bus connection, roles, sponsored observations.
 *
 * Contract commit: the body throws `FleetNotImplemented`; L07 replaces it.
 */
import type {
	EnrollmentRequest,
	EnrollmentResponse,
	MemberRecord,
	SandboxTier,
} from "../_generated/fleet_pb.js";
import { FleetNotImplemented } from "../errors.js";
import type { AgentDeps, FleetBus, Outcome } from "../ports.js";

/** `enroll` returns the whole response, so the host can hand `overlay_joins` to its overlay before creating the overlay transport. `bus()` is the live connection while started, for createBusRelayTransport. */
export function createFleetAgent(deps: AgentDeps): Readonly<{
	enroll(
		request: Omit<EnrollmentRequest, "identityJwk" | "keyBundle">,
	): Promise<Outcome<EnrollmentResponse>>;
	start(): Promise<void>;
	drain(): Promise<void>;
	stop(): Promise<void>;
	bus(): FleetBus | undefined;
	status(): Readonly<{
		member: MemberRecord | undefined;
		bus: string;
		tiers: readonly SandboxTier[];
	}>;
}> {
	throw new FleetNotImplemented("createFleetAgent");
}
