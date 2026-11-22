import type { MemberName } from "../../ids.js";
import type {
	AssignmentReplica,
	AuthorityBus,
	EgressProxyFactory,
	FleetEventStore,
	FleetTransport,
	KeyStore,
	SandboxDriver,
} from "../../ports.js";
import { registerSuite } from "./assertion.js";
import { BUS_ASSERTIONS } from "./bus.js";
import { ISOLATION_ASSERTIONS } from "./isolation.js";
import { JOURNAL_ASSERTIONS } from "./journal.js";
import { KEYSTORE_ASSERTIONS } from "./keystore.js";
import { REPLICA_ASSERTIONS } from "./replica.js";
import { SANDBOX_ASSERTIONS } from "./sandbox.js";
import { TRANSPORT_ASSERTIONS } from "./transport.js";

export function runBusConformance(make: () => Promise<AuthorityBus>): void {
	registerSuite("bus conformance", BUS_ASSERTIONS, make, 30_000);
}

export function runTransportConformance(
	make: () => Promise<readonly [FleetTransport, FleetTransport]>,
): void {
	registerSuite("transport conformance", TRANSPORT_ASSERTIONS, make, 120_000);
}

export function runSandboxConformance(make: () => SandboxDriver): void {
	registerSuite("sandbox conformance", SANDBOX_ASSERTIONS, make, 60_000);
}

export function runSandboxIsolationProbe(
	make: () => Promise<SandboxDriver>,
	options: Readonly<{
		probeImage: string;
		allowedHost: string;
		egress: EgressProxyFactory;
	}>,
): void {
	registerSuite(
		"sandbox isolation probe",
		ISOLATION_ASSERTIONS,
		{ make, options },
		180_000,
	);
}

export function runKeyStoreConformance(make: () => KeyStore): void {
	registerSuite("key store conformance", KEYSTORE_ASSERTIONS, make, 30_000);
}

export function runReplicaConformance(
	make: (id: MemberName) => AssignmentReplica,
): void {
	registerSuite("replica conformance", REPLICA_ASSERTIONS, make, 30_000);
}

export function runJournalConformance(
	make: () => Promise<FleetEventStore>,
): void {
	registerSuite("journal conformance", JOURNAL_ASSERTIONS, make, 30_000);
}
