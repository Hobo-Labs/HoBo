import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	applyPolicyGatedDefine,
	applyRolloutToGatewayRouting,
	composeGatewayWeightFromRollout,
	createBuiltinExperimentAnalysis,
	createCdResidualDeliveryAdapter,
	createContractAssertedHarnessFixtures,
	createHarness,
	createLocalFeatureClient,
	createMediatedFlagEvaluator,
	createOfrepResidualBackend,
	enrichEvaluationContext,
	FeatureFlagStore,
	gateFlagMutation,
	selectFeatureFlagBackend,
	trafficWeightSplitFromPercent,
} from "../src/index.js";

describe("Harness · Feature flags · progressive delivery", () => {
	it("OpenFeature client evaluates sticky percentage canary", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "new-checkout",
			percentage: 50,
			state: "ENABLED",
			variants: { control: false, treatment: true },
			defaultVariant: "control",
		});
		const client = createLocalFeatureClient(store, {
			userId: "user:alice",
			tenant: "acme",
		});
		const a = client.getBooleanDetails("new-checkout", false);
		const b = client.getBooleanDetails("new-checkout", false);
		expect(a.value).toBe(b.value);
		expect(a.reason === "targeting-match" || a.reason === "default").toBe(true);
	});

	it("fractional multi-variant assignment is deterministic", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "exp-flag",
			state: "ENABLED",
			variants: { control: "A", treatment: "B", holdout: "C" },
			defaultVariant: "control",
			targeting: {
				fractional: {
					key: ["identity.userId"],
					variants: [{ treatment: 33 }, { holdout: 33 }, { control: 34 }],
				},
			},
		});
		const ctx = enrichEvaluationContext({
			principal: { id: "user:sticky-1" },
			tenant: "t",
		});
		const d1 = store.evaluate("exp-flag", ctx, "control");
		const d2 = store.evaluate("exp-flag", ctx, "control");
		expect(d1.variant).toBe(d2.variant);
		expect(["control", "treatment", "holdout"]).toContain(d1.variant);
	});

	it("kill-switch forces default and bumps invalidation", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "risky",
			percentage: 100,
			defaultValue: true,
			variants: { treatment: true, control: false },
			defaultVariant: "control",
		});
		expect(store.evaluateBoolean("risky", { targetingKey: "u1" }).value).toBe(
			true,
		);
		store.activateKillSwitch("risky", "sre");
		const d = store.evaluateBoolean("risky", { targetingKey: "u1" });
		expect(d.reason).toBe("kill-switch");
		expect(d.value).toBe(false);
		expect(store.events.some((e) => e.type === "flag.KillSwitch")).toBe(true);
	});

	it("progressive composition: ramp → promote; auto-rollback on golden fail", () => {
		const store = new FeatureFlagStore();
		store.define({ key: "checkout", percentage: 0, state: "ENABLED" });
		const harness = createHarness({ store });
		const run = harness.startProgressive({
			rollout: {
				name: "checkout-canary",
				flag: "checkout",
				stages: [{ percent: 5 }, { percent: 25 }, { percent: 100 }],
				traffic: "gateway-weighted",
				autoRollback: true,
			},
			experiment: {
				name: "checkout-exp",
				flag: "checkout",
				variants: ["control", "treatment"],
				metrics: ["conversion"],
			},
		});
		expect(run.percent).toBe(5);
		expect(run.gatewayWeightPercent).toBe(5);
		expect(run.obligations).toContain("auto-rollback-on-slo-or-golden");

		const mid = harness.advance(run.rolloutId);
		expect(mid.percent).toBe(25);

		const rolled = harness.advance(run.rolloutId, { goldenFailed: true });
		expect(rolled.status).toBe("rolled_back");
		expect(rolled.percent).toBe(0);
		expect(store.get("checkout")?.killSwitch).toBe(true);
		expect(
			harness.delivery.events.some((e) => e.type === "rollout.RolledBack"),
		).toBe(true);
	});

	it("experiment assign + expose emits sampled events and OTEL hooks", () => {
		const otel: string[] = [];
		const store = new FeatureFlagStore();
		const harness = createHarness({
			store,
			emitOtel: (s) => otel.push(s.name),
		});
		harness.experiment.define({
			name: "btn-color",
			flag: "btn-color",
			variants: ["control", "treatment"],
		});
		const ctx = enrichEvaluationContext({
			principal: { id: "user:bob" },
			tenant: "acme",
		});
		const a = harness.trackExposure("btn-color", ctx);
		expect(["control", "treatment"]).toContain(a.variant);
		expect(
			harness.experiment.events.some((e) => e.type === "experiment.Assigned"),
		).toBe(true);
		expect(
			harness.experiment.events.some((e) => e.type === "experiment.Exposed"),
		).toBe(true);
		expect(otel).toContain("experiment.assign");
		expect(otel).toContain("experiment.expose");
	});

	it("local fixtures work offline with fidelity label", () => {
		const fx = createContractAssertedHarnessFixtures();
		expect(fx.fidelity).toBe("simulated");
		expect(fx.label).toBe("contract-asserted-harness-fixtures");
		const v = fx.client.getBooleanValue("example-feature", false);
		expect(v === true || v === false).toBe(true);
	});

	it("context enrichment injects PrincipalRef without app code", () => {
		const ctx = enrichEvaluationContext({
			principal: { kind: "user", id: "user:x", tenant: "t1" },
			camp: "camp-a",
			yard: "yard-a",
			environment: "staging",
		});
		expect(ctx.targetingKey).toBe("user:x");
		expect(ctx.attributes?.["identity.userId"]).toBe("user:x");
		expect(ctx.attributes?.camp).toBe("camp-a");
		expect(ctx.attributes?.environment).toBe("staging");
	});

	it("continuous identity migration store APIs remain intact", () => {
		const store = new FeatureFlagStore();
		const def = store.define({
			key: "identity-migration.abc",
			percentage: 10,
			enabled: true,
			migrationId: "mig_1",
			autoAbortOnDualFailure: true,
		});
		expect(def.migrationId).toBe("mig_1");
		expect(def.autoAbortOnDualFailure).toBe(true);
		const e = store.evaluateBoolean("identity-migration.abc", {
			targetingKey: "principal:t:x",
			tenant: "t",
		});
		expect(e.value === true || e.value === false).toBe(true);
	});

	it("multi-tenant isolation: tenant-bound flag fails closed for other tenants", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "tenant-a-only",
			percentage: 100,
			defaultValue: true,
			variants: { treatment: true, control: false },
			defaultVariant: "treatment",
			metadata: { tenant: "tenant-a" },
		});
		const own = store.evaluateBoolean("tenant-a-only", {
			targetingKey: "u1",
			tenant: "tenant-a",
		});
		expect(own.value).toBe(true);
		const other = store.evaluateBoolean(
			"tenant-a-only",
			{ targetingKey: "u1", tenant: "tenant-b" },
			false,
		);
		expect(other.value).toBe(false);
		expect(other.reason).toBe("fail-safe-default");
	});

	it("multi-tenant isolation: missing context.tenant fails closed for tenant-bound flag", () => {
		const store = new FeatureFlagStore({ sampleRate: 1 });
		store.define({
			key: "tenant-bound",
			percentage: 100,
			defaultValue: true,
			variants: { treatment: true, control: false },
			defaultVariant: "treatment",
			metadata: { tenant: "tenant-a" },
		});
		// No tenant on context — must not evaluate to treatment.
		const missing = store.evaluateBoolean(
			"tenant-bound",
			{ targetingKey: "u1" },
			false,
		);
		expect(missing.value).toBe(false);
		expect(missing.reason).toBe("fail-safe-default");
		// Empty string tenant is also a mismatch.
		const empty = store.evaluateBoolean(
			"tenant-bound",
			{ targetingKey: "u1", tenant: "" },
			false,
		);
		expect(empty.value).toBe(false);
		expect(empty.reason).toBe("fail-safe-default");
	});

	it("kill-switch survives delivery start/step and blocks treatment ramp", () => {
		const store = new FeatureFlagStore({ sampleRate: 1 });
		store.define({
			key: "risky-flag",
			percentage: 0,
			state: "ENABLED",
			defaultValue: false,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
		});
		store.activateKillSwitch("risky-flag", "sre");
		expect(store.get("risky-flag")?.killSwitch).toBe(true);

		const harness = createHarness({ store });
		const run = harness.startProgressive({
			rollout: {
				name: "must-not-clear-kill",
				flag: "risky-flag",
				stages: [{ percent: 25 }, { percent: 50 }],
				traffic: "flag-only",
				autoRollback: true,
			},
		});
		// Start must not clear kill-switch or resume treatment traffic.
		expect(store.get("risky-flag")?.killSwitch).toBe(true);
		expect(store.get("risky-flag")?.percentage).toBe(0);
		const afterStart = store.evaluateBoolean("risky-flag", {
			targetingKey: "user:any",
		});
		expect(afterStart.reason).toBe("kill-switch");
		expect(afterStart.value).toBe(false);

		const mid = harness.advance(run.rolloutId);
		expect(store.get("risky-flag")?.killSwitch).toBe(true);
		expect(store.get("risky-flag")?.percentage).toBe(0);
		const afterStep = store.evaluateBoolean("risky-flag", {
			targetingKey: "user:any",
		});
		expect(afterStep.reason).toBe("kill-switch");
		expect(afterStep.value).toBe(false);
		// Stage percent is tracked on rollout state, but flag evaluation stays dark.
		expect(mid.percent).toBe(50);
	});

	it("policy gates prod kill-switch; allows local; obligations on large jump", () => {
		const kill = gateFlagMutation({
			action: "hobo:flag:change",
			flagKey: "risky",
			environment: "production",
			killSwitch: true,
		});
		expect(kill.allowed).toBe(false);
		expect(kill.effect).toBe("require-approval");
		expect(kill.policyDecided.type).toBe("policy.Decided");

		const local = gateFlagMutation({
			action: "hobo:flag:change",
			flagKey: "risky",
			environment: "local-dev",
			killSwitch: true,
		});
		expect(local.allowed).toBe(true);

		const jump = gateFlagMutation({
			action: "hobo:flag:change",
			flagKey: "canary",
			environment: "prod",
			fromPercent: 5,
			toPercent: 50,
		});
		expect(jump.allowed).toBe(true);
		expect(jump.effect).toBe("allow-with-obligation");
		expect(
			jump.obligations.some((o) => o.kind === "flag.auto-revert-on-slo-burn"),
		).toBe(true);

		const store = new FeatureFlagStore();
		const blocked = applyPolicyGatedDefine(store, {
			key: "prod-kill",
			killSwitch: true,
			environment: "production",
		});
		expect(blocked.defined).toBeNull();
		expect(store.get("prod-kill")).toBeUndefined();

		const ok = applyPolicyGatedDefine(store, {
			key: "local-flag",
			percentage: 25,
			environment: "local",
		});
		expect(ok.defined).not.toBeNull();
		expect(store.get("local-flag")?.percentage).toBe(25);
	});

	it("backend ranking defaults to local-builtin (secretless ladder)", () => {
		expect(selectFeatureFlagBackend()).toBe("local-builtin");
		expect(
			selectFeatureFlagBackend([
				{ id: "external", available: true, mediated: true },
				{ id: "local-builtin", available: true, mediated: false },
			]),
		).toBe("local-builtin");
	});

	it("progressive promote path reaches 100%", () => {
		const store = new FeatureFlagStore();
		const harness = createHarness({ store });
		const run = harness.startProgressive({
			rollout: {
				name: "ship-it",
				flag: "ship",
				stages: [{ percent: 10 }, { percent: 100 }],
				traffic: "flag-only",
				autoRollback: true,
			},
		});
		const mid = harness.advance(run.rolloutId);
		expect(mid.percent).toBe(100);
		const done = harness.advance(run.rolloutId);
		expect(done.status).toBe("promoted");
		expect(store.get("ship")?.percentage).toBe(100);
	});

	it("loadDefinitions accepts Bindle-shaped feature specs and OpenFeature evaluates", () => {
		// Shape matches featureSpecsToStoreInputs(@hobo/bindles) — no reverse package dep.
		const store = new FeatureFlagStore({ sampleRate: 1 });
		store.loadDefinitions([
			{
				key: "new-checkout-flow",
				state: "ENABLED",
				percentage: 100,
				defaultValue: true,
				variants: { control: false, treatment: true },
				defaultVariant: "treatment",
			},
		]);
		const client = createLocalFeatureClient(store, {
			userId: "user:bindle",
			tenant: "acme",
		});
		expect(client.getBooleanValue("new-checkout-flow", false)).toBe(true);
	});

	it("gateway-weighted compose yields domain.RoutingChanged and zeros on rollback", () => {
		const store = new FeatureFlagStore();
		const harness = createHarness({ store });
		const run = harness.startProgressive({
			rollout: {
				name: "gw",
				flag: "gw-flag",
				stages: [{ percent: 20 }, { percent: 50 }],
				traffic: "gateway-weighted",
				autoRollback: true,
			},
		});
		expect(run.gatewayWeightPercent).toBe(20);
		expect(run.trafficSplit?.canary).toBe(20);
		expect(run.trafficSplit?.stable).toBe(80);
		expect(run.routingEvent?.type).toBe("domain.RoutingChanged");

		const composed = applyRolloutToGatewayRouting(
			harness.delivery,
			run.rolloutId,
		);
		expect(composed?.split.canary).toBe(20);

		const rolled = harness.advance(run.rolloutId, { sloBurning: true });
		expect(rolled.status).toBe("rolled_back");
		expect(rolled.gatewayWeightPercent).toBe(0);
		expect(rolled.trafficSplit?.canary).toBe(0);
		expect(rolled.routingEvent?.type).toBe("domain.RolledBack");
		expect(store.get("gw-flag")?.percentage).toBe(0);
	});

	it("trafficWeightSplitFromPercent is pure and clamps", () => {
		expect(trafficWeightSplitFromPercent(25)).toEqual(
			expect.objectContaining({ stable: 75, canary: 25, mode: "weighted" }),
		);
		expect(trafficWeightSplitFromPercent(200).canary).toBe(100);
	});

	it("experiment analysis export and conclude work on shipped engine", () => {
		const store = new FeatureFlagStore();
		const harness = createHarness({ store });
		harness.experiment.define({
			name: "btn",
			flag: "btn",
			variants: ["control", "treatment"],
			allocation: { weights: { treatment: 100, control: 0 } },
		});
		for (let i = 0; i < 5; i++) {
			harness.trackExposure(
				"btn",
				enrichEvaluationContext({ principal: { id: `user:${i}` } }),
			);
		}
		const analysis = harness.analyzeExperiment("btn");
		expect(analysis).not.toBeNull();
		expect(must(analysis).totalAssigned).toBeGreaterThan(0);
		expect(must(analysis).exportPayload.format).toBe("json");
		expect(must(analysis).exportPayload.contentHash.startsWith("sha256:")).toBe(
			true,
		);
		const concluded = harness.concludeExperiment("btn");
		expect(concluded?.verdict).toBeDefined();
		expect(
			harness.experiment.events.some((e) => e.type === "experiment.Concluded"),
		).toBe(true);
		// Built-in baseline analysis is real, not a stub.
		const baseline = createBuiltinExperimentAnalysis().analyze(
			{ name: "btn", flag: "btn", variants: ["control", "treatment"] },
			[
				{
					experiment: "btn",
					flag: "btn",
					variant: "treatment",
					subjectKey: "a",
					assignedAt: "t",
				},
			],
			1,
		);
		expect(baseline.verdict).toBe("ship");
		expect(baseline.winningVariant).toBe("treatment");
	});

	it("ranked mediated evaluator defaults local; residual OFREP fails closed", async () => {
		const store = new FeatureFlagStore();
		store.define({ key: "f", percentage: 100, defaultValue: true });
		const local = createMediatedFlagEvaluator({ store });
		expect(local.backend).toBe("local-builtin");
		const v = local.evaluate("f", { targetingKey: "u" }, false);
		// SAFETY: assertion to `alue: boolean }).value)` is required at this boundary.
		expect((v as { value: boolean }).value).toBe(true);

		const residual = createOfrepResidualBackend({
			baseUrl: "https://ofrep.example.invalid",
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		const mediated = createMediatedFlagEvaluator({
			store,
			residual,
			residualAvailable: true,
		});
		// Ranking prefers local-builtin when available.
		expect(mediated.backend).toBe("local-builtin");

		const remoteOnly = await residual.evaluate({
			flagKey: "missing",
			context: { targetingKey: "u" },
			defaultValue: false,
		});
		expect(remoteOnly.reason).toBe("fail-safe-default");
		expect(remoteOnly.value).toBe(false);
	});

	it("CD residual delivery adapter is complete and fail-soft", async () => {
		const calls: string[] = [];
		const adapter = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.example.invalid/hook",
			fetchImpl: async (url) => {
				calls.push(String(url));
				return {
					ok: true,
					status: 200,
					json: async () => ({}),
					text: async () => "",
				};
			},
		});
		const start = await adapter.startRemote({
			name: "r",
			flag: "f",
			stages: [{ percent: 10 }],
			traffic: "flag-only",
			autoRollback: true,
		});
		expect(start.accepted).toBe(true);
		expect(calls.length).toBe(1);

		const down = createCdResidualDeliveryAdapter({
			kind: "flagger-shaped",
			webhookUrl: "https://down.invalid",
			fetchImpl: async () => {
				throw new Error("down");
			},
		});
		const soft = await down.startRemote({
			name: "r",
			flag: "f",
			stages: [{ percent: 10 }],
			traffic: "gateway-weighted",
			autoRollback: true,
		});
		expect(soft.accepted).toBe(false);
		expect(soft.note).toContain("unavailable");
	});

	it("evaluation sampling is deterministic and always emits kill-switch", () => {
		const store = new FeatureFlagStore({ sampleRate: 0 });
		store.define({
			key: "s",
			percentage: 100,
			defaultValue: true,
			variants: { treatment: true, control: false },
			defaultVariant: "control",
		});
		store.evaluateBoolean("s", { targetingKey: "u1" });
		const before = store.events.filter(
			(e) => e.type === "flag.Evaluated",
		).length;
		// sampleRate 0: no ordinary Evaluated
		expect(before).toBe(0);
		store.activateKillSwitch("s");
		store.evaluateBoolean("s", { targetingKey: "u1" });
		expect(store.events.some((e) => e.type === "flag.KillSwitch")).toBe(true);
		expect(
			store.events.some(
				(e) =>
					e.type === "flag.Evaluated" &&
					// SAFETY: assertion to `s { reason?: string }).reason` is required at this boundary.
					(e.data as { reason?: string }).reason === "kill-switch",
			),
		).toBe(true);
	});

	it("composeGatewayWeightFromRollout tracks promote path", () => {
		const split = composeGatewayWeightFromRollout({
			id: "r1",
			gatewayWeightPercent: 100,
			status: "promoted",
			policy: {
				name: "n",
				flag: "f",
				stages: [{ percent: 100 }],
				traffic: "gateway-weighted",
				autoRollback: true,
			},
		});
		expect(split.split.canary).toBe(100);
		expect(split.event.type).toBe("domain.RoutingChanged");
	});
});
