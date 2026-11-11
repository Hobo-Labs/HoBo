import { describe, expect, it } from "vitest";
import { createPollIngestCoalesce } from "../src/isolated-worker/poll-ingest-coalesce.js";

describe("poll ingest coalesce", () => {
	it("does not back off duplicate ingest (store may need duplicate-recheck)", () => {
		const clock = 0;
		const coalesce = createPollIngestCoalesce({
			now: () => clock,
			minMs: 10_000,
			maxMs: 40_000,
		});
		expect(coalesce.shouldSkip(1, 100, 1)).toBe(false);
		coalesce.observe(1, 100, 1, "duplicate");
		expect(coalesce.shouldSkip(1, 100, 1)).toBe(false);
	});

	it("clears backoff after an acceptance", () => {
		const coalesce = createPollIngestCoalesce({ now: () => 0 });
		coalesce.observe(1, 200, 1, "waiting-for-budget-or-capacity");
		expect(coalesce.shouldSkip(1, 200, 1)).toBe(true);
		coalesce.observe(1, 200, 1, "accepted");
		expect(coalesce.shouldSkip(1, 200, 1)).toBe(false);
	});

	it("widens backoff on repeated quiet streaks", () => {
		let clock = 0;
		const coalesce = createPollIngestCoalesce({
			now: () => clock,
			minMs: 5_000,
			maxMs: 50_000,
		});
		coalesce.observe(1, 300, 1, "waiting-for-budget-or-capacity");
		clock = 5_001;
		expect(coalesce.shouldSkip(1, 300, 1)).toBe(false);
		coalesce.observe(1, 300, 1, "waiting-for-budget-or-capacity");
		clock = 14_999;
		expect(coalesce.shouldSkip(1, 300, 1)).toBe(true);
		clock = 15_001;
		expect(coalesce.shouldSkip(1, 300, 1)).toBe(false);
	});

	it("backs off requeued and foreign-runner poll results", () => {
		const coalesce = createPollIngestCoalesce({ now: () => 0 });
		coalesce.observe(1, 500, 1, "requeued");
		expect(coalesce.shouldSkip(1, 500, 1)).toBe(true);
		coalesce.observe(1, 501, 1, "foreign-runner");
		expect(coalesce.shouldSkip(1, 501, 1)).toBe(true);
	});

	it("forces ingest when the job has been queued longer than maxMs", () => {
		const maxMs = 50_000;
		const nowMs = 1_000_000;
		const coalesce = createPollIngestCoalesce({
			now: () => nowMs,
			minMs: 5_000,
			maxMs,
		});
		coalesce.observe(1, 400, 1, "waiting-for-budget-or-capacity");
		expect(coalesce.shouldSkip(1, 400, 1)).toBe(true);
		const queuedSinceMs = nowMs - maxMs;
		expect(coalesce.shouldSkip(1, 400, 1, queuedSinceMs)).toBe(false);
		expect(coalesce.shouldSkip(1, 400, 1)).toBe(false);
	});
});
