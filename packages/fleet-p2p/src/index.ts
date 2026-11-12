/**
 * The peer-to-peer transport over iroh (L11).
 * Signature frozen by the fleet contract commit (ADR-0182).
 */
import { FleetNotImplemented, type FleetTransport } from "@hobo/fleet";

/** A `FleetTransport` of kind `p2p`: dials peers by key over QUIC, falling back to `relayUrls`. */
export function createP2pTransport(
	options: Readonly<{ relayUrls: readonly string[] }>,
): FleetTransport {
	void options;
	throw new FleetNotImplemented("createP2pTransport");
}
