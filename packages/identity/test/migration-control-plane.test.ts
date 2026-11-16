import { first, must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	createContractAssertedDualFixtures,
	createMemoryFencePort,
	createMemoryTenantTransferPort,
	FeatureFlagStore,
	IdentityMigrationControlPlane,
	matchingSignalsFromResourceDecision,
	runSpectrumIdentityCutover,
	startContinuousMigrationFromMatch,
} from "../src/index.js";

describe("IdentityMigrationControlPlane (hands-off continuous path)", () => {
	it("Matching decision auto-starts dual path and creates OpenFeature cohort flag", () => {
		const plane = new IdentityMigrationControlPlane({ tenant: "t1" });
		const progress = plane.onMatchingDecision({
			tenant: "t1",
			sourceAdapter: "oidc-a",
			targetAdapter: "oidc-b",
		});
		expect(progress.matchAudit?.type).toBe("match.Decided");
		expect(progress.matchAudit?.bindleConfigRequired).toBe(false);
		expect(progress.matchAudit?.continuousDefault).toBe(true);
		expect(progress.migration?.state).toBe("dual-active");
		expect(progress.flag?.percentage).toBe(0);
		expect(progress.flag?.key).toContain("identity-migration.");
		expect(plane.flags.events.some((e) => e.type === "flag.Defined")).toBe(
			true,
		);
	});

	it("JIT link + ramp + OpenFeature cohort eval + cutover", () => {
		const plane = new IdentityMigrationControlPlane({ tenant: "t1" });
		plane.onMatchingDecision({
			tenant: "t1",
			sourceAdapter: "src",
			targetAdapter: "tgt",
		});
		const linked = plane.linkPrincipalJit();
		expect(linked.migration?.linkedPrincipals).toBe(1);

		const mid = plane.advanceRamp(50);
		expect(mid.flag?.percentage).toBe(50);
		expect(mid.migration?.state).toBe("ramping");

		const principal = first(
			Object.keys(mid.migration?.links ?? {}),
			"Object.keys(mid.migration?.links ?? {})",
		);
		const inCohort = plane.principalInRamp(principal);
		expect(inCohort.value === true || inCohort.value === false).toBe(true);
		// flag.Evaluated is sampled (default 1%); force path still defines/changes flags.
		expect(plane.flags.events.some((e) => e.type === "flag.Defined")).toBe(
			true,
		);
		expect(plane.flags.events.some((e) => e.type === "flag.Changed")).toBe(
			true,
		);
		expect(inCohort.flagKey).toContain("identity-migration.");

		plane.advanceRamp(100);
		const snap = must(plane.service.snapshot());
		const pref = first(Object.keys(snap.links));
		plane.service.markMigrated(pref);
		const cut = plane.cutover();
		expect(cut.migration?.state).toBe("cutover");
		expect(plane.pendingAgentRebinds().length).toBe(1);
	});

	it("auto-aborts ramp and compensates when dual oracle fails", () => {
		const plane = new IdentityMigrationControlPlane({ tenant: "t1" });
		plane.onMatchingDecision({
			tenant: "t1",
			sourceAdapter: "src",
			targetAdapter: "tgt",
		});
		plane.linkPrincipalJit();
		const fixtures = createContractAssertedDualFixtures({ tenant: "t1" });
		plane.service.linkPrincipal({
			sourceClaims: fixtures.sourceClaims,
			targetClaims: fixtures.divergentTargetClaims,
		});
		const r = plane.advanceRamp(25);
		expect(r.migration?.state).toBe("compensated");
		expect(r.flag?.enabled).toBe(false);
		expect(r.flag?.percentage).toBe(0);
	});

	it("matchingSignalsFromResourceDecision extracts identity port changes", () => {
		const sig = matchingSignalsFromResourceDecision({
			tenant: "t",
			port: "auth",
			previousProviderId: "clerk",
			winnerProviderId: "auth0",
		});
		expect(sig).toMatchObject({
			sourceAdapter: "clerk",
			targetAdapter: "auth0",
		});
		expect(
			matchingSignalsFromResourceDecision({
				tenant: "t",
				port: "database",
				winnerProviderId: "pg",
			}),
		).toBeNull();
		expect(
			matchingSignalsFromResourceDecision({
				tenant: "t",
				port: "kv",
				winnerProviderId: "x",
				yardMove: true,
			}),
		).toMatchObject({ yardMove: true });
	});

	it("startContinuousMigrationFromMatch convenience wires plane", () => {
		const { progress, decision } = startContinuousMigrationFromMatch({
			tenant: "acme",
			sourceAdapter: "a",
			targetAdapter: "b",
		});
		expect(decision.shouldStartMigration).toBe(true);
		expect(progress.status.present).toBe(true);
		expect(progress.status.bindleConfigRequired).toBe(false);
	});
});

describe("Spectrum cutover composition (Plan 50 + dual identity)", () => {
	it("Suspend → drain → dual migrate → export → import → fence → resume with zero-loss", () => {
		const result = runSpectrumIdentityCutover({
			tenant: "app-tenant-1",
			sourceAdapter: "pooled-idp",
			targetAdapter: "silo-idp",
			streamIds: ["stream:a", "stream:b"],
			principalSubjects: ["user-1", "user-2"],
			fence: createMemoryFencePort(),
			transfer: createMemoryTenantTransferPort({ headSeq: 99, streamCount: 2 }),
		});
		expect(result.ok).toBe(true);
		expect(result.zeroLoss).toBe(true);
		expect(result.phase).toBe("resumed");
		expect(result.linkedPrincipals).toBe(2);
		expect(result.sourceHeadSeq).toBe(99);
		expect(result.importedHeadSeq).toBe(99);
		const types = result.lifecycleEvents.map((e) => e.type);
		expect(types).toEqual([
			"tenant.Suspended",
			"tenant.Drained",
			"tenant.Exported",
			"tenant.Imported",
			"tenant.Fenced",
			"tenant.Resumed",
		]);
	});

	it("fail-closed when export/import headSeq diverges (zero-loss)", () => {
		const transfer = createMemoryTenantTransferPort({ headSeq: 10 });
		const broken = {
			exportTenant: transfer.exportTenant,
			importTenant: () => ({ importedHeadSeq: 9, streamCount: 3 }),
		};
		const result = runSpectrumIdentityCutover({
			tenant: "t",
			sourceAdapter: "a",
			targetAdapter: "b",
			streamIds: ["s1"],
			fence: createMemoryFencePort(),
			transfer: broken,
		});
		expect(result.ok).toBe(false);
		expect(result.zeroLoss).toBe(false);
	});
});

describe("FeatureFlagStore OpenFeature evaluation", () => {
	it("is deterministic for fixed targeting key", () => {
		const store = new FeatureFlagStore();
		store.define({ key: "f1", percentage: 50, enabled: true });
		const a = store.evaluateBoolean("f1", { targetingKey: "principal:x" });
		const b = store.evaluateBoolean("f1", { targetingKey: "principal:x" });
		expect(a.value).toBe(b.value);
		expect(a.reason === "targeting-match" || a.reason === "default").toBe(true);
	});
});
