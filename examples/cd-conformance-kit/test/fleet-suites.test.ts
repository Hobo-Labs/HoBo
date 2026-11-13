// Fleet and policy suites (plan 0024 WP20 "Fleet and policy"): PlacementEngine
// permutation determinism, FanoutController, PostureEvaluator, CampInventory.
// Also pins the §10 fleet rows these suites prove.
import {
	CAMP_INVENTORY_ASSERTIONS,
	FANOUT_CONTROLLER_ASSERTIONS,
	PLACEMENT_ENGINE_ASSERTIONS,
	POSTURE_EVALUATOR_ASSERTIONS,
	runCampInventoryConformance,
	runFanoutControllerConformance,
	runPlacementEngineConformance,
	runPostureEvaluatorConformance,
} from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import {
	type FanoutMutant,
	type InventoryMutant,
	type PlacementMutant,
	type PostureMutant,
	refFanoutHarness,
	refInventoryHarness,
	refPlacementHarness,
	refPostureHarness,
} from "../src/index.js";
import { failed, summary } from "./report.js";

describe("PlacementEngine conformance", () => {
	it("passes the reference placement engine on every assertion", async () => {
		const report = await runPlacementEngineConformance(refPlacementHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...PLACEMENT_ENGINE_ASSERTIONS]);
	});
	it.each<[PlacementMutant, string]>([
		["order-sensitive", "permutationDeterminism"],
		["claims-grant", "claimsNeverGrantResidency"],
		["extrapolates-scores", "expiredScoresAreIgnored"],
	])("catches a placement engine that is %s (%s)", async (mutant, assertion) => {
		expect(failed(await runPlacementEngineConformance(refPlacementHarness(mutant)))).toContain(assertion);
	});
});

describe("FanoutController conformance", () => {
	it("passes the reference fan-out controller on every assertion", async () => {
		const report = await runFanoutControllerConformance(refFanoutHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...FANOUT_CONTROLLER_ASSERTIONS]);
	});
	it.each<[FanoutMutant, string]>([
		["unbounded", "concurrencyIsBounded"],
		["defer-as-failure", "deferredAreNotFailures"],
		["eager-groups", "mandatoryGroupRunsFirst"],
		["non-idempotent", "startIsIdempotent"],
	])("catches a fan-out controller that is %s (%s)", async (mutant, assertion) => {
		expect(failed(await runFanoutControllerConformance(refFanoutHarness(mutant)))).toContain(assertion);
	});
});

describe("PostureEvaluator conformance", () => {
	it("passes the reference evaluator on every assertion", async () => {
		const report = await runPostureEvaluatorConformance(refPostureHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...POSTURE_EVALUATOR_ASSERTIONS]);
	});
	it.each<[PostureMutant, string]>([
		["unknown-passes", "unknownCountsAgainst"],
		["unbounded-observed", "observedIsBoundedAndSecretFree"],
	])("catches an evaluator that is %s (%s)", async (mutant, assertion) => {
		expect(failed(await runPostureEvaluatorConformance(refPostureHarness(mutant)))).toContain(assertion);
	});
});

describe("CampInventory conformance", () => {
	it("passes the reference inventory on every assertion", async () => {
		const report = await runCampInventoryConformance(refInventoryHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...CAMP_INVENTORY_ASSERTIONS]);
	});
	it.each<[InventoryMutant, string]>([
		["agent-no-run", "agentSelfReportNeverAddsNoRun"],
		["order-digest", "snapshotIsOrderIndependent"],
		["accepts-agent-no-run", "agentCannotTaintNoRun"],
	])("catches an inventory that is %s (%s)", async (mutant, assertion) => {
		expect(failed(await runCampInventoryConformance(refInventoryHarness(mutant)))).toContain(assertion);
	});
});
