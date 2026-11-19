import { parseScheduleId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createScheduleEmulator, createTestHarness } from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

function app() {
	return fakeBindle({
		resources: {
			nightly: { kind: "schedule" },
			other: { kind: "schedule" },
			cache: { kind: "kv" },
		},
		handlers: {},
	});
}

describe("in-process schedules", () => {
	it("registers idempotent interval schedules and advances time deterministically", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const schedule = graph.schedule("nightly");
			const id = parseScheduleId("nightly");
			expect(schedule.every(id, { everyMs: 1000 }).deduped).toBe(false);
			expect(schedule.every(id, { everyMs: 1000 }).deduped).toBe(true);
			expect(
				graph
					.scheduleClock("nightly")
					?.advance(3000)
					.map((fire) => fire.occurrence),
			).toEqual([1, 2, 3]);
			expect(graph.scheduleClock("other")?.advance(3000)).toEqual([]);
			expect(graph.resource("nightly").fidelity).toBe("simulated");
			expect(() => graph.schedule("cache")).toThrowError(
				expect.objectContaining({ code: "HARNESS_EMULATOR_UNAVAILABLE" }),
			);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("accepts a replacement without a virtual clock and closes it", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				schedule: () => ({
					port: createScheduleEmulator().port,
					fidelity: "mocked",
					close: () => {
						closed += 1;
					},
				}),
			},
		});
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		expect(graph.scheduleClock("nightly")).toBeUndefined();
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		expect(closed).toBe(2);
	});
});
