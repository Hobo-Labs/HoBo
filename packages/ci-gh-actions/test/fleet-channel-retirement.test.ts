import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";

// ADR-0180, "Retirement": whether the fleet can take a run is the relay's to
// decide (ADR-0180), so the two repository-variable channels it superseded
// are gone. ADR-0181 (decision 6) retired the third, the route table
// (the route table variable): routing travels as a routing slip (ADR-0181).
const exported = Object.keys(root);
const file = (path: string) => new URL(path, import.meta.url);

describe("retired fleet variable channels", () => {
	it("no longer publishes the fleet state variable", () => {
		for (const name of [
			"createFleetStatePublisher",
			"FLEET_STATE_VARIABLE",
			"FLEET_STATE_MAX_AGE_MS",
			"meshFleetStateJson",
		])
			expect(exported).not.toContain(name);
		expect(existsSync(file("../src/fleet-state.ts"))).toBe(false);
		expect(
			existsSync(file("../data-models/fixtures/valid/mesh-fleet-state.json")),
		).toBe(false);
	});

	it("no longer publishes the fleet capacity variable", () => {
		expect(exported).not.toContain("createFleetCapacityPublisher");
		expect(existsSync(file("../src/fleet-capacity.ts"))).toBe(false);
	});

	it("no longer publishes the route table variable", () => {
		for (const name of ["createFleetRoutePublisher", "writeRepositoryVariable"])
			expect(exported).not.toContain(name);
		expect(exported).toContain("retireRepositoryVariables");
		expect(existsSync(file("../src/fleet-routes.ts"))).toBe(false);
		expect(existsSync(file("../src/variable-retirement.ts"))).toBe(true);
	});
});
