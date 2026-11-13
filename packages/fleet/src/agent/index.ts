/**
 * `@hobo/fleet/agent` (L07): the device agent core: enrollment, credentials,
 * the bus connection, roles, sponsored observations (design §7.3). The
 * modules beside this file are private to the lane; ./README.md describes
 * the behaviour.
 */
import type {
	EnrollmentRequest,
	EnrollmentResponse,
	MemberRecord,
	SandboxTier,
} from "../_generated/fleet_pb.js";
import type { AgentDeps, FleetBus, Outcome } from "../ports.js";
import { fleetAgent } from "./agent.js";

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
	return fleetAgent(deps);
}
