/**
 * O39: the conformance suites catch broken adapters. The in-memory adapters
 * pass their suites, and for each assertion of each suite a double broken in
 * exactly that way fails exactly that assertion.
 */
import { describe } from "vitest";
import { runJournalConformance } from "../../src/testing/conformance/index.js";
import { JOURNAL_ASSERTIONS } from "../../src/testing/conformance/journal.js";
import { createMemoryEventStore } from "../../src/testing/plumbing/index.js";
import { BROKEN_JOURNALS } from "./doubles/journal.js";
import { eachAssertionCatchesItsBreak } from "./harness.js";

describe("runJournalConformance", () => {
	describe("the in-memory event store passes", () => {
		runJournalConformance(async () => createMemoryEventStore());
	});
	describe("broken event stores fail", () => {
		eachAssertionCatchesItsBreak(JOURNAL_ASSERTIONS, BROKEN_JOURNALS);
	});
});
