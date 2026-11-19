import { describe, expect, it } from "vitest";
import {
	type FeatureFlagPort,
	FeatureFlagStore,
	runExperimentFlagPortConformance,
} from "../src/index.js";

describe("experiment flag-port conformance", () => {
	it("accepts the built-in port and closes its isolated fixture", async () => {
		let closed = false;
		const result = await runExperimentFlagPortConformance(() => ({
			port: new FeatureFlagStore(),
			close() {
				closed = true;
			},
		}));
		expect(result).toEqual({ ok: true, failures: [] });
		expect(closed).toBe(true);
	});

	it("rejects a port that echoes allocation metadata but evaluates a different variant", async () => {
		let closed = false;
		const result = await runExperimentFlagPortConformance(() => {
			const backing = new FeatureFlagStore();
			const port: FeatureFlagPort = {
				experimentAllocationVersion: 1,
				get rulesetSeq() {
					return backing.rulesetSeq;
				},
				list: () => backing.list(),
				get: (key) => backing.get(key),
				define: (input) => backing.define(input),
				applyExperimentAllocation: (input) =>
					backing.applyExperimentAllocation(input),
				loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
				evaluate: (key, context, value) => ({
					...backing.evaluate(key, context, value),
					variant: "control",
					value: false,
				}),
				evaluateBoolean: (key, context, value) => ({
					...backing.evaluateBoolean(key, context, value),
					variant: "control",
					value: false,
				}),
				activateKillSwitch: (key, actor) =>
					backing.activateKillSwitch(key, actor),
				clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
				archive: (key) => backing.archive(key),
			};
			return {
				port,
				close() {
					closed = true;
				},
			};
		});
		expect(result.ok).toBe(false);
		expect(result.failures).toContain("allocation");
		expect(closed).toBe(true);
	});
});
