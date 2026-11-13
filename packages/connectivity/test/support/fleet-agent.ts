/**
 * A test double of the fleet device agent (`createFleetAgent` of
 * `@hobo/fleet/agent`, frozen in design §7.3) for the junction agent's tests:
 * it records what the junction asked of it, in order, and answers enrollment
 * with the overlay joins it is given.
 */
import {
	type EnrollmentRequest,
	type FleetTransport,
	type OverlayJoin,
	Role,
} from "@hobo/fleet";
import type { JunctionFleet, JunctionFleetAgent } from "../../src/index.js";

export type FleetCall =
	| Readonly<{ kind: "agent"; transports: readonly FleetTransport[] }>
	| Readonly<{
			kind: "enroll";
			request: Omit<EnrollmentRequest, "identityJwk" | "keyBundle">;
	  }>
	| Readonly<{ kind: "start" | "stop" }>;

export function overlayJoin(
	provider: string,
	credential: string,
	expiresAt = new Date(Date.now() + 600_000).toISOString(),
): OverlayJoin {
	return {
		$typeName: "hobo.fleet.v1.OverlayJoin",
		provider,
		credential,
		expiresAt,
		tags: ["tag:hobo-fleet"],
	};
}

export function enrollmentRequest(
	roles: readonly Role[] = [],
): Omit<EnrollmentRequest, "identityJwk" | "keyBundle"> {
	return {
		$typeName: "hobo.fleet.v1.EnrollmentRequest",
		tenant: "acme",
		fleet: "flt_junctions",
		name: "junction-aws-1",
		displayName: "junction-aws-1",
		region: "eu-west-1",
		agentVersion: "1.0.0",
		deviceClass: 0,
		requestedRoles: [...roles],
		proof: { case: "bootstrapToken", value: "hft_test-token" },
		certificateChainPem: [],
		heldKey: false,
	};
}

/** The junction's fleet, and what was asked of it. */
export type FleetDouble = { fleet: JunctionFleet; calls: FleetCall[] };

export function fleetDouble(
	options: Readonly<{
		joins?: readonly OverlayJoin[];
		enrollFails?: boolean;
		startFails?: boolean;
		enrollment?: Omit<EnrollmentRequest, "identityJwk" | "keyBundle">;
	}> = {},
): FleetDouble {
	const calls: FleetCall[] = [];
	const agent = (transports: readonly FleetTransport[]): JunctionFleetAgent => {
		calls.push({ kind: "agent", transports });
		return {
			async enroll(request) {
				calls.push({ kind: "enroll", request });
				if (options.enrollFails === true)
					return {
						ok: false,
						error: { code: "token-invalid", message: "the token was used" },
					};
				return {
					ok: true,
					value: {
						$typeName: "hobo.fleet.v1.EnrollmentResponse",
						overlayJoins: [...(options.joins ?? [])],
					},
				};
			},
			async start() {
				calls.push({ kind: "start" });
				if (options.startFails === true) throw new Error("no authority");
			},
			async drain() {},
			async stop() {
				calls.push({ kind: "stop" });
			},
			bus: () => undefined,
			status: () => ({ member: undefined, bus: "disconnected", tiers: [] }),
		};
	};
	return {
		fleet:
			options.enrollment === undefined
				? { agent }
				: { agent, enrollment: options.enrollment },
		calls,
	};
}

export { Role };
