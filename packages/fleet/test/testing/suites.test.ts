/**
 * O39: the conformance suites catch broken adapters. The in-memory adapters
 * pass their suites, and for each assertion of each suite a double broken in
 * exactly that way fails exactly that assertion.
 */
import { describe } from "vitest";
import { BUS_ASSERTIONS } from "../../src/testing/conformance/bus.js";
import {
	runBusConformance,
	runJournalConformance,
	runReplicaConformance,
} from "../../src/testing/conformance/index.js";
import { JOURNAL_ASSERTIONS } from "../../src/testing/conformance/journal.js";
import { REPLICA_ASSERTIONS } from "../../src/testing/conformance/replica.js";
import {
	createMemoryBus,
	createMemoryEventStore,
} from "../../src/testing/plumbing/index.js";
import { BROKEN_BUSES } from "./doubles/bus.js";
import { BROKEN_JOURNALS } from "./doubles/journal.js";
import { BROKEN_REPLICAS, memoryReplica } from "./doubles/replica.js";
import { eachAssertionCatchesItsBreak } from "./harness.js";

describe("runBusConformance", () => {
	describe("the in-memory bus passes", () => {
		runBusConformance(async () => createMemoryBus(Date.now));
	});
	describe("broken buses fail", () => {
		eachAssertionCatchesItsBreak(BUS_ASSERTIONS, BROKEN_BUSES);
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
