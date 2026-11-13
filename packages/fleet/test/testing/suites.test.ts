/**
 * O39: the conformance suites catch broken adapters. The in-memory adapters
 * pass their suites, and for each assertion of each suite a double broken in
 * exactly that way fails exactly that assertion.
 */
import { afterAll, describe, expect, it } from "vitest";
import { SandboxTier } from "../../src/_generated/fleet_pb.js";
import { BUS_ASSERTIONS } from "../../src/testing/conformance/bus.js";
import {
	runBusConformance,
	runJournalConformance,
	runKeyStoreConformance,
	runReplicaConformance,
	runSandboxConformance,
	runSandboxIsolationProbe,
	runTransportConformance,
} from "../../src/testing/conformance/index.js";
import { ISOLATION_ASSERTIONS } from "../../src/testing/conformance/isolation.js";
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
import {
	BROKEN_ISOLATION,
	isolatedSubject,
	LEFT_BEHIND,
} from "./doubles/isolation.js";
import { BROKEN_JOURNALS } from "./doubles/journal.js";
import { BROKEN_KEYSTORES, memoryKeyStore } from "./doubles/keystore.js";
import { BROKEN_REPLICAS, memoryReplica } from "./doubles/replica.js";
import { BROKEN_SANDBOXES } from "./doubles/sandbox.js";
import { BROKEN_TRANSPORTS, memoryTransports } from "./doubles/transport.js";
import { eachAssertionCatchesItsBreak, failingAssertions } from "./harness.js";

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

describe("runSandboxIsolationProbe", () => {
	afterAll(() => {
		for (const child of LEFT_BEHIND) child.kill("SIGKILL");
	});
	describe("a simulated, well-isolated driver passes", () => {
		runSandboxIsolationProbe(isolatedSubject.make, isolatedSubject.options);
	});
	describe("simulated drivers broken in one way fail", () => {
		eachAssertionCatchesItsBreak(
			ISOLATION_ASSERTIONS,
			BROKEN_ISOLATION,
			120_000,
		);
	});
	it("fails the fake sandbox driver", async () => {
		const failing = await failingAssertions(ISOLATION_ASSERTIONS, {
			...isolatedSubject,
			make: async () => createFakeSandboxDriver(SandboxTier.S1_CONTAINER),
		});
		expect(failing).toContain(
			"the sandbox runs with no effective capabilities",
		);
		expect(failing.length).toBeGreaterThanOrEqual(
			ISOLATION_ASSERTIONS.length - 1,
		);
	}, 120_000);
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
