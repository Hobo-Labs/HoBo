/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/transport` (L28): session authorisation, AEAD framing,
 * transport selection, the session server and blob fetch (§6.12).
 *
 * Contract commit: every body throws `FleetNotImplemented`; L28 replaces them.
 */
import type { SessionGrant, SignedEnvelope } from "../_generated/fleet_pb.js";
import { FleetNotImplemented } from "../errors.js";
import type { MemberId } from "../ids.js";
import type {
	Clock,
	DeviceKeys,
	FleetBus,
	FleetLog,
	FleetStream,
	FleetTransport,
	Outcome,
	RegistryView,
	Sandbox,
	Subscription,
} from "../ports.js";

export function authoriseSession(
	peer: string,
	grant: SignedEnvelope,
	context: Readonly<{
		self: MemberId;
		registry: RegistryView;
		nowMs: number;
	}>,
): Promise<Outcome<SessionGrant>> {
	throw new FleetNotImplemented("authoriseSession");
}

/** AEAD frames, counter nonce. */
export function frameStream(
	raw: FleetStream,
	keys: Readonly<{ send: Uint8Array; receive: Uint8Array }>,
): FleetStream {
	throw new FleetNotImplemented("frameStream");
}

export function selectTransport(
	transports: readonly FleetTransport[],
	grant: SignedEnvelope,
	signal: AbortSignal,
	log: FleetLog,
): Promise<Outcome<FleetStream>> {
	throw new FleetNotImplemented("selectTransport");
}

export function serveSessions(
	deps: Readonly<{
		transports: readonly FleetTransport[];
		registry: RegistryView;
		self: DeviceKeys;
		sandboxOf(orderId: string): Sandbox | undefined;
		bus: FleetBus;
		now: Clock;
		log: FleetLog;
	}>,
): Subscription {
	throw new FleetNotImplemented("serveSessions");
}

/** Verifies the digest before completing. */
export function fetchBlob(
	stream: FleetStream,
	digest: string,
): AsyncIterable<Uint8Array> {
	throw new FleetNotImplemented("fetchBlob");
}
