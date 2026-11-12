/**
 * Topology, credentials, auth callout and the bus ports over NATS (L08).
 * Signatures frozen by the fleet contract commit (ADR-0182).
 */
import type { TenantId } from "@hobo/core";
import {
	type AuthorityBus,
	type Clock,
	type FleetBusConnector,
	type FleetLog,
	FleetNotImplemented,
	type RegistryView,
	type ReplayStore,
	type Subscription,
	type TrustRecord,
} from "@hobo/fleet";

/** Creates the tenant account, its static users and scoped signing keys, and its streams and buckets. */
export function provisionTopology(
	input: Readonly<{
		servers: readonly string[];
		operatorSigningSeed: string;
		tenant: TenantId;
		replicas: 1 | 3;
	}>,
): Promise<
	Readonly<{
		accountPublicKey: string;
		staticCredentials: Readonly<
			Record<"authority" | "witness" | "provisioner" | "sentinel", string>
		>;
		scopedSeeds: Readonly<
			Record<"observer" | "executor" | "dispatcher", string>
		>;
	}>
> {
	void input;
	throw new FleetNotImplemented("provisionTopology");
}

/** A device's connection to its tenant's bus. */
export function createNatsBusConnector(): FleetBusConnector {
	throw new FleetNotImplemented("createNatsBusConnector");
}

/** The authority's connection; positions are per subscription (`BusStart`). */
export function connectAuthorityBus(
	input: Readonly<{
		servers: readonly string[];
		credentials: string;
		trust: () => TrustRecord;
		log: FleetLog;
	}>,
): Promise<AuthorityBus> {
	void input;
	throw new FleetNotImplemented("connectAuthorityBus");
}

/** Answers NATS auth callouts with user credentials scoped to the member. */
export function startCalloutResponder(
	input: Readonly<{
		servers: readonly string[];
		credentials: string;
		xkeySeed: string;
		scopedSeeds: Readonly<
			Record<"observer" | "executor" | "dispatcher", string>
		>;
		registry: RegistryView;
		replay: ReplayStore;
		incarnation: number;
		now: Clock;
		log: FleetLog;
	}>,
): Promise<Subscription> {
	void input;
	throw new FleetNotImplemented("startCalloutResponder");
}
