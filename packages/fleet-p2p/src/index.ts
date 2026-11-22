import type { FleetTransport } from "@hobo/fleet";
import { parseRelayUrls } from "./config.js";
import { createIrohBinding, loadIroh } from "./iroh.js";
import { createEndpointTransport } from "./transport.js";

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
