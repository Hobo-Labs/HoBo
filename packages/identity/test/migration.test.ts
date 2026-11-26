import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	advanceMigrationRamp,
	agentActionsForMigrationEvents,
	createContractAssertedDualFixtures,
	decideIdentityMigration,
	defaultContinuousMappingSpec,
	dualVerifyClaims,
	evaluateCanMigrate,
	IdentityMigrationService,
	mintDualAudienceGrant,
	principalInMigrationCohort,
	verifyDualAudienceGrant,
} from "../src/index.js";

const TENANT = "tenant-mig";

describe("Continuous Identity Migration Plane", () => {
	it("Matching decides continuous migration with zero Bindle config", () => {
		const decision = decideIdentityMigration({
			tenant: TENANT,
			sourceAdapter: "oidc-legacy",
			targetAdapter: "oidc-modern",
		});
		expect(decision.shouldStartMigration).toBe(true);
		expect(decision.continuousDefault).toBe(true);
		expect(decision.reason).toBe("adapter-change");
		expect(decision.mode).toBe("jit");
		expect(decision.ranking).toContain("no-bindle-adapter-config");
		expect(decision.mapping.sourceAdapter).toBe("oidc-legacy");
	});

	it("does not require preferredAdapters for continuous path", () => {
		const decision = decideIdentityMigration({
			tenant: TENANT,
			sourceAdapter: "a",
			targetAdapter: "b",
		});
		expect(decision.shouldStartMigration).toBe(true);
		expect(decision.explanation).toMatch(/zero Bindle config/i);
	});

	it("policy ceiling can deny continuous", () => {
		const decision = decideIdentityMigration({
			tenant: TENANT,
			sourceAdapter: "a",
			targetAdapter: "b",
			policyDeniesContinuous: true,
		});
		expect(decision.shouldStartMigration).toBe(false);
	});

	it("dual fixtures: consistent path ok, divergent fail-closed", () => {
		const dual = createContractAssertedDualFixtures({ tenant: TENANT });
		expect(dual.fidelity.dual).toBe("simulated");
		expect(dual.label).toBe("contract-asserted-dual-fixtures");

		const ok = dualVerifyClaims({
			mapping: dual.mapping,
			sourceClaims: dual.sourceClaims,
			targetClaims: dual.targetClaims,
			tenant: dual.tenant,
		});
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.principalRef).toBe(dual.principalRef);
		}

		const bad = dualVerifyClaims({
			mapping: dual.mapping,
			sourceClaims: dual.sourceClaims,
			targetClaims: dual.divergentTargetClaims,
			tenant: dual.tenant,
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.code).toBe("dual-consistency-failed");
		}
	});

	it("can-migrate dry-run is ok with platform default MappingSpec", () => {
		const mapping = defaultContinuousMappingSpec({
			sourceAdapter: "src",
			targetAdapter: "tgt",
		});
		const result = evaluateCanMigrate({
			sourceAdapter: "src",
			targetAdapter: "tgt",
			mapping,
			dualOracleReady: true,
		});
		expect(result.ok).toBe(true);
		expect(result.dimension).toBe("can-migrate");
		expect(result.evidence.continuousDefault).toBe(true);
		expect(result.evidence.dryRun).toBe(true);
		expect(result.evidence.rollbackPosture).toBe("compensate-to-source");
	});

	it("can-migrate fails closed without MappingSpec", () => {
		const result = evaluateCanMigrate({
			sourceAdapter: "src",
			targetAdapter: "tgt",
		});
		expect(result.ok).toBe(false);
		expect(result.reasons[0]?.code).toBe("mapping-spec-missing");
	});

	it("JIT dual-link → ramp → cutover with PrincipalRef continuity", () => {
		const dual = createContractAssertedDualFixtures({ tenant: TENANT });
		const svc = new IdentityMigrationService({
			tenant: TENANT,
			vaultRoot: "fixture-vault-migration",
		});
		const started = svc.start({
			tenant: TENANT,
			sourceAdapter: dual.sourceAdapter,
			targetAdapter: dual.targetAdapter,
			mapping: dual.mapping,
			reason: "adapter-change",
			mode: "jit",
			matchDecisionId: "match-test-1",
		});
		expect(started.state).toBe("dual-active");

		const linked = svc.linkPrincipal({
			sourceClaims: dual.sourceClaims,
			targetClaims: dual.targetClaims,
		});
		expect(linked.verify.ok).toBe(true);
		if (linked.verify.ok) {
			expect(linked.verify.principalRef).toBe(dual.principalRef);
			expect(linked.grant?.audiences).toHaveLength(2);
			const verified = verifyDualAudienceGrant({
				grant: must(linked.grant),
				vaultRoot: "fixture-vault-migration",
			});
			expect(verified.ok).toBe(true);
		}

		const ramped = svc.advanceRamp({ rampPercent: 50 });
		expect(ramped.state).toBe("ramping");
		expect(ramped.rampPercent).toBe(50);

		svc.advanceRamp({ rampPercent: 100 });
		svc.markMigrated(dual.principalRef);
		const cut = svc.cutover();
		expect(cut.state).toBe("cutover");

		// Event-sourced rebuild preserves PrincipalRef link.
		const rebuilt = IdentityMigrationService.fromEvents(svc.events, {
			tenant: TENANT,
			mapping: dual.mapping,
		});
		expect(rebuilt.snapshot()?.links[dual.principalRef]?.migrated).toBe(true);
		expect(rebuilt.snapshot()?.state).toBe("cutover");

		// Never-compact retention on every event.
		for (const e of svc.events) {
			expect(e.retention.neverCompact).toBe(true);
			const json = JSON.stringify(e);
			expect(json).not.toMatch(/fixture-vault-migration/);
			expect(json).not.toMatch(/password|client_secret|refresh_token/i);
		}
	});

	it("fail-closed dual divergence increments failed checks and can abort ramp", () => {
		const dual = createContractAssertedDualFixtures({ tenant: TENANT });
		const svc = new IdentityMigrationService({ tenant: TENANT });
		svc.start({
			tenant: TENANT,
			sourceAdapter: dual.sourceAdapter,
			targetAdapter: dual.targetAdapter,
			mapping: dual.mapping,
			reason: "adapter-change",
		});
		// Seed one good link then ramp so abort path is active.
		svc.linkPrincipal({
			sourceClaims: dual.sourceClaims,
			targetClaims: dual.targetClaims,
		});
		svc.advanceRamp({ rampPercent: 10 });

		for (let i = 0; i < 3; i++) {
			svc.linkPrincipal({
				sourceClaims: dual.sourceClaims,
				targetClaims: dual.divergentTargetClaims,
			});
		}
		const snap = svc.snapshot();
		expect(snap?.failedChecks).toBeGreaterThanOrEqual(3);
		expect(snap?.state).toBe("aborted");
	});

	it("Harness auto-abort + compensate on dual oracle failure", () => {
		const dual = createContractAssertedDualFixtures({ tenant: TENANT });
		const svc = new IdentityMigrationService({ tenant: TENANT });
		svc.start({
			tenant: TENANT,
			sourceAdapter: dual.sourceAdapter,
			targetAdapter: dual.targetAdapter,
			mapping: dual.mapping,
			reason: "policy",
		});
		svc.linkPrincipal({
			sourceClaims: dual.sourceClaims,
			targetClaims: dual.targetClaims,
		});
		const result = advanceMigrationRamp({
			service: svc,
			targetPercent: 25,
			dualConsistencyOk: false,
		});
		expect(result.aborted).toBe(true);
		expect(result.record?.state).toBe("compensated");
		expect(result.flag.enabled).toBe(false);
	});

	it("agent rebind actions fire on identity.Migrated with zero config", () => {
		const dual = createContractAssertedDualFixtures({ tenant: TENANT });
		const svc = new IdentityMigrationService({ tenant: TENANT });
		svc.start({
			tenant: TENANT,
			sourceAdapter: dual.sourceAdapter,
			targetAdapter: dual.targetAdapter,
			mapping: dual.mapping,
			reason: "adapter-change",
		});
		svc.linkPrincipal({
			sourceClaims: dual.sourceClaims,
			targetClaims: dual.targetClaims,
		});
		svc.advanceRamp({ rampPercent: 100 });
		svc.markMigrated(dual.principalRef);
		const actions = agentActionsForMigrationEvents(svc.events);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.action).toBe("re-attest-svid");
		expect(actions[0]?.principalRef).toBe(dual.principalRef);
	});

	it("cohort membership is deterministic under ramp percent", () => {
		const ref = "principal:t:abc";
		expect(
			principalInMigrationCohort({ principalRef: ref, percentage: 0 }),
		).toBe(false);
		expect(
			principalInMigrationCohort({ principalRef: ref, percentage: 100 }),
		).toBe(true);
		const a = principalInMigrationCohort({ principalRef: ref, percentage: 50 });
		const b = principalInMigrationCohort({ principalRef: ref, percentage: 50 });
		expect(a).toBe(b);
	});

	it("dual-audience grant scope never widens material exposure", () => {
		const grant = mintDualAudienceGrant({
			principalRef: "principal:t:x",
			sourceAdapter: "a",
			targetAdapter: "b",
			scope: { port: "identity", resource: "p", action: "auth" },
			vaultRoot: "vault",
			ttlSeconds: 60,
		});
		expect(grant.tokenRef.startsWith("tokenref://dual/")).toBe(true);
		expect(grant.audiences).toEqual(["hobo:adapter:a", "hobo:adapter:b"]);
	});

	it("zero-loss cutover: all dual-linked principals migrate", () => {
		const dual = createContractAssertedDualFixtures({
			tenant: TENANT,
			subject: "bob",
		});
		const dual2 = createContractAssertedDualFixtures({
			tenant: TENANT,
			subject: "carol",
			email: "carol@example.test",
		});
		const svc = new IdentityMigrationService({ tenant: TENANT });
		svc.start({
			tenant: TENANT,
			sourceAdapter: dual.sourceAdapter,
			targetAdapter: dual.targetAdapter,
			mapping: dual.mapping,
			reason: "spectrum",
			mode: "background",
		});
		const l1 = svc.linkPrincipal({
			sourceClaims: dual.sourceClaims,
			targetClaims: dual.targetClaims,
		});
		const l2 = svc.linkPrincipal({
			sourceClaims: dual2.sourceClaims,
			targetClaims: dual2.targetClaims,
		});
		expect(l1.verify.ok && l2.verify.ok).toBe(true);
		svc.advanceRamp({ rampPercent: 100 });
		if (l1.verify.ok) svc.markMigrated(l1.verify.principalRef);
		if (l2.verify.ok) svc.markMigrated(l2.verify.principalRef);
		const cut = svc.cutover();
		expect(cut.linkedPrincipals).toBe(2);
		expect(cut.failedChecks).toBe(0);
		expect(Object.values(cut.links).every((l) => l.migrated)).toBe(true);
	});
});
