import { describe, expect, it } from "vitest";
import { createPollIngestCoalesce } from "../src/isolated-worker/poll-ingest-coalesce.js";

describe("poll ingest coalesce", () => {
	it("backs off duplicate queued observations for the same job", () => {
		let clock = 0;
		const coalesce = createPollIngestCoalesce({
			now: () => clock,
			minMs: 10_000,
			maxMs: 40_000,
		});
		expect(coalesce.shouldSkip(1, 100, 1)).toBe(false);
		coalesce.observe(1, 100, 1, "duplicate");
		expect(coalesce.shouldSkip(1, 100, 1)).toBe(true);
		clock = 9_999;
		expect(coalesce.shouldSkip(1, 100, 1)).toBe(true);
		clock = 10_001;
		expect(coalesce.shouldSkip(1, 100, 1)).toBe(false);
	});

	it("clears backoff after an acceptance", () => {
		const coalesce = createPollIngestCoalesce({ now: () => 0 });
		coalesce.observe(1, 200, 1, "duplicate");
		expect(coalesce.shouldSkip(1, 200, 1)).toBe(true);
		coalesce.observe(1, 200, 1, "accepted");
		expect(coalesce.shouldSkip(1, 200, 1)).toBe(false);
	});

	it("widens backoff on repeated duplicate streaks", () => {
		let clock = 0;
		const coalesce = createPollIngestCoalesce({
			now: () => clock,
			minMs: 5_000,
			maxMs: 50_000,
		});
		coalesce.observe(1, 300, 1, "duplicate");
		clock = 5_001;
		expect(coalesce.shouldSkip(1, 300, 1)).toBe(false);
		coalesce.observe(1, 300, 1, "duplicate");
		clock = 14_999;
		expect(coalesce.shouldSkip(1, 300, 1)).toBe(true);
		clock = 15_001;
		expect(coalesce.shouldSkip(1, 300, 1)).toBe(false);
	});
});
