import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";

// ADR-0180, "Retirement": whether the fleet can take a run is the relay's to
// decide (ADR-0180), so the two repository-variable channels it superseded
// are gone. The route table (`HOBO_CI_FLEET_ROUTES`) stays.
const exported = Object.keys(root);
const file = (path: string) => new URL(path, import.meta.url);

describe("retired fleet variable channels", () => {
	it("no longer publishes HOBO_CI_FLEET_STATE", () => {
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

	it("no longer publishes HOBO_CI_FLEET_CAPACITY", () => {
		expect(exported).not.toContain("createFleetCapacityPublisher");
		expect(existsSync(file("../src/fleet-capacity.ts"))).toBe(false);
	});

	it("keeps the route table publisher", () => {
		expect(exported).toContain("createFleetRoutePublisher");
	});
});
