import { describe, expect, it } from "vitest";
import {
	decodeResourceIntent,
	encodeResourceIntent,
	parseResourceIntent,
	toResourceIntent,
} from "../src/index.js";

const intent = {
	name: "api",
	port: "compute",
	require: [],
	prefer: [],
	negotiation: "require" as const,
	deps: ["db", "migrate"],
	readyDeps: ["db"],
	completedDeps: ["migrate"],
	objective: "min-cost",
};

describe("resource readiness dependencies", () => {
	it("survives the declaration wire round trip", () => {
		const wire = encodeResourceIntent(parseResourceIntent(intent));
		expect(wire.ready_deps).toEqual(["db"]);
		expect(wire.completed_deps).toEqual(["migrate"]);
		expect(toResourceIntent(decodeResourceIntent(wire))).toEqual(intent);
	});

	it("rejects empty, unknown, repeated, or conflicting conditions", () => {
		for (const readyDeps of [[], ["unknown"], ["db", "db"], ["migrate"]]) {
			expect(() => parseResourceIntent({ ...intent, readyDeps })).toThrow();
		}
	});
});
