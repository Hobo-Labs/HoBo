import { describe, expect, it } from "vitest";
import {
	computeAvailabilityView,
	formatAvailabilityPercent,
} from "../src/index.js";

describe("availability view", () => {
	it("estimates a serial dependency chain and each network hop", () => {
		const view = computeAvailabilityView({
			graph: {
				root: "web",
				defaultHopAvailability: 0.9999,
				nodes: {
					web: { availability: 0.999, dependsOn: ["api"] },
					api: { availability: 0.998, dependsOn: ["db"] },
					db: { availability: 0.9995 },
				},
			},
			observedAvailability: 0.997,
		});
		expect(view.status).toBe("estimated");
		expect(view.estimatedAvailability).toBeCloseTo(
			0.999 * 0.998 * 0.9995 * 0.9999 ** 2,
			6,
		);
		expect(view.summary.observed).toBe("99.700%");
		expect(view.breakdown.countedNodes).toEqual(["web", "api", "db"]);
	});

	it("calculates redundancy with independent members", () => {
		const view = computeAvailabilityView({
			graph: {
				root: "pair",
				nodes: {
					pair: { type: "redundant-set", members: ["a", "b"] },
					a: { availability: 0.99 },
					b: { availability: 0.99 },
				},
			},
		});
		expect(view.estimatedAvailability).toBe(0.9999);
	});

	it("does not treat a shared dependency as an independent replica", () => {
		const view = computeAvailabilityView({
			graph: {
				root: "workers",
				nodes: {
					workers: { type: "redundant-set", members: ["a", "b"] },
					a: { availability: 0.98, dependsOn: ["queue"] },
					b: { availability: 0.98, dependsOn: ["queue"] },
					queue: { availability: 0.97 },
				},
			},
		});
		expect(view.estimatedAvailability).toBe(0.969612);
		expect(view.breakdown.countedNodes.filter((id) => id === "queue")).toEqual([
			"queue",
		]);
	});

	it("counts a shared dependency once across serial branches", () => {
		const view = computeAvailabilityView({
			graph: {
				root: "api",
				nodes: {
					api: { availability: 0.99, dependsOn: ["a", "b"] },
					a: { availability: 0.99, dependsOn: ["queue"] },
					b: { availability: 0.99, dependsOn: ["queue"] },
					queue: { availability: 0.99 },
				},
			},
		});
		expect(view.estimatedAvailability).toBe(0.960596);
	});

	it("accounts for independent network hops and a shared dependency across redundant paths", () => {
		const view = computeAvailabilityView({
			graph: {
				root: "api",
				defaultHopAvailability: 0.96,
				nodes: {
					api: { availability: 0.91, dependsOn: ["workers"] },
					workers: { type: "redundant-set", members: ["a", "b"] },
					a: { availability: 0.8, dependsOn: ["queue"] },
					b: { availability: 0.7, dependsOn: ["queue"] },
					queue: { availability: 0.9 },
				},
			},
		});
		const expected =
			0.91 * 0.96 * 0.9 * (1 - (1 - 0.8 * 0.96) * (1 - 0.7 * 0.96));
		expect(view.estimatedAvailability).toBeCloseTo(expected, 6);
	});

	it("accounts for and reports declared shared failure domains", () => {
		const view = computeAvailabilityView({
			graph: {
				root: "workers",
				nodes: {
					workers: {
						type: "redundant-set",
						members: ["a", "b"],
						sharedDependencies: ["queue"],
					},
					a: { availability: 0.98 },
					b: { availability: 0.98 },
					queue: { availability: 0.97 },
				},
			},
		});
		expect(view.estimatedAvailability).toBe(0.969612);
		expect(view.warnings.map((warning) => warning.code)).toContain(
			"redundancy-shared-failure-domain",
		);
	});

	it("uses and reports the conservative default for an unrated component", () => {
		const view = computeAvailabilityView({
			graph: { root: "search", nodes: { search: { provider: "example" } } },
			conservativeUnratedAvailability: 0.95,
		});
		expect(view.estimatedAvailability).toBe(0.95);
		expect(view.warnings).toContainEqual(
			expect.objectContaining({
				code: "unrated-provider",
				node: "search",
				provider: "example",
				assumedAvailability: 0.95,
			}),
		);
	});

	it("warns about an unmet SLO and observed divergence without denying deployment", () => {
		const view = computeAvailabilityView({
			graph: { root: "api", nodes: { api: { availability: 0.99 } } },
			observedAvailability: 0.9,
			availabilitySlo: 0.999,
		});
		expect(view.canDeploy.effect).toBe("warn");
		expect(view.canDeploy.warnings[0]).toMatchObject({
			code: "availability-floor-unmet",
			hardGate: false,
		});
		expect(view.warnings.map((warning) => warning.code)).toContain(
			"estimate-observed-divergence",
		);
		expect(view.summary.estimateObservedGap).toBe("9.000%");
	});

	it("compares the unrounded estimate to the SLO and computes downtime from it", () => {
		const view = computeAvailabilityView({
			graph: { root: "api", nodes: { api: { availability: 0.9999994 } } },
			availabilitySlo: 0.9999992,
		});
		expect(view.canDeploy.effect).toBe("allow");
		expect(view.estimatedDowntimeMinutesPerYear).toBe(0.315);
	});

	it("reports unsupported fields on a redundant set instead of ignoring them", () => {
		const view = computeAvailabilityView({
			graph: {
				root: "pair",
				nodes: {
					pair: { type: "redundant-set", members: ["a"], availability: 0.5 },
					a: { availability: 0.99 },
				},
			},
		});
		expect(view.status).toBe("invalid-graph");
		expect(view.errors[0]?.code).toBe("invalid-redundant-set");
	});

	it.each([
		["missing node", { root: "missing", nodes: {} }, "missing-node"],
		[
			"cycle",
			{
				root: "a",
				nodes: { a: { dependsOn: ["b"] }, b: { dependsOn: ["a"] } },
			},
			"cycle-detected",
		],
		[
			"empty redundancy set",
			{ root: "a", nodes: { a: { type: "redundant-set", members: [] } } },
			"invalid-redundant-set",
		],
	])("reports %s without an optimistic estimate", (_name, graph, code) => {
		const view = computeAvailabilityView({ graph });
		expect(view.status).toBe("invalid-graph");
		expect(view.estimatedAvailability).toBeNull();
		expect(view.errors[0]?.code).toBe(code);
		expect(view.canDeploy.effect).toBe("warn");
	});

	it("formats unknown and known availability", () => {
		expect(formatAvailabilityPercent(null)).toBe("unknown");
		expect(formatAvailabilityPercent(0.9995)).toBe("99.950%");
	});
});
