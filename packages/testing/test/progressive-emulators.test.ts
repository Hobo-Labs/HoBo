import { createHarness, FeatureFlagStore } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	createDeliveryEmulator,
	createExperimentEmulator,
	createTestHarness,
} from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

function app() {
	return fakeBindle({
		resources: {
			flags: { kind: "flag" },
			experiment: { kind: "experiment" },
			otherExperiment: { kind: "experiment" },
			rollout: { kind: "rollout" },
		},
		handlers: {},
	});
}

describe("in-process progressive delivery", () => {
	it("isolates experiment and rollout resources across aliases and deployments", async () => {
		const harness = createTestHarness();
		const bindle = app();
		let graph = await harness.deploy(bindle)();
		const experiment = graph.experiment("experiment");
		experiment.define({
			name: "checkout",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		const context = { targetingKey: "user:alice" };
		expect(experiment.assign("checkout", context)).toEqual(
			experiment.evaluateAndExpose("checkout", context),
		);
		expect(
			experiment.events.some((event) => event.type === "experiment.Exposed"),
		).toBe(true);
		expect(graph.experiment("otherExperiment").list()).toEqual([]);
		const rollout = graph.rollout("rollout");
		const started = rollout.start({
			name: "checkout",
			flag: "checkout",
			stages: [{ percent: 10 }, { percent: 100 }],
			traffic: "flag-only",
			autoRollback: true,
		});
		expect(rollout.step(started.id).percent).toBe(100);
		expect(graph.resource("experiment").fidelity).toBe("simulated");
		expect(graph.resource("rollout").fidelity).toBe("simulated");
		expect(() => graph.rollout("flags")).toThrowError(
			expect.objectContaining({ code: "HARNESS_EMULATOR_UNAVAILABLE" }),
		);
		await harness.destroy(bindle)();
		graph = await harness.deploy(bindle)();
		try {
			expect(graph.experiment("experiment").list()).toEqual([]);
			expect(graph.rollout("rollout").list()).toEqual([]);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("can share a flag port and clock with the identity harness", () => {
		const store = new FeatureFlagStore();
		const now = () => "2026-01-01T00:00:00.000Z";
		const delivery = createDeliveryEmulator({ store, now });
		const experiment = createExperimentEmulator({ store, now });
		const harness = createHarness({
			store,
			now,
			delivery: delivery.port,
			experiment: experiment.port,
		});
		const run = harness.startProgressive({
			rollout: {
				name: "checkout",
				flag: "checkout",
				stages: [{ percent: 10 }, { percent: 100 }],
				traffic: "flag-only",
				autoRollback: true,
			},
			experiment: {
				name: "checkout-test",
				flag: "checkout",
				variants: ["control", "treatment"],
			},
		});
		expect(store.get("checkout")?.percentage).toBe(10);
		expect(harness.advance(run.rolloutId).percent).toBe(100);
		expect(store.get("checkout")?.percentage).toBe(100);
		harness.trackExposure("checkout-test", { targetingKey: "user:alice" });
		expect(delivery.port.events[0]?.time).toBe(now());
		expect(experiment.port.events[0]?.time).toBe(now());
	});

	it("reports injected fidelity and closes every replacement", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				rollout: () => ({
					port: createDeliveryEmulator().port,
					fidelity: "mocked",
					close: () => {
						closed += 1;
					},
				}),
				experiment: () => ({
					port: createExperimentEmulator().port,
					fidelity: "mocked",
					close: () => {
						closed += 1;
					},
				}),
			},
		});
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		graph.rollout("rollout");
		graph.experiment("experiment");
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		expect(closed).toBe(3);
	});

	it("cleans up earlier progressive resources if a later factory fails", async () => {
		let closed = false;
		const bindle = fakeBindle({
			resources: { a: { kind: "rollout" }, z: { kind: "experiment" } },
			handlers: {},
		});
		const harness = createTestHarness({
			emulators: {
				rollout: () => ({
					...createDeliveryEmulator(),
					close: () => {
						closed = true;
					},
				}),
				experiment: () => {
					throw new Error("factory failed");
				},
			},
		});
		await expect(harness.deploy(bindle)()).rejects.toThrow("factory failed");
		expect(closed).toBe(true);
	});

	it("rejects malformed replacements and closes them", async () => {
		for (const kind of ["rollout", "experiment"] as const) {
			let closed = 0;
			const harness = createTestHarness({
				emulators: {
					rollout: () => {
						const emulator = createDeliveryEmulator();
						Reflect.set(emulator.port, "start", null);
						return {
							...emulator,
							close: () => {
								closed += 1;
							},
						};
					},
					experiment: () => {
						const emulator = createExperimentEmulator();
						Reflect.set(emulator.port, "assign", null);
						return {
							...emulator,
							close: () => {
								closed += 1;
							},
						};
					},
				},
			});
			const bindle = fakeBindle({
				resources: { broken: { kind } },
				handlers: {},
			});
			await expect(harness.deploy(bindle)()).rejects.toMatchObject({
				code: "HARNESS_EMULATOR_INVALID",
			});
			expect(closed).toBe(1);
		}
	});
});
