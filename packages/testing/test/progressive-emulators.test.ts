import {
	createHarness,
	type FeatureFlagPort,
	FeatureFlagStore,
} from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	createDeliveryEmulator,
	createExperimentEmulator,
	createFlagEmulator,
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
	it("shares a declared flag dependency with an explicitly injected service", async () => {
		let flags: FeatureFlagPort | undefined;
		const bindle = fakeBindle({
			resources: {
				flags: { kind: "flag" },
				rollout: { kind: "rollout", dependsOn: ["flags"] },
				experiment: { kind: "experiment", dependsOn: ["flags"] },
				web: { kind: "service", dependsOn: ["flags"] },
			},
			handlers: {
				web: () =>
					new Response(
						String(
							flags?.evaluateBoolean("checkout", { targetingKey: "alice" })
								.value,
						),
					),
			},
		});
		const harness = createTestHarness();
		const graph = await harness.deploy(bindle)();
		try {
			flags = graph.flag("flags");
			flags.define({ key: "checkout", percentage: 0 });
			const url = graph.http("web").baseUrl;
			expect(await (await fetch(url)).text()).toBe("false");
			const rollout = graph.rollout("rollout");
			const started = rollout.start({
				name: "checkout",
				flag: "checkout",
				stages: [{ percent: 0 }, { percent: 100 }],
				traffic: "flag-only",
				autoRollback: true,
			});
			rollout.step(started.id);
			expect(await (await fetch(url)).text()).toBe("true");
			graph.experiment("experiment").define({
				name: "new-flow",
				flag: "new-flow",
				variants: ["control", "treatment"],
			});
			expect(flags.get("new-flow")?.variants).toHaveProperty("treatment");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("rejects ambiguous flag dependencies unless the caller supplies an emulator", async () => {
		for (const kind of ["rollout", "experiment"] as const) {
			const bindle = fakeBindle({
				resources: {
					a: { kind: "flag" },
					b: { kind: "flag" },
					progressive: { kind, dependsOn: ["a", "b"] },
				},
				handlers: {},
			});
			const defaultHarness = createTestHarness();
			await expect(defaultHarness.deploy(bindle)()).rejects.toMatchObject({
				code: "HARNESS_EMULATOR_INVALID",
			});
			const overridden = createTestHarness({
				emulators: {
					rollout: () => createDeliveryEmulator(),
					experiment: () => createExperimentEmulator(),
				},
			});
			await overridden.deploy(bindle)();
			await overridden.destroy(bindle)();
		}
	});

	it("carries mocked dependency fidelity into the progressive resource", async () => {
		for (const kind of ["rollout", "experiment"] as const) {
			for (const override of [false, true]) {
				const harness = createTestHarness({
					emulators: {
						flag: () => ({ ...createFlagEmulator(), fidelity: "mocked" }),
						...(override
							? {
									rollout: () => createDeliveryEmulator(),
									experiment: () => createExperimentEmulator(),
								}
							: undefined),
					},
				});
				const bindle = fakeBindle({
					resources: {
						flags: { kind: "flag" },
						progressive: { kind, dependsOn: ["flags"] },
					},
					handlers: {},
				});
				const graph = await harness.deploy(bindle)();
				try {
					if (kind === "rollout") graph.rollout("progressive");
					else graph.experiment("progressive");
					expect(graph.resource("progressive").fidelity).toBe("mocked");
					expect(graph.fidelity().prodReadinessClaimable).toBe(false);
				} finally {
					await harness.destroy(bindle)();
				}
			}
		}
		expect(
			createDeliveryEmulator({ store: new FeatureFlagStore() }).fidelity,
		).toBe("mocked");
		expect(
			createExperimentEmulator({ store: new FeatureFlagStore() }).fidelity,
		).toBe("mocked");
	});

	it("does not claim fidelity when a dependency is unresolved", async () => {
		for (const kind of ["rollout", "experiment"] as const) {
			for (const override of [false, true]) {
				const harness = createTestHarness({
					emulators: override
						? {
								rollout: () => createDeliveryEmulator(),
								experiment: () => createExperimentEmulator(),
							}
						: {},
				});
				const bindle = fakeBindle({
					resources: {
						progressive: { kind, dependsOn: ["missing"] },
						web: { kind: "service", dependsOn: ["progressive"] },
					},
					handlers: { web: () => new Response("ok") },
				});
				const graph = await harness.deploy(bindle)();
				try {
					expect(graph.resource("progressive").fidelity).toBe("mocked");
					expect(graph.resource("web").fidelity).toBe("mocked");
					expect(graph.fidelity().prodReadinessClaimable).toBe(false);
				} finally {
					await harness.destroy(bindle)();
				}
			}
		}
	});

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
