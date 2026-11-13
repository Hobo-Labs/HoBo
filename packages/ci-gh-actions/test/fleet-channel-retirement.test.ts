import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";

// Plan 0025, section 6.8: whether the fleet can take a run is the relay's to
// decide (ADR-0180), so the two repository-variable channels it superseded
// are gone. Plan 0026 (3.7) retired the third, the route table
// (`HOBO_CI_FLEET_ROUTES`): routing travels as a routing slip (ADR-0181).
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

	it("no longer publishes HOBO_CI_FLEET_ROUTES", () => {
		for (const name of ["createFleetRoutePublisher", "writeRepositoryVariable"])
			expect(exported).not.toContain(name);
		expect(exported).toContain("retireRepositoryVariables");
	});
});

// Plan 0026, 3.9 (M11): the hosted relay's fleet verdict path is gone. The
// box relay hands each run its route as a routing slip (ADR-0181); the
// evaluator and its holds stay, because the slip's decision uses them.
describe("the retired hosted fleet verdict path", () => {
	it("exports no verdict route, store, signature or reporter", () => {
		for (const name of [
			"createFleetVerdictStore",
			"createMemoryFleetVerdicts",
			"parseFleetVerdict",
			"parseFleetVerdictReport",
			"parseFleetReporters",
			"FLEET_VERDICTS_PATH",
			"FLEET_REPORTERS_PATH",
			"signedFleetVerdictRequest",
			"verifyFleetVerdictReport",
			"createFleetVerdictReporter",
			"createFleetVerdictSchedule",
			"createFleetVerdictSequence",
			"createGithubWorkflowVerifier",
		])
			expect(exported).not.toContain(name);
		for (const name of [
			"evaluateFleetVerdict",
			"createFleetVerdictHolds",
			"createFleetPickupMemory",
		])
			expect(exported).toContain(name);
	});

	it("keeps no file, record or contract for it", () => {
		for (const path of [
			"../src/fleet-verdict.ts",
			"../src/fleet-verdict-auth.ts",
			"../src/workflow-oidc.ts",
			"../src/isolated-worker/fleet-verdict-reporter.ts",
			"../src/_generated/fleet_verdict_pb.ts",
			"../data-models/fleet_verdict.proto",
			"../scripts/fleet-reporter-enroll.mts",
			"../contracts/fleet-verdict-boundary.pact.json",
		])
			expect(existsSync(file(path)), path).toBe(false);
	});
});
