/**
 * Conformance suites (L29): the shared vitest suites every adapter of a fleet
 * port runs against itself. Re-exported by `@hobo/fleet/testing`.
 *
 * Each `run*` registers one vitest `describe` with one `it` per named
 * assertion of its suite; call it at the top level of an adapter's test file.
 * The assertion lists live beside this file, one file per suite, and are
 * private to this package: its own tests prove each assertion fails a double
 * broken in exactly that assertion's way (O39).
 */
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

/** Logic suite: the driver contract (single use, writeSecret never through argv or env, the fence callback answered on controlUrl, destroy idempotent). The fake driver passes it; it proves nothing about isolation. */
export function runSandboxConformance(make: () => SandboxDriver): void {
	registerSuite("sandbox conformance", SANDBOX_ASSERTIONS, make, 60_000);
}

/**
 * Isolation probe (O10): creates real sandboxes from `make` and runs probe programs inside them with Sandbox.exec, from `probeImage`.
 * Asserts: CapEff 0; no Docker socket at any path; only declared mounts and a read-only root; the metadata address, a link-local
 * address and a host outside `allow` refused; `allowedHost` reached through the proxy `egress` opened; a fork loop stopped at the pids
 * limit; this sandbox's controlUrl unreachable from a second sandbox of the same driver; no container or VM left after destroy.
 */
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
