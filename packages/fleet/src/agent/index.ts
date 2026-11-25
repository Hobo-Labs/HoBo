import type {
	EnrollmentRequest,
	EnrollmentResponse,
	MemberRecord,
	SandboxTier,
} from "../_generated/fleet_pb.js";
import type { AgentDeps, FleetBus, Outcome } from "../ports.js";
import { fleetAgent } from "./agent.js";

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
