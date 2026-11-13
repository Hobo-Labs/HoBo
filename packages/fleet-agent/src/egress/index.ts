/**
 * The per-order egress proxy (L38, design §6.11 "Egress", §7.3).
 */
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type { EgressProxyFactory, FleetLog } from "@hobo/fleet";
import { createEgressProxyFactoryWith } from "./proxy.js";

/** One proxy per order: exact hosts only; link-local and metadata addresses always refused. */
export function createEgressProxyFactory(
	options: Readonly<{ fleetAllow: () => readonly string[]; log: FleetLog }>,
): EgressProxyFactory {
	return createEgressProxyFactoryWith({
		fleetAllow: options.fleetAllow,
		log: options.log,
		deps: {
			async lookup(host) {
				const found = await lookup(host, { all: true, verbatim: true });
				return found.map((entry) => entry.address);
			},
			connect(address, port) {
				return connect({ host: address, port });
			},
		},
	});
}
