import { describe, expect, it } from "vitest";

import type { IacProvider } from "../src/executor/executor.js";
import {
	assertSecretFree,
	createAttestedApplyWorker,
	createBuiltinProgressiveAnalysis,
	createContinuousDeliveryPlane,
	createContractAssertedCdFixtures,
	createDefaultSafetyEnvelope,
	createInProcessCredentialBroker,
	createOfflineIacProvider,
	createResidualProgressiveAnalysis,
	createResolvedDeploymentSet,
	createSecretFreeDiff,
	createSecretFreeStatus,
	DEPLOYMENT_PLAN_SCHEMA,
	decideFailurePath,
	toSecretFreeOutputs,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";


describe("Continuous Delivery plane (production path)", () => {
	it("delivers resolved set under attested apply + progressive promote", async () => {
		const fx = createContractAssertedCdFixtures({ tenant: "acme" });
		expect(fx.fidelity).toBe("simulated");
		const result = await fx.plane.deliver(fx.set);
		expect(result.apply.principal.attestationState).toBe("attested");
		expect(result.apply.secretFree).toBe(true);
		expect(result.apply.steps.every((s) => s.ambient === false)).toBe(true);
		expect(result.apply.steps.every((s) => s.ttlSeconds > 0)).toBe(true);
		expect(result.apply.steps.every((s) => s.credentialRevoked)).toBe(true);
		expect(result.apply.activeCredentialsAfter).toBe(0);
		for (const step of result.apply.steps) {
			const token = step.status.outputs.apiToken;
			expect(token).toBeDefined();
			if (isJsonObject(token)) {
				expect(token.kind).toBe("secretRef");
				expect(token.ref.startsWith("secretRef:")).toBe(true);
			}
			assertSecretFree(step.status);
			assertSecretFree(step.diff);
		}
		expect(result.progressive?.promoted).toBe(true);
		expect(result.progressive?.flagPercent).toBe(100);
		expect(result.progressive?.gatewayWeightPercent).toBe(100);
		expect(result.status).toBe("deployed");
		expect(result.logLines.length).toBeGreaterThan(0);
	});

	it("live path drives injected IacProvider through Executor under attestation", async () => {
		const applied: string[] = [];
		const liveIac: IacProvider = {
			id: "test-live-iac",
			async preview(program) {
				return { summary: `live preview ${program.resourceId}`, changes: 2 };
			},
			async apply(program) {
				applied.push(program.resourceId);
				return {
					resourceId: program.resourceId,
					provider: program.provider,
					endpoint: `https://${program.resourceId}.live.test`,
					// secret-looking field must be scrubbed
					dbPassword: "live-secret-must-scrub",
				};
			},
			async destroy() {},
			async refresh(program) {
				return { drift: false, observed: { resourceId: program.resourceId } };
			},
		};
		const broker = createInProcessCredentialBroker();
		const plane = createContinuousDeliveryPlane({
			mode: "live",
			iac: liveIac,
			broker,
		});
		const fx = createContractAssertedCdFixtures({ tenant: "live-t" });
		const result = await plane.deliver(fx.set, {
			deploymentId: "dep_live_1",
		});
		expect(result.apply.mode).toBe("live");
		expect(result.apply.status).toBe("succeeded");
		expect(applied).toEqual(["web", "api"]);
		expect(result.apply.principal.attestationState).toBe("attested");
		expect(result.apply.activeCredentialsAfter).toBe(0);
		for (const step of result.apply.steps) {
			assertSecretFree(step.status);
			const pwd = step.status.outputs.dbPassword;
			if (pwd !== undefined) {
				expect(isJsonObject(pwd)).toBe(true);
				if (isJsonObject(pwd)) {
					expect(pwd.kind).toBe("secretRef");
				}
			}
		}
		// status after apply returns recorded secret-free statuses
		const statuses = await plane.status(fx.set, "dep_live_1");
		expect(statuses).toHaveLength(2);
		for (const s of statuses) {
			expect(s.state).toBe("Provisioned");
			assertSecretFree(s);
		}
		const logs = plane.logs("dep_live_1");
		expect(logs.some((e) => e.type === "deployment.ApplySucceeded")).toBe(true);
	});

	it("live mode fails closed without injected IaC", () => {
		expect(() => createContinuousDeliveryPlane({ mode: "live" })).toThrow(
			/live attested apply requires injected iac or executor/,
		);
	});

	it("progressive SLO failure auto-rolls back flag+gateway and opens A2H", async () => {
		const fx = createContractAssertedCdFixtures();
		const result = await fx.plane.deliver(fx.set, {
			healthSamples: [{ sloBurning: true }],
		});
		expect(result.progressive?.rolledBack).toBe(true);
		expect(result.progressive?.flagPercent).toBe(0);
		expect(result.progressive?.gatewayWeightPercent).toBe(0);
		expect(result.progressive?.flagKillSwitch).toBe(true);
		expect(result.failure?.kind).toBe("a2h");
		if (result.failure?.kind === "a2h") {
			expect(result.failure.handoff.obligationId).toContain("a2h");
			expect(result.failure.handoff.decisionRequired).toContain("human");
			assertSecretFree(result.failure.handoff.context);
		}
		expect(result.status).toBe("a2h");
	});

	it("registered self-heal agent only gets a lane and proposes Delta", async () => {
		const fx = createContractAssertedCdFixtures({ tenant: "acme" });
		const result = await fx.plane.deliver(fx.set, {
			forceFailure: "apply-failed",
			selfHealAgent: {
				agentId: "agent:sre-heal",
				tenant: "acme",
				scopes: ["local-dev"],
				policyAllowed: true,
			},
			envelope: createDefaultSafetyEnvelope({
				blastRadius: "resource",
				reversible: true,
			}),
			attemptFixInLane: (lane) => {
				expect(lane.baselineMutation).toBe(false);
				expect(lane.baselineSingleWriterLease).toBe(false);
				expect(lane.forkOnTouch).toBe(true);
				expect(lane.externalSideEffects).toBe("mock");
				return { ok: true, summary: "patch in lane only" };
			},
		});
		expect(result.failure?.kind).toBe("self-heal-lane");
		if (result.failure?.kind === "self-heal-lane") {
			expect(result.failure.attempt.proposedDelta?.promotionPath).toBe(
				"gatekeeper-then-harness",
			);
			expect(result.failure.lane.baselineMutation).toBe(false);
		}
	});

	it("unknown blast radius fails closed to A2H even with self-heal agent", () => {
		const disposition = decideFailurePath({
			signal: "golden-failed",
			tenant: "t",
			environment: "prod",
			deploymentId: "d1",
			setId: "s1",
			context: { secretFree: true },
			envelope: createDefaultSafetyEnvelope({ blastRadius: "unknown" }),
			selfHealAgent: {
				agentId: "agent:x",
				tenant: "t",
				scopes: ["prod"],
				policyAllowed: true,
			},
			attemptFixInLane: () => ({ ok: true, summary: "should not run" }),
		});
		expect(disposition.kind).toBe("a2h");
	});

	it("residual progressive analysis fails soft to builtin", async () => {
		const residual = createResidualProgressiveAnalysis({
			kind: "flagger-shaped",
			webhookUrl: "https://analysis.invalid/hook",
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		const result = await residual.analyze({
			samples: [{}, {}],
			stagePercent: 25,
		});
		expect(result.verdict).toBe("promote");
		expect(result.adapter).toBe("flagger-shaped");
		expect(result.reason).toContain("unavailable");
		expect(result.reason).toContain("fallback");
	});

	it("builtin analysis rolls back on golden failure", async () => {
		const builtin = createBuiltinProgressiveAnalysis();
		const result = await builtin.analyze({
			samples: [{ goldenFailed: true }],
			stagePercent: 10,
		});
		expect(result.verdict).toBe("rollback");
	});

	it("secret-free projections never emit plaintext secrets", () => {
		const status = createSecretFreeStatus({
			resourceId: "db",
			state: "Provisioned",
			outputs: {
				password: "super-secret-password",
				endpoint: "db.local",
				AWS_SECRET_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE",
			},
		});
		expect(status.secretFree).toBe(true);
		expect(isJsonObject(status.outputs.password)).toBe(true);
		assertSecretFree(status);
		const scrubbed = toSecretFreeOutputs({
			api_key: "xoxb-1234567890-abcdefghij",
			name: "ok",
		});
		expect(scrubbed.secretRefs.length).toBeGreaterThan(0);
		const diff = createSecretFreeDiff({
			summary: "update secret",
			changes: [
				{
					path: "spec.secret",
					action: "update",
					before: "old-secret-value",
					after: "new-secret-value",
				},
			],
		});
		assertSecretFree(diff);
		expect(diff.secretBearingPaths).toContain("spec.secret");
	});

	it("refuses unapproved Gatekeeper sets", () => {
		expect(() =>
			createResolvedDeploymentSet({
				tenant: "t",
				environment: "prod",
				campId: "c",
				plan: {
					schema: DEPLOYMENT_PLAN_SCHEMA,
					resources: [],
					dependencyOrder: [],
					objective: "min-cost",
				},
				matches: [],
				gatekeeper: {
					// @ts-expect-error intentional deny
					decision: "deny",
					gatekeeperDecisionId: "gk_deny",
					obligations: [],
					decidedAt: new Date().toISOString(),
				},
			}),
		).toThrow(/Gatekeeper/);
	});

	it("offline IacProvider is a complete port used by simulate worker", async () => {
		const iac = createOfflineIacProvider();
		const broker = createInProcessCredentialBroker();
		const worker = createAttestedApplyWorker({
			mode: "simulate",
			iac,
			broker,
		});
		const fx = createContractAssertedCdFixtures();
		const apply = await worker.apply(fx.set, { deploymentId: "dep_off" });
		expect(apply.status).toBe("simulated");
		expect(apply.steps).toHaveLength(2);
		expect(broker.activeCount()).toBe(0);
		const statuses = await worker.status(fx.set, "dep_off");
		expect(statuses[0]?.state).toBe("Provisioned");
	});

	it("analysis hold does not promote (awaiting sustained evidence)", async () => {
		const fx = createContractAssertedCdFixtures();
		// Single empty sample → builtin analysis verdict "hold"
		const result = await fx.plane.deliver(fx.set, {
			healthSamples: [{}],
		});
		expect(result.progressive?.analysis.verdict).toBe("hold");
		expect(result.progressive?.held).toBe(true);
		expect(result.progressive?.promoted).toBe(false);
		expect(result.progressive?.rolledBack).toBe(false);
		// Must not claim full ship
		expect(result.status).toBe("holding");
		expect(result.progressive?.flagPercent).toBeLessThan(100);
		expect(result.progressive?.status).toBe("running");
	});

	it("operator rollback zeros flag percent, gateway weight, and kill-switch", async () => {
		const plane = createContinuousDeliveryPlane({ mode: "simulate" });
		const fx = createContractAssertedCdFixtures();
		const delivered = await plane.deliver(fx.set, {
			deploymentId: "dep_rb_1",
		});
		expect(delivered.status).toBe("deployed");
		expect(delivered.progressive?.flagPercent).toBe(100);
		expect(delivered.progressive?.gatewayWeightPercent).toBe(100);

		const rolled = await plane.rollback(fx.set, "dep_rb_1", "operator");
		expect(rolled.disposition.kind).toBe("a2h");
		expect(rolled.progressive.flagPercent).toBe(0);
		expect(rolled.progressive.gatewayWeightPercent).toBe(0);
		expect(rolled.progressive.flagKillSwitch).toBe(true);
		expect(rolled.progressive.status).toBe("rolled_back");

		const last = plane.lastResult();
		expect(last?.progressive?.flagPercent).toBe(0);
		expect(last?.progressive?.gatewayWeightPercent).toBe(0);
		expect(last?.progressive?.flagKillSwitch).toBe(true);
		expect(last?.status).toBe("a2h");
	});

	it("status() persists deployment.StatusObserved into logs", async () => {
		const plane = createContinuousDeliveryPlane({ mode: "simulate" });
		const fx = createContractAssertedCdFixtures();
		const delivered = await plane.deliver(fx.set, {
			deploymentId: "dep_status_evt",
		});
		await plane.status(fx.set, delivered.apply.deploymentId);
		const logs = plane.logs(delivered.apply.deploymentId);
		expect(logs.some((e) => e.type === "deployment.StatusObserved")).toBe(true);
		const observed = logs.find((e) => e.type === "deployment.StatusObserved");
		assertSecretFree(observed?.data ?? {});
	});
});
