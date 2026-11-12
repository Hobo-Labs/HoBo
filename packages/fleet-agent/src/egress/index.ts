/**
 * The per-order egress proxy (L38). Signature frozen by the fleet contract commit (ADR-0182).
 */
import {
	type EgressProxyFactory,
	type FleetLog,
	FleetNotImplemented,
} from "@hobo/fleet";

/** One proxy per order: exact hosts only; link-local and metadata addresses always refused. */
export function createEgressProxyFactory(
	options: Readonly<{ fleetAllow: () => readonly string[]; log: FleetLog }>,
): EgressProxyFactory {
	void options;
	throw new FleetNotImplemented("createEgressProxyFactory");
}
