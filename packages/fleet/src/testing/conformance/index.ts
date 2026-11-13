/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * Conformance suites (L29): the shared vitest suites every adapter of a fleet
 * port runs against itself. Re-exported by `@hobo/fleet/testing`.
 *
 * Contract commit: every body throws `FleetNotImplemented`; L29 replaces them.
 */
import { FleetNotImplemented } from "../../errors.js";
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
import { JOURNAL_ASSERTIONS } from "./journal.js";

export function runBusConformance(make: () => Promise<AuthorityBus>): void {
	throw new FleetNotImplemented("runBusConformance");
}

export function runTransportConformance(
	make: () => Promise<readonly [FleetTransport, FleetTransport]>,
): void {
	throw new FleetNotImplemented("runTransportConformance");
}

/** Logic suite: the driver contract (single use, writeSecret never through argv or env, the fence callback answered on controlUrl, destroy idempotent). The fake driver passes it; it proves nothing about isolation. */
export function runSandboxConformance(make: () => SandboxDriver): void {
	throw new FleetNotImplemented("runSandboxConformance");
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
	throw new FleetNotImplemented("runSandboxIsolationProbe");
}

export function runKeyStoreConformance(make: () => KeyStore): void {
	throw new FleetNotImplemented("runKeyStoreConformance");
}

export function runReplicaConformance(
	make: (id: MemberName) => AssignmentReplica,
): void {
	throw new FleetNotImplemented("runReplicaConformance");
}

export function runJournalConformance(
	make: () => Promise<FleetEventStore>,
): void {
	registerSuite("journal conformance", JOURNAL_ASSERTIONS, make, 30_000);
}
