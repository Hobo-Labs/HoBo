import { describe, expect, it } from "vitest";
import { createSimulation } from "../src/simulator.js";

describe("simulator", () => {
	it("same seed produces the identical first 3 ticks of events", () => {
		const a = createSimulation(42);
		const b = createSimulation(42);
		for (let i = 0; i < 3; i += 1) {
			expect(a.step()).toEqual(b.step());
		}
	});

	it("different seeds diverge", () => {
		const a = createSimulation(1);
		const b = createSimulation(2);
		const flatA = Array.from({ length: 5 }, () => a.step())
			.flat()
			.filter((e) => e.type !== "tick");
		const flatB = Array.from({ length: 5 }, () => b.step())
			.flat()
			.filter((e) => e.type !== "tick");
		expect(flatA).not.toEqual(flatB);
	});

	it("builds the expected HoBo topology", () => {
		const sim = createSimulation(7);
		expect(Object.keys(sim.state.stations)).toHaveLength(1);
		expect(Object.keys(sim.state.yards)).toHaveLength(2);
		expect(Object.keys(sim.state.camps).length).toBeGreaterThanOrEqual(4);
		expect(Object.keys(sim.state.characters).length).toBeGreaterThanOrEqual(10);
		expect(Object.keys(sim.state.junctions)).toHaveLength(3);
	});

	it("routes spans through the trace-index path: cross-tick pairs emit packets", () => {
		const sim = createSimulation(5);
		const events = Array.from({ length: 60 }, () => sim.step()).flat();
		expect(events.some((e) => e.type === "packet-started")).toBe(true);
		expect(events.some((e) => e.type === "metric-sample" && e.metric === "health")).toBe(true);
		const logs = events.filter((e) => e.type === "log-record");
		expect(logs.length).toBeGreaterThan(0);
		// Simulator logs come in varied severities.
		expect(new Set(logs.map((l) => (l.type === "log-record" ? l.severity : ""))).size).toBeGreaterThan(1);
	});
});
