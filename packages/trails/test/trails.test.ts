import { describe, expect, it } from "vitest";

import {
	activateIdentityContinuousFromMatching,
	assertIdentityContinuousHandsOff,
	composeTrailWithRecipes,
	createContractAssertedTrailFixtures,
	createHandsOffIdentityTrail,
	defineTrail,
	evaluateCanTrail,
	identityContinuousTrail,
	orderTrailSteps,
	PLATFORM_RECIPES,
	runTrailGoldenSuite,
	stepChecksum,
	TrailHistoryStore,
	TrailRunner,
} from "../src/index.js";

describe("HoBo Trails", () => {
	it("defineTrail validates composition and rejects secrets", () => {
		const trail = defineTrail({
			id: "app.demo",
			version: "1.0.0",
			steps: [
				{
					id: "a",
					kind: "schema",
					schema: { mode: "versioned-sql", version: "1" },
				},
				{ id: "b", kind: "validation", dependsOn: ["a"], oracleId: "x" },
			],
		});
		expect(trail.contentHash.startsWith("sha256:")).toBe(true);
		expect(orderTrailSteps(trail.steps).map((s) => s.id)).toEqual(["a", "b"]);
		expect(() =>
			defineTrail({
				id: "bad",
				version: "1",
				steps: [
					{
						id: "s",
						kind: "custom",
						description: "password=supersecret",
					},
				],
			}),
		).toThrow(/secret/);
	});

	it("identity continuous is hands-off and Matching-activated via sealed DTOs", () => {
		const handle = createHandsOffIdentityTrail({ tenant: "acme" });
		assertIdentityContinuousHandsOff(handle);
		expect(handle.bindleConfigRequired).toBe(false);
		expect(handle.canMigrate.evidence.continuousDefault).toBe(true);
		expect(handle.canMigrate.evidence.bindleConfigRequired).toBe(false);
		// Public handle never exposes foreign plane / dual fixture objects.
		expect("plane" in handle).toBe(false);
		const progress = activateIdentityContinuousFromMatching({ handle });
		expect(progress.bindleConfigRequired).toBe(false);
		expect(progress.handsOff).toBe(true);
		expect(progress.matchAudit.bindleConfigRequired).toBe(false);
		expect(progress.matchAudit.continuousDefault).toBe(true);
		expect(progress.migrationPresent).toBe(true);
		expect(progress.migrationId).toBeTruthy();
	});

	it("can-trail dry-run offline for identity continuous", () => {
		const trail = identityContinuousTrail();
		const can = evaluateCanTrail({
			trail,
			dualOracleReady: true,
			policyAllows: true,
		});
		expect(can.ok).toBe(true);
		expect(can.dimension).toBe("can-trail");
		expect(can.evidence.bindleConfigRequired).toBe(false);
		expect(can.evidence.identityContinuous).toBe(true);
		expect(can.evidence.dryRun).toBe(true);
	});

	it("runs progressive dual Trail (identity + data) to cutover", () => {
		const fx = createContractAssertedTrailFixtures({ tenant: "acme" });
		const plan = fx.runner.plan(fx.appTrail);
		expect(plan.canTrail.ok).toBe(true);
		expect(plan.identityContinuous).toBe(true);
		const result = fx.runner.run(fx.appTrail);
		expect(result.cutover).toBe(true);
		expect(result.aborted).toBe(false);
		expect(result.rampPercent).toBe(100);
		expect(result.run.state).toBe("cutover");
		expect(result.history.length).toBeGreaterThan(0);
		expect(result.identityProgress?.migrationPresent).toBe(true);
		expect(result.identityProgress?.handsOff).toBe(true);
		// Idempotent re-run does not duplicate history checksums
		const again = fx.runner.run(fx.appTrail);
		expect(again.history.length).toBe(result.history.length);
	});

	it("fail-closed compensates on data dual divergence", () => {
		const fx = createContractAssertedTrailFixtures({ tenant: "t" });
		const result = fx.runner.run(fx.appTrail, { forceDataDiverge: true });
		expect(result.compensated).toBe(true);
		expect(result.cutover).toBe(false);
		expect(result.run.state).toBe("compensated");
		expect(result.run.dualOk).toBe(false);
		const golden = runTrailGoldenSuite(result, {
			bindleConfigRequired: false,
			continuousDefault: true,
		});
		expect(golden.find((g) => g.oracle === "fail-closed")?.ok).toBe(true);
		expect(golden.find((g) => g.oracle === "compensation")?.ok).toBe(true);
	});

	it("fail-closed when dual id sorts after validation/cutover alphabetically", () => {
		// Without phase wiring, Kahn would run cutover-gate before z-data-dual.
		const trail = defineTrail({
			id: "app.late-dual",
			version: "1.0.0",
			recipeList: [
				PLATFORM_RECIPES.IdentityContinuous,
				PLATFORM_RECIPES.ValidationOracle,
				PLATFORM_RECIPES.CutoverGate,
			],
			steps: [
				{
					id: "schema-v1",
					kind: "schema",
					schema: { mode: "expand-contract", version: "1" },
					progressive: true,
				},
				{
					// Lexicographically after validation-oracle and cutover-gate.
					id: "z-data-dual",
					kind: "continuous-dual-data",
					dependsOn: ["schema-v1"],
					data: {
						mode: "cdc-dual",
						transformId: "late.backfill",
						checksum:
							"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					},
					progressive: true,
				},
			],
		});
		const ordered = orderTrailSteps(composeTrailWithRecipes(trail).steps).map(
			(s) => s.id,
		);
		// Dual work before validation/cutover regardless of id sort order.
		const dualIdx = ordered.indexOf("z-data-dual");
		const valIdx = ordered.indexOf("validation-oracle");
		const cutIdx = ordered.indexOf("cutover-gate");
		expect(dualIdx).toBeGreaterThanOrEqual(0);
		expect(valIdx).toBeGreaterThan(dualIdx);
		expect(cutIdx).toBeGreaterThan(valIdx);

		const runner = new TrailRunner({
			tenant: "late",
			target: "local-dev",
			dualOracleReady: true,
		});
		const result = runner.run(trail, { forceDataDiverge: true });
		expect(result.run.state).not.toBe("cutover");
		expect(result.run.state).toBe("compensated");
		expect(result.cutover).toBe(false);
		expect(result.compensated).toBe(true);
		expect(result.run.dualOk).toBe(false);
		const golden = runTrailGoldenSuite(result, {
			bindleConfigRequired: false,
			continuousDefault: true,
		});
		expect(golden.find((g) => g.oracle === "fail-closed")?.ok).toBe(true);
	});

	it("Golden suite passes for successful progressive dual", () => {
		const fx = createContractAssertedTrailFixtures();
		const result = fx.runner.run(fx.appTrail);
		const golden = runTrailGoldenSuite(result, {
			bindleConfigRequired: false,
			continuousDefault: true,
		});
		for (const v of golden) {
			expect(v.ok, `${v.oracle}: ${v.summary}`).toBe(true);
		}
	});

	it("history baseline and repair", () => {
		const store = new TrailHistoryStore();
		const checksum = stepChecksum({ id: "s1" });
		store.baseline({
			trailId: "t",
			trailVersion: "1",
			stepId: "s1",
			target: "prod",
			tenant: "acme",
			checksum,
			appliedAt: new Date().toISOString(),
		});
		expect(store.isApplied("t", "s1", "prod", "acme")).toBe(true);
		const repaired = store.repair({
			trailId: "t",
			trailVersion: "1",
			stepId: "s1",
			target: "prod",
			tenant: "acme",
			checksum: stepChecksum({ id: "s1", fixed: true }),
			appliedAt: new Date().toISOString(),
		});
		expect(repaired.status).toBe("repaired");
	});

	it("composeTrailWithRecipes expands platform recipes", () => {
		const trail = defineTrail({
			id: "x",
			version: "1",
			recipeList: [PLATFORM_RECIPES.IdentityContinuous],
			steps: [],
		});
		const composed = composeTrailWithRecipes(trail);
		expect(composed.steps.some((s) => s.kind === "identity-continuous")).toBe(
			true,
		);
	});

	it("junction unhealthy compensates", () => {
		const trail = defineTrail({
			id: "cross-cloud",
			version: "1",
			steps: [
				{
					id: "j",
					kind: "junction-rebind",
					junction: { required: true },
				},
			],
		});
		const runner = new TrailRunner({
			tenant: "t",
			target: "prod",
			junctionHealthy: false,
		});
		// can-trail blocks before run
		const plan = runner.plan(trail);
		expect(plan.canTrail.ok).toBe(false);
		expect(
			plan.canTrail.reasons.some((r) => r.code === "junction-unhealthy"),
		).toBe(true);
	});

	it("local fixtures fidelity is simulated", () => {
		const fx = createContractAssertedTrailFixtures();
		expect(fx.fidelity).toBe("simulated");
		expect(fx.label).toBe("contract-asserted-trail-fixtures");
		expect(fx.identity.fixtures.fidelity).toBe("simulated");
		expect(fx.identity.fixtures.principalRef.length).toBeGreaterThan(0);
	});
});
