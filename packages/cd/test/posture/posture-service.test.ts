// PostureService (plan 0024 D25, I22): continuous compliance from reconcile
// observations, one mutator, and the projections HOBO_POSTURE reads.
import { readdirSync, readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampConditionType,
	ComplianceState,
	ConditionStatus,
	DeltaRecordSchema,
	PolicyMode,
	SetOrigin,
	SignalSource,
} from "../../src/_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	OWNERSHIP_CONFLICT,
} from "../../src/events.js";
import {
	applyPostureFixes,
	createPostureService,
	createShadowRecorder,
	keptConflicts,
	setValue,
} from "../../src/posture/index.js";
import {
	CampManagement,
	camp,
	digest,
	HOUR,
	MINUTE,
	observe,
	promotion,
	RemediationMode,
	railDelivery,
	railFreight,
	resolvedSet,
} from "./fakes.js";
import { type PostureHarness, postureHarness } from "./harness.js";

const PROD = camp("prod-1");
const RAIL_A = digest("a");
const RAIL_B = digest("b");

const ROUTE_10 = {
	resource: "api",
	kind: "http-route",
	classification: "pii",
	attributes: { "tls.min_version": "1.0" },
};
const ROUTE_13 = {
	resource: "api",
	kind: "http-route",
	classification: "pii",
	attributes: { "tls.min_version": "1.3" },
};

function bindEnforced(
	h: PostureHarness,
	mode: RemediationMode,
	opts: Readonly<{ compliantMs?: number; noncompliantMs?: number }> = {},
) {
	h.rails.byCamp.set(
		PROD,
		railDelivery(RAIL_A, [
			{ pack: "tls-baseline", remediation: mode, ...opts },
		]),
	);
}

function records(h: PostureHarness, type: string) {
	return h.store
		.events(CD_STREAMS.compliance(PROD))
		.filter((e) => e.type === type);
}

describe("evaluation and compliance records", () => {
	it("evaluates due Camps from the latest status observation and records the position it used", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.INFORM);
		await observe(h.store, PROD, [ROUTE_13]);
		const position = await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		const [record] = await h.service.compliance(PROD);
		expect(record?.state).toBe(ComplianceState.NONCOMPLIANT);
		expect(record?.observationPosition).toBe(position.toString());
		expect(record?.railDigest).toBe(RAIL_A);
		expect(record?.candidate).toBe(false);
		expect(record?.findings.map((f) => [f.rule, f.resource, f.state])).toEqual([
			["tls-baseline/no-public-buckets", "", ComplianceState.NOT_APPLICABLE],
			["tls-baseline/tls-min-version", "api", ComplianceState.NONCOMPLIANT],
		]);
		expect(records(h, CD_EVENTS.ComplianceObserved)).toHaveLength(1);
		expect(records(h, CD_EVENTS.ComplianceChanged)).toHaveLength(1);
	});

	it("updates POSTURE_COMPLIANT on every state change, from the HoBo posture health source", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.INFORM);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await observe(h.store, PROD, [ROUTE_13]);
		await h.service.tick(h.ctx());
		const conditions = h.inventory.observed.map((o) => o.conditions[0]);
		expect(conditions.map((c) => [c?.type, c?.status, c?.source])).toEqual([
			[
				CampConditionType.POSTURE_COMPLIANT,
				ConditionStatus.FALSE,
				SignalSource.HEALTH_SOURCE,
			],
			[
				CampConditionType.POSTURE_COMPLIANT,
				ConditionStatus.TRUE,
				SignalSource.HEALTH_SOURCE,
			],
		]);
		expect(
			h.inventory.observed.every(
				(o) => o.source === SignalSource.HEALTH_SOURCE,
			),
		).toBe(true);
		expect(records(h, CD_EVENTS.ComplianceChanged)).toHaveLength(2);
	});

	it("runs at the binding's compliant and noncompliant intervals (defaults from CD_DEFAULTS)", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.INFORM);
		await observe(h.store, PROD, [ROUTE_13]);
		await h.service.tick(h.ctx());
		await h.service.tick(h.ctx());
		h.time.advance(CD_DEFAULTS.postureCompliantIntervalMs - 1);
		await h.service.tick(h.ctx());
		expect(records(h, CD_EVENTS.ComplianceObserved)).toHaveLength(1);
		h.time.advance(1);
		await h.service.tick(h.ctx());
		expect(records(h, CD_EVENTS.ComplianceObserved)).toHaveLength(2);
		// A binding's own interval wins.
		bindEnforced(h, RemediationMode.INFORM, { compliantMs: MINUTE });
		h.time.advance(MINUTE);
		await h.service.tick(h.ctx());
		expect(records(h, CD_EVENTS.ComplianceObserved)).toHaveLength(3);
		// Repeated changes under the same state append no Changed.
		expect(records(h, CD_EVENTS.ComplianceChanged)).toHaveLength(1);
	});

	it("records nothing for a Camp without an observation (no fabricated compliance)", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.INFORM);
		await h.service.tick(h.ctx());
		expect(await h.service.compliance(PROD)).toEqual([]);
		expect(h.telemetry.named("hobo.cd.posture.no_observation")).toHaveLength(1);
		expect(
			await h.service.noncompliantRatio({
				campId: PROD,
				fromMs: 0,
				toMs: Number.MAX_SAFE_INTEGER,
			}),
		).toEqual([]);
	});

	it("records UNKNOWN (ratio 1) when a bound pack is missing or invalid, never compliant by absence", async () => {
		const h = postureHarness({ packs: [{ ...TLS_PACK_BROKEN }] });
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		const [record] = await h.service.compliance(PROD);
		expect(record?.state).toBe(ComplianceState.UNKNOWN);
		expect(
			await h.service.noncompliantRatio({
				campId: PROD,
				fromMs: 0,
				toMs: Number.MAX_SAFE_INTEGER,
			}),
		).toEqual([1]);
		expect(h.telemetry.named("hobo.cd.posture.pack_invalid")).toHaveLength(1);
		expect(h.desired.opened).toEqual([]);
	});

	it("emits the noncompliant-ratio gauge and evaluation counters", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.INFORM);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		expect(
			h.telemetry
				.named("hobo.cd.compliance.noncompliant_ratio")
				.map((p) => p.value),
		).toEqual([1]);
		expect(h.telemetry.named("hobo.cd.posture.evaluations")).toHaveLength(1);
	});
});

const TLS_PACK_BROKEN = {
	schemaVersion: "hobo.policy-ir/v1",
	profile: "hobo.posture/v1",
	pack: "tls-baseline",
	observeFields: [],
	rules: [
		{
			id: "x",
			phase: "observe",
			effect: "warn",
			require: [{ field: "a", op: "regex", value: "." }],
			severity: "low",
		},
	],
};

describe("remediation per D25 (one mutator, I22)", () => {
	it("inform records compliance only: no remediation, no Delta", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.INFORM);
		h.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		expect(await h.service.remediations(PROD)).toEqual([]);
		expect(h.desired.opened).toEqual([]);
	});

	it("a rule that contradicts a Set-owned value mutates nothing and yields ownership-conflict", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		const resolved = resolvedSet(PROD, [
			{ name: "api", parameters: { tls: { min_version: "1.0" } } },
		]);
		h.desired.seed(PROD, resolved);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		expect(h.desired.opened).toEqual([]);
		expect(h.desired.applied).toEqual([]);
		const conflicts = await h.service.conflicts(PROD);
		expect(
			conflicts.map((f) => [f.rule, f.resource, f.ownershipConflict]),
		).toEqual([["tls-baseline/tls-min-version", "api", true]]);
		const [remediation] = await h.service.remediations(PROD);
		expect(remediation?.reasons[0]?.code).toBe(OWNERSHIP_CONFLICT);
		expect(remediation?.deltaId).toBe("");
		// Repeating the evaluation does not repeat the remediation record.
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await h.service.tick(h.ctx());
		expect(await h.service.remediations(PROD)).toHaveLength(1);
	});

	it("the next promotion that keeps the violation is refused; one that changes the declaration is not", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		const resolved = resolvedSet(PROD, [
			{ name: "api", parameters: { tls: { min_version: "1.0" } } },
			{ name: "web" },
		]);
		h.desired.seed(PROD, resolved);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		const conflicts = await h.service.conflicts(PROD);
		const keeps = create(DeltaRecordSchema, {
			deltaId: "d-keep",
			campId: PROD,
			changes: [{ resource: "web" }],
			intent: "promote",
		});
		expect(keptConflicts({ conflicts, delta: keeps, resolved })).toHaveLength(
			1,
		);
		const fixes = create(DeltaRecordSchema, {
			deltaId: "d-fix",
			campId: PROD,
			changes: [{ resource: "api" }],
			intent: "promote",
		});
		expect(keptConflicts({ conflicts, delta: fixes, resolved })).toEqual([]);
	});

	it("a Set-owned compliant value that drifted on the target is drift for the reconciler, not a posture Delta", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		h.desired.seed(
			PROD,
			resolvedSet(PROD, [
				{ name: "api", parameters: { tls: { min_version: "1.3" } } },
			]),
		);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		expect(h.desired.opened).toEqual([]);
		expect((await h.service.remediations(PROD))[0]?.reasons[0]?.code).toBe(
			"posture-drift",
		);
		expect(await h.service.conflicts(PROD)).toEqual([]);
	});

	it("enforce on an unowned field opens a gated posture-remediate Delta the reconciler applies", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		const base = resolvedSet(PROD, [{ name: "api" }]);
		const set = h.desired.seed(PROD, base);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		expect(h.desired.opened).toHaveLength(1);
		const delta = h.desired.opened[0];
		expect(delta?.intent).toBe("posture-remediate");
		expect(delta?.baseSetId).toBe(set.setId);
		expect(delta?.proposal).toBe(false);
		expect(delta?.changes.map((c) => [c.resource, c.provider])).toEqual([
			["api", "cloudflare"],
		]);
		// Posture never applies: the gate admits the Delta and the reconciler converges it.
		expect(h.desired.applied).toEqual([]);
		const [remediation] = await h.service.remediations(PROD);
		expect(remediation?.deltaId).toBe(delta?.deltaId);
		expect(remediation?.reasons.map((r) => r.code)).toEqual([
			"posture-remediation-proposed",
			"posture-fix",
		]);
		expect(
			h.authorizer.calls.filter((c) => c.action === "posture.enforce"),
		).toHaveLength(1);
		// The fix the planning adapter resolves for the Delta; once applied the Set owns the field.
		const fixes = JSON.parse(remediation?.reasons[1]?.message ?? "[]");
		const plan = applyPostureFixes(base, "api", fixes);
		const after = { ...base, plan };
		expect(setValue(after, "api", "tls.min_version")).toBe("1.3");
		expect(SetOrigin.POSTURE_REMEDIATION).toBe(11);
		// Ticking again before anything converged proposes nothing new.
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await h.service.tick(h.ctx());
		expect(h.desired.opened).toHaveLength(1);
		expect(await h.service.remediations(PROD)).toHaveLength(1);
	});

	it("a proposal-only principal opens a proposal; a refused grant opens nothing", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		h.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(h.store, PROD, [ROUTE_10]);
		h.authorizer.proposalOnly.add("posture.enforce");
		await h.service.tick(h.ctx());
		expect(h.desired.opened[0]?.proposal).toBe(true);

		const denied = postureHarness();
		denied.inventory.add(PROD);
		bindEnforced(denied, RemediationMode.ENFORCE);
		denied.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(denied.store, PROD, [ROUTE_10]);
		denied.authorizer.deny.add("posture.enforce");
		await denied.service.tick(denied.ctx());
		expect(denied.desired.opened).toEqual([]);
		expect(
			(await denied.service.remediations(PROD))[0]?.reasons.map((r) => r.code),
		).toEqual(["posture-enforce-unauthorized", "authz-denied"]);
	});

	it("a target-side retained fix field is never remediated", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		h.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(h.store, PROD, [
			{ ...ROUTE_10, retained: ["tls.min_version"] },
		]);
		await h.service.tick(h.ctx());
		expect(h.desired.opened).toEqual([]);
		expect((await h.service.remediations(PROD))[0]?.reasons[0]?.code).toBe(
			"posture-unremediable-retained",
		);
	});

	it("a refused Delta open is recorded and retried at the next evaluation", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		h.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(h.store, PROD, [ROUTE_10]);
		h.desired.refuseOpen = true;
		await h.service.tick(h.ctx());
		expect(
			(await h.service.remediations(PROD))[0]?.reasons.map((r) => r.code),
		).toEqual(["posture-delta-refused", "delta-open-conflict"]);
		h.desired.refuseOpen = false;
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await h.service.tick(h.ctx());
		expect(h.desired.opened).toHaveLength(1);
	});

	it("OBSERVE_ONLY Camps get posture in inform only, even under an enforce binding", async () => {
		const h = postureHarness();
		h.inventory.add(PROD, CampManagement.OBSERVE_ONLY);
		bindEnforced(h, RemediationMode.ENFORCE);
		h.desired.seed(
			PROD,
			resolvedSet(PROD, [
				{ name: "api", parameters: { tls: { min_version: "1.0" } } },
			]),
		);
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		expect((await h.service.compliance(PROD))[0]?.state).toBe(
			ComplianceState.NONCOMPLIANT,
		);
		expect(h.desired.opened).toEqual([]);
		expect(await h.service.remediations(PROD)).toEqual([]);
		expect(await h.service.conflicts(PROD)).toEqual([]);
	});

	it("inform-only cannot be escalated by a parent enforce binding", async () => {
		const h = postureHarness({ packs: [{ ...TLS_PACK_PINNED }] });
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		h.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(h.store, PROD, [ROUTE_10]);
		await h.service.tick(h.ctx());
		expect((await h.service.compliance(PROD))[0]?.state).toBe(
			ComplianceState.NONCOMPLIANT,
		);
		expect(h.desired.opened).toEqual([]);
		expect(await h.service.remediations(PROD)).toEqual([]);
		// And a Rail binding the same pack twice keeps the most conservative mode.
		const twice = postureHarness();
		twice.inventory.add(PROD);
		twice.rails.byCamp.set(
			PROD,
			railDelivery(RAIL_A, [
				{ pack: "tls-baseline", remediation: RemediationMode.ENFORCE },
				{ pack: "tls-baseline", remediation: RemediationMode.INFORM_ONLY },
			]),
		);
		twice.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(twice.store, PROD, [ROUTE_10]);
		await twice.service.tick(twice.ctx());
		expect(twice.desired.opened).toEqual([]);
	});

	it("the posture module never calls a delivery mutator (I2/I22 architecture scan)", () => {
		const dir = new URL("../../src/posture/", import.meta.url);
		const sources = readdirSync(dir)
			.filter((f) => f.endsWith(".ts"))
			.map((f) => [f, readFileSync(new URL(f, dir), "utf8")] as const);
		expect(sources.length).toBeGreaterThan(5);
		for (const [file, text] of sources) {
			const code = text.replace(/\/\/.*$/gmu, "");
			expect(code, file).not.toMatch(/\.apply\(\s*\{/u);
			expect(code, file).not.toMatch(/\b(converge|publish|shift|cutover)\(/u);
			expect(code, file).not.toMatch(
				/from "\.\.\/(reconcile|rollout|adapters|feed|agent)\//u,
			);
			expect(code, file).not.toMatch(
				/TrafficRoutingPort|Realizer|HostingTransition|ResourceResolver/u,
			);
		}
	});
});

const TLS_PACK_PINNED = {
	schemaVersion: "hobo.policy-ir/v1",
	profile: "hobo.posture/v1",
	pack: "tls-baseline",
	remediation: "inform-only",
	observeFields: ["tls.min_version"],
	rules: [
		{
			id: "tls-min-version",
			phase: "observe",
			effect: "mutate",
			match: { kinds: ["http-route"] },
			require: [{ field: "tls.min_version", op: "semver-gte", value: "1.2" }],
			severity: "high",
			controls: ["SC-8"],
			fix: [{ field: "tls.min_version", value: "1.3" }],
		},
	],
};

describe("candidate Rails, series and observe_fields", () => {
	async function informBound(h: PostureHarness) {
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.ENFORCE);
		h.rails.byDigest.set(
			RAIL_B,
			railDelivery(RAIL_B, [
				{ pack: "tls-strict", remediation: RemediationMode.ENFORCE },
			]),
		);
		await h.campPolicy.bind(
			{
				campId: PROD,
				freight: railFreight(RAIL_B),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx(),
		);
	}

	it("evaluates the candidate Rail beside the enforced one and never remediates for it", async () => {
		const h = postureHarness();
		await informBound(h);
		h.desired.seed(
			PROD,
			resolvedSet(PROD, [
				{ name: "api", parameters: { tls: { min_version: "1.2" } } },
			]),
		);
		await observe(h.store, PROD, [
			{ ...ROUTE_10, attributes: { "tls.min_version": "1.2" } },
		]);
		await h.service.tick(h.ctx());
		const all = await h.service.compliance(PROD);
		expect(all.map((r) => [r.railDigest, r.candidate, r.state])).toEqual([
			[RAIL_A, false, ComplianceState.COMPLIANT],
			[RAIL_B, true, ComplianceState.NONCOMPLIANT],
		]);
		expect(h.desired.opened).toEqual([]);
		// The candidate never drives POSTURE_COMPLIANT.
		expect(h.inventory.observed.map((o) => o.conditions[0]?.status)).toEqual([
			ConditionStatus.TRUE,
		]);
	});

	it("a bound candidate whose Rail cannot be resolved records UNKNOWN (fail closed)", async () => {
		const h = postureHarness({ candidateRail: false });
		await informBound(h);
		await observe(h.store, PROD, [ROUTE_13]);
		await h.service.tick(h.ctx());
		const candidate = (await h.service.compliance(PROD)).find(
			(r) => r.candidate,
		);
		expect(candidate?.state).toBe(ComplianceState.UNKNOWN);
		expect(
			await h.service.noncompliantRatio({
				campId: PROD,
				railDigest: RAIL_B,
				fromMs: 0,
				toMs: Number.MAX_SAFE_INTEGER,
			}),
		).toEqual([1]);
	});

	it("serves the noncompliant-ratio and shadow-divergence series by window and Rail", async () => {
		const h = postureHarness();
		await informBound(h);
		await observe(h.store, PROD, [ROUTE_13]);
		const t0 = h.time.now();
		await h.service.tick(h.ctx());
		const shadow = createShadowRecorder({
			...h.deps,
			resolvePack: async () => ({ id: "p", version: "1", rules: [] }),
		});
		h.time.advance(MINUTE);
		await shadow.record(
			{
				$typeName: "hobo.cd.v1.ShadowDecisionRecord",
				campId: PROD,
				deltaId: "d1",
				enforcedRailDigest: RAIL_A,
				candidateRailDigest: RAIL_B,
				enforcedEffect: "allow",
				candidateEffect: "deny",
				diverged: true,
				decidedAt: new Date(h.time.now()).toISOString(),
			},
			h.ctx(),
		);
		const window = { campId: PROD, fromMs: t0, toMs: t0 + HOUR };
		expect(await h.service.noncompliantRatio(window)).toEqual([0]);
		expect(
			await h.service.noncompliantRatio({ ...window, railDigest: RAIL_B }),
		).toEqual([0]);
		expect(
			await h.service.shadowDivergence({ ...window, railDigest: RAIL_B }),
		).toEqual([0, 1]);
		expect(
			await h.service.shadowDivergence({ ...window, railDigest: RAIL_A }),
		).toEqual([]);
		expect(
			await h.service.noncompliantRatio({ ...window, fromMs: t0 + 1 }),
		).toEqual([]);
	});

	it("observeFields is the union of the enforced and candidate Rails' packs", async () => {
		const h = postureHarness();
		await informBound(h);
		expect(await h.service.observeFields(PROD)).toEqual([
			"hsts",
			"public",
			"tls.min_version",
		]);
		expect(await h.service.observeFields(camp("unbound"))).toEqual([]);
	});
});

describe("replay", () => {
	it("a fresh service over the same journal reproduces every compliance and remediation record", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		h.inventory.add("prod-2");
		bindEnforced(h, RemediationMode.ENFORCE);
		h.rails.byCamp.set(
			camp("prod-2"),
			railDelivery(RAIL_A, [
				{ pack: "tls-baseline", remediation: RemediationMode.INFORM },
			]),
		);
		h.desired.seed(PROD, resolvedSet(PROD, [{ name: "api" }]));
		await observe(h.store, PROD, [ROUTE_10]);
		await observe(h.store, "prod-2", [ROUTE_13]);
		await h.service.tick(h.ctx());
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await observe(h.store, PROD, [ROUTE_13]);
		await h.service.tick(h.ctx());
		const replayed = createPostureService(h.deps);
		for (const id of [PROD, camp("prod-2")]) {
			expect(await replayed.compliance(id)).toEqual(
				await h.service.compliance(id),
			);
			expect(await replayed.remediations(id)).toEqual(
				await h.service.remediations(id),
			);
			expect(await replayed.conflicts(id)).toEqual(
				await h.service.conflicts(id),
			);
		}
		expect((await replayed.compliance(PROD)).map((r) => r.state)).toEqual([
			ComplianceState.NONCOMPLIANT,
			ComplianceState.COMPLIANT,
		]);
	});

	it("two replicas evaluating the same state record one fact (sequence-keyed idempotency)", async () => {
		const h = postureHarness();
		h.inventory.add(PROD);
		bindEnforced(h, RemediationMode.INFORM);
		await observe(h.store, PROD, [ROUTE_10]);
		const replica = createPostureService(h.deps);
		await Promise.all([h.service.tick(h.ctx()), replica.tick(h.ctx())]);
		expect(records(h, CD_EVENTS.ComplianceObserved)).toHaveLength(1);
		expect(records(h, CD_EVENTS.ComplianceChanged)).toHaveLength(1);
	});
});
