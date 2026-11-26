import { describe, expect, it } from "vitest";
import { resolveWorkerSlotConfig } from "../src/isolated-worker/worker-slots.js";

describe("resolveWorkerSlotConfig", () => {
	it.each([
		2, 3, 8,
	])("reserves one trunk slot by default with %i slots", (slots) => {
		expect(resolveWorkerSlotConfig({ slots })).toEqual({
			slots,
			trunkSlots: 1,
			mergeGroupLeases: 1,
			prCapWithTrunk: 1,
		});
	});

	it("reserves no trunk slot by default on a single-slot worker", () => {
		expect(resolveWorkerSlotConfig({ slots: 1 })).toEqual({
			slots: 1,
			trunkSlots: 0,
			mergeGroupLeases: 1,
			prCapWithTrunk: 1,
		});
	});

	it("defaults to two slots, one of them trunk's", () => {
		expect(resolveWorkerSlotConfig()).toEqual({
			slots: 2,
			trunkSlots: 1,
			mergeGroupLeases: 1,
			prCapWithTrunk: 1,
		});
	});

	it("honors explicit slot values and keeps their validation", () => {
		expect(
			resolveWorkerSlotConfig({
				slots: 3,
				trunkSlots: 2,
				mergeGroupLeases: 2,
				prCapWithTrunk: 0,
			}),
		).toEqual({
			slots: 3,
			trunkSlots: 2,
			mergeGroupLeases: 2,
			prCapWithTrunk: 0,
		});
		expect(() => resolveWorkerSlotConfig({ slots: 2, trunkSlots: 2 })).toThrow(
			"invalid runnerRouting.box.trunkSlots",
		);
		expect(() => resolveWorkerSlotConfig({ slots: 0 })).toThrow(
			"invalid runnerRouting.box.slots",
		);
	});

	it.each([0, 1.5, 9])("rejects invalid merge-group cap %s", (value) => {
		expect(() => resolveWorkerSlotConfig({ mergeGroupLeases: value })).toThrow(
			"invalid runnerRouting.box.mergeGroupLeases",
		);
	});

	it.each([-1, 1.5, 9])("rejects invalid PR cap with trunk %s", (value) => {
		expect(() => resolveWorkerSlotConfig({ prCapWithTrunk: value })).toThrow(
			"invalid runnerRouting.box.prCapWithTrunk",
		);
	});
});
