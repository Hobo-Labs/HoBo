import { describe, expect, it } from "vitest";
import {
	deploymentOrder,
	parseTestTopology,
	TestHarnessError,
	teardownOrder,
} from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

describe("parseTestTopology", () => {
	it.each([
		[undefined, "a non-object"],
		[42, "a number"],
		[[], "an array"],
		[{}, "an object with no resources"],
		[{ resources: [] }, "resources that are not a record"],
	])("refuses %o (%s) with HARNESS_BINDLE_INVALID", (input) => {
		expect(() => parseTestTopology(input)).toThrow(TestHarnessError);
		try {
			parseTestTopology(input);
		} catch (error) {
			expect((error as TestHarnessError).code).toBe("HARNESS_BINDLE_INVALID");
			expect((error as TestHarnessError).remediation.length).toBeGreaterThan(0);
		}
	});

	it("refuses a resource record with no string kind", () => {
		try {
			parseTestTopology({ resources: { api: { name: "api" } } });
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as TestHarnessError).code).toBe("HARNESS_BINDLE_INVALID");
		}
	});

	it("returns a frozen topology with sorted, deduped dependencies", () => {
		const topology = parseTestTopology(
			fakeBindle({
				resources: {
					api: { kind: "api", dependsOn: ["db", "cache", "db"] },
					db: { kind: "data" },
					cache: { kind: "kv" },
				},
				edges: [{ from: "api", to: "cache" }],
			}),
		);
		expect(Object.isFrozen(topology)).toBe(true);
		expect(topology.nodes.map((node) => node.alias)).toEqual([
			"api",
			"cache",
			"db",
		]);
		expect(topology.nodes[0]?.dependsOn).toEqual(["cache", "db"]);
	});

	it("records dependencies outside the resource set instead of dropping them", () => {
		const topology = parseTestTopology(
			fakeBindle({
				resources: { api: { kind: "api", dependsOn: ["connector:stripe"] } },
				handlers: {},
			}),
		);
		expect(topology.unresolvedDependencies).toEqual([
			{ alias: "api", dependency: "connector:stripe" },
		]);
		expect(topology.nodes[0]?.dependsOn).toEqual([]);
	});

	it("marks hasEntrypoint only for http-shaped kinds with a factory", () => {
		const topology = parseTestTopology(
			fakeBindle({
				resources: { api: { kind: "api" }, db: { kind: "data" } },
				handlers: { api: () => new Response("ok"), db: () => new Response("") },
			}),
		);
		const byAlias = new Map(topology.nodes.map((n) => [n.alias, n]));
		expect(byAlias.get("api")?.hasEntrypoint).toBe(true);
		expect(byAlias.get("db")?.hasEntrypoint).toBe(false);
	});
});

describe("deploymentOrder / teardownOrder", () => {
	it("orders dependencies first, lexicographically among the ready set", () => {
		const topology = parseTestTopology(fakeBindle());
		expect(deploymentOrder(topology)).toEqual(["cache", "db", "api"]);
	});

	it("is stable under input permutation", () => {
		const forward = parseTestTopology(
			fakeBindle({
				resources: {
					api: { kind: "api", dependsOn: ["db"] },
					db: { kind: "data" },
					cache: { kind: "kv" },
				},
			}),
		);
		const reversed = parseTestTopology(
			fakeBindle({
				resources: {
					cache: { kind: "kv" },
					db: { kind: "data" },
					api: { kind: "api", dependsOn: ["db"] },
				},
			}),
		);
		expect(deploymentOrder(forward)).toEqual(deploymentOrder(reversed));
	});

	it("tears down in the exact reverse of deployment order", () => {
		const topology = parseTestTopology(fakeBindle());
		expect(teardownOrder(topology)).toEqual(
			[...deploymentOrder(topology)].reverse(),
		);
	});

	it("refuses a dependency cycle rather than breaking it arbitrarily", () => {
		const topology = parseTestTopology(
			fakeBindle({
				resources: {
					a: { kind: "api", dependsOn: ["b"] },
					b: { kind: "service", dependsOn: ["a"] },
				},
				handlers: {},
			}),
		);
		try {
			deploymentOrder(topology);
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as TestHarnessError).code).toBe(
				"HARNESS_CYCLIC_DEPENDENCY",
			);
		}
	});
});
