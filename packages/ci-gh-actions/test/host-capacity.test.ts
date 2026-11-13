import { describe, expect, it } from "vitest";
import { createHostCapacityTracker } from "../src/isolated-worker/host-capacity.js";

describe("host capacity tracker", () => {
	it("grows the inode safety margin from observed volatility", () => {
		let nowMs = 0;
		const tracker = createHostCapacityTracker({
			now: () => nowMs,
			windowMs: 120_000,
			minInodeMargin: 25_000,
			maxInodeMargin: 300_000,
		});
		tracker.record({ freeInodes: 800_000, freeBytes: 1_000_000 });
		expect(tracker.marginInodes()).toBe(25_000);
		nowMs += 1_000;
		tracker.record({ freeInodes: 500_000, freeBytes: 800_000 });
		expect(tracker.marginInodes()).toBe(300_000);
	});

	it("blocks admission on memory PSI pressure", () => {
		const tracker = createHostCapacityTracker({ psiSomeBlock: 10 });
		tracker.record({
			freeInodes: 500_000,
			freeBytes: 1,
			psiMemorySome: 12,
		});
		expect(tracker.shouldBlockAdmission()).toBe(true);
		expect(tracker.blockReason()).toBe("psi-memory-some");
	});

	it("reports external inode drain in the snapshot window", () => {
		let nowMs = 0;
		const tracker = createHostCapacityTracker({ now: () => nowMs });
		tracker.record({ freeInodes: 900_000, freeBytes: 1 });
		nowMs += 5_000;
		tracker.record({ freeInodes: 600_000, freeBytes: 1 });
		const snap = tracker.snapshot(350_000);
		expect(snap.observedFreeInodes).toBe(600_000);
		expect(snap.ourReservedInodes).toBe(350_000);
		expect(snap.externalInodeDrain).toBe(300_000);
	});
});
