import type { Lease } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import {
	countLiveBoxContainers,
	localWorkerFreeSlots,
} from "../src/live-container-count.js";

const lease = (state: Lease["state"], sandboxName = ""): Lease =>
	// SAFETY: minimal Lease fields for box worker slot counting only.
	({
		provider: "hobo-box-worker",
		state,
		sandboxName,
	}) as Lease;

describe("localWorkerFreeSlots", () => {
	it("does not count reserved-only leases against launch slots", () => {
		const leases = [
			lease("reserved"),
			lease("reserved"),
			lease("running", "box-1"),
		];
		expect(countLiveBoxContainers(leases)).toBe(1);
		expect(localWorkerFreeSlots(4, leases)).toBe(3);
	});
});
