/**
 * `@hobo/fleet/transport` (L28): session authorisation, AEAD framing,
 * transport selection, the session server and blob fetch (§6.12).
 *
 * These are the frozen entry points of design §7.3; the modules beside this
 * file are private to the lane.
 */
import type { SessionGrant, SignedEnvelope } from "../_generated/fleet_pb.js";
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
import { authorise } from "./authorise.js";
import { fetchVerified } from "./blob.js";
import { framedStream } from "./frame.js";
import { select } from "./select.js";
import { serve } from "./serve.js";

export function authoriseSession(
	peer: string,
	grant: SignedEnvelope,
	context: Readonly<{
		self: MemberId;
		registry: RegistryView;
		nowMs: number;
	}>,
): Promise<Outcome<SessionGrant>> {
	return authorise(peer, grant, context);
}

/** AEAD frames, counter nonce. */
export function frameStream(
	raw: FleetStream,
	keys: Readonly<{ send: Uint8Array; receive: Uint8Array }>,
): FleetStream {
	return framedStream(raw, keys);
}

export function selectTransport(
	transports: readonly FleetTransport[],
	grant: SignedEnvelope,
	signal: AbortSignal,
	log: FleetLog,
): Promise<Outcome<FleetStream>> {
	return select(transports, grant, signal, log);
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
	return serve(deps);
}

/** Verifies the digest before completing. */
export function fetchBlob(
	stream: FleetStream,
	digest: string,
): AsyncIterable<Uint8Array> {
	return fetchVerified(stream, digest);
}
