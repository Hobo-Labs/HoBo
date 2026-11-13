/**
 * O39: the conformance suites catch broken adapters. The in-memory adapters
 * pass their suites, and for each assertion of each suite a double broken in
 * exactly that way fails exactly that assertion.
 */
import { describe } from "vitest";
import { SandboxTier } from "../../src/_generated/fleet_pb.js";
import { BUS_ASSERTIONS } from "../../src/testing/conformance/bus.js";
import {
	runBusConformance,
	runJournalConformance,
	runKeyStoreConformance,
	runReplicaConformance,
	runSandboxConformance,
	runTransportConformance,
} from "../../src/testing/conformance/index.js";
import { JOURNAL_ASSERTIONS } from "../../src/testing/conformance/journal.js";
import { KEYSTORE_ASSERTIONS } from "../../src/testing/conformance/keystore.js";
import { REPLICA_ASSERTIONS } from "../../src/testing/conformance/replica.js";
import { SANDBOX_ASSERTIONS } from "../../src/testing/conformance/sandbox.js";
import { TRANSPORT_ASSERTIONS } from "../../src/testing/conformance/transport.js";
import {
	createFakeSandboxDriver,
	createMemoryBus,
	createMemoryEventStore,
} from "../../src/testing/plumbing/index.js";
import { BROKEN_BUSES } from "./doubles/bus.js";
import { BROKEN_JOURNALS } from "./doubles/journal.js";
import { BROKEN_KEYSTORES, memoryKeyStore } from "./doubles/keystore.js";
import { BROKEN_REPLICAS, memoryReplica } from "./doubles/replica.js";
import { BROKEN_SANDBOXES } from "./doubles/sandbox.js";
import { BROKEN_TRANSPORTS, memoryTransports } from "./doubles/transport.js";
import { eachAssertionCatchesItsBreak } from "./harness.js";

describe("runBusConformance", () => {
	describe("the in-memory bus passes", () => {
		runBusConformance(async () => createMemoryBus(Date.now));
	});
	describe("broken buses fail", () => {
		eachAssertionCatchesItsBreak(BUS_ASSERTIONS, BROKEN_BUSES);
	});
});

describe("runTransportConformance", () => {
	describe("an in-memory transport pair passes", () => {
		runTransportConformance(memoryTransports);
	});
	describe("broken transports fail", () => {
		eachAssertionCatchesItsBreak(
			TRANSPORT_ASSERTIONS,
			BROKEN_TRANSPORTS,
			120_000,
		);
	});
});

describe("runSandboxConformance", () => {
	describe("the fake sandbox driver passes", () => {
		runSandboxConformance(() =>
			createFakeSandboxDriver(SandboxTier.S1_CONTAINER),
		);
	});
	describe("broken sandbox drivers fail", () => {
		eachAssertionCatchesItsBreak(SANDBOX_ASSERTIONS, BROKEN_SANDBOXES);
	});
});

describe("runKeyStoreConformance", () => {
	describe("an in-memory key store passes", () => {
		runKeyStoreConformance(memoryKeyStore);
	});
	describe("broken key stores fail", () => {
		eachAssertionCatchesItsBreak(KEYSTORE_ASSERTIONS, BROKEN_KEYSTORES);
	});
});

describe("runReplicaConformance", () => {
	describe("an in-memory replica keeping the register's rules passes", () => {
		runReplicaConformance(memoryReplica);
	});
	describe("broken replicas fail", () => {
		eachAssertionCatchesItsBreak(REPLICA_ASSERTIONS, BROKEN_REPLICAS);
	});
});

describe("runJournalConformance", () => {
	describe("the in-memory event store passes", () => {
		runJournalConformance(async () => createMemoryEventStore());
	});
	describe("broken event stores fail", () => {
		eachAssertionCatchesItsBreak(JOURNAL_ASSERTIONS, BROKEN_JOURNALS);
	});
});
