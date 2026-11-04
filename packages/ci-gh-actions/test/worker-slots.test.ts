import { describe, expect, it } from "vitest";
import { resolveWorkerSlotConfig } from "../src/isolated-worker/worker-slots.js";

describe("resolveWorkerSlotConfig", () => {
	it.each([
		2, 3, 8,
	])("reserves one trunk slot by default with %i slots", (slots) => {
		expect(
			resolveWorkerSlotConfig({ HOBO_CI_WORKER_SLOTS: String(slots) }),
		).toEqual({ slots, trunkSlots: 1 });
	});

	it("reserves no trunk slot by default on a single-slot worker", () => {
		expect(resolveWorkerSlotConfig({ HOBO_CI_WORKER_SLOTS: "1" })).toEqual({
			slots: 1,
			trunkSlots: 0,
		});
	});

	it("honors explicit slot values and keeps their validation", () => {
		expect(
			resolveWorkerSlotConfig({
				HOBO_CI_WORKER_SLOTS: "3",
				HOBO_CI_WORKER_TRUNK_SLOTS: "2",
			}),
		).toEqual({ slots: 3, trunkSlots: 2 });
		expect(() =>
			resolveWorkerSlotConfig({
				HOBO_CI_WORKER_SLOTS: "2",
				HOBO_CI_WORKER_TRUNK_SLOTS: "2",
			}),
		).toThrow("invalid HOBO_CI_WORKER_TRUNK_SLOTS");
		expect(() =>
			resolveWorkerSlotConfig({ HOBO_CI_WORKER_SLOTS: "0" }),
		).toThrow("invalid HOBO_CI_WORKER_SLOTS");
	});
});
