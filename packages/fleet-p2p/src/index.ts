/**
 * The peer-to-peer transport over iroh (L11). Signature frozen by the fleet
 * contract commit (ADR-0182).
 */
import type { FleetTransport } from "@hobo/fleet";
import { parseRelayUrls } from "./config.js";
import { createIrohBinding, loadIroh } from "./iroh.js";
import { createEndpointTransport } from "./transport.js";

/**
 * A `FleetTransport` of kind `p2p`: dials peers by endpoint id over QUIC with
 * the ALPN `hobo/fleet/1`, through `relayUrls` only (never the public relays),
 * upgrading to a direct path where hole punching succeeds. Throws
 * `FleetParseError` for a relay URL that is not `https://` (or `http://` on a
 * loopback address). On a platform without a prebuilt binding it reports
 * itself unavailable (an empty transport identity; every dial `unavailable`).
 */
export function createP2pTransport(
	options: Readonly<{ relayUrls: readonly string[] }>,
): FleetTransport {
	const relayUrls = parseRelayUrls(options.relayUrls);
	return createEndpointTransport({
		relayUrls,
		binding: () => {
			const iroh = loadIroh();
			return iroh === undefined ? undefined : createIrohBinding(iroh, {});
		},
	});
}
