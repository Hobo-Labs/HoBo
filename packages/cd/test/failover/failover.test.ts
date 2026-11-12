// WP23 failover and rebalance acceptance (D23, I21; §10 rows "Provider region
// dies", "Failover when the database lives in the failing Camp", "Tainted
// Camp recovers").
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FailoverPolicyRecordSchema,
	FailoverState,
	FanoutStrategy,
	PromotionState,
	PurgeMode,
	ReconcileObservationRecordSchema,
	SignalSource,
	TaintEffect,
	type TaintRecord,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { createFailoverController, FAILOVER_METRIC, FAILOVER_REASON, noRunDue } from "../../src/failover/index.js";
import type { FailoverId } from "../../src/ports.js";
import { camp, decisionOf, FREIGHT, fanoutOf, healthy, MINUTE, T0 } from "../fanout/fakes.js";
import { drive, harness, startInput } from "../fanout/harness.js";
import { FakePipelines, FakePlacement, FakeRails, FakeTraffic, topologyOf } from "./fakes.js";

const EU_ONLY = { classifications: [], residency: [{ classifications: [], allowedJurisdictions: ["eu" as const] }] };

function noRun(key: string, atMs: number): TaintRecord {
	return create(TaintRecordSchema, {
		key,
		effect: TaintEffect.NO_RUN,
		source: SignalSource.STATION,
		reason: "region outage",
		addedBy: "service:station-eu",
		addedAt: new Date(atMs).toISOString(),
	});
}

async function setup(
	options: Readonly<{
		automatic?: boolean;
		maxConcurrent?: number;
		allowImmediatePurge?: boolean;
		purge?: PurgeMode;
		handoverOutputs?: string[];
		withContext?: boolean;
		ignoreResidency?: boolean;
	}> = {},
) {
	const h = harness();
	// Fleet: two serving Camps in the EU, spares in the US (sorted first) and the EU.
	const decision = decisionOf(2, 2, { prefix: "eu-" });
	h.inventory.add("eu-000", { regions: ["eu-west-1"], provider: "aws" });
	h.inventory.add("eu-001", { regions: ["eu-west-1"], provider: "aws" });
	h.inventory.add("a-us-spare", { regions: ["us-east-1"], provider: "azure" });
	h.inventory.add("eu-spare", { regions: ["eu-west-1"], provider: "azure" });
	h.inventory.add("eu-spare2", { regions: ["eu-west-1"], provider: "azure" });
	const started = await h.controller.start(startInput(decision, fanoutOf()), h.ctx);
	if (!started.ok) throw new Error("fan-out refused");
	await drive(h);
	const pipelines = new FakePipelines();
	pipelines.define("web", {
		fanout: fanoutOf({ strategy: FanoutStrategy.PROGRESSIVE, maxConcurrency: 1 }),
		failover: create(FailoverPolicyRecordSchema, {
			purge: options.purge ?? PurgeMode.UNSPECIFIED,
			handoverOutputs: options.handoverOutputs ?? [],
		}),
	});
	const placement = new FakePlacement(h.inventory);
	placement.ignoreResidency = options.ignoreResidency ?? false;
	const rails = new FakeRails({
		automatic: options.automatic ?? true,
		maxConcurrent: options.maxConcurrent ?? 1,
		allowImmediatePurge: options.allowImmediatePurge ?? false,
	});
	const traffic = new FakeTraffic();
	const failover = createFailoverController({
		store: h.store,
		tenant: h.ctx.tenant,
		now: h.time.now,
		pipelines,
		inventory: h.inventory,
		placement,
		fanout: h.controller,
		promotions: h.promotions,
		desired: h.desired,
		topology: topologyOf(h.inventory),
		rails,
		traffic,
		authorizer: h.authorizer,
		telemetry: h.telemetry,
		...(options.withContext === false ? {} : { placementContext: async () => ({ stationId: "station-eu", subject: EU_ONLY }) }),
	});
	return { h, failover, pipelines, placement, rails, traffic, fanoutId: started.value.fanoutId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function taint(s: Setup, campId: string): void {
	s.h.inventory.setStatus(campId, healthy(campId, [noRun("region-down", s.h.time.now())], false));
}

/** Tick the failover controller, settling replacement promotions with `outcome`. */
async function run(s: Setup, outcome: "pass" | "fail" | "hold" = "pass", ticks = 6): Promise<void> {
	for (let i = 0; i < ticks; i += 1) {
		await s.failover.tick(s.h.ctx);
		if (outcome !== "hold")
			for (const p of s.h.promotions.live("failover")) s.h.promotions.settle(p.targetCampIds[0] ?? "", outcome);
		s.h.time.advance(MINUTE);
	}
}

const departs = (s: Setup, campId: string) =>
	s.h.promotions.calls.filter((c) => c.request.intent === "depart" && c.request.targets[0] === campId);

describe("failover: provider region dies, Rail permits automation (§10 WP23 row 4)", () => {
	it("one governed failover: replacement passes residency, source kept until the replacement qualifies, traffic via Station cutover", async () => {
		const s = await setup();
		taint(s, "eu-000");
		await s.failover.tick(s.h.ctx);
		expect(await s.failover.list()).toEqual([]); // still within the 5-minute toleration
		s.h.time.advance(5 * MINUTE);
		await s.failover.tick(s.h.ctx);
		const [record] = await s.failover.list();
		// Admitted: the replacement promotion is rolling out (REPLACING → VERIFYING).
		expect([FailoverState.REPLACING, FailoverState.VERIFYING]).toContain(record?.state);
		expect(record?.toCampId).toBe("eu-spare"); // a-us-spare sorts first but fails residency
		expect(record?.freightId).toBe(FREIGHT);
		const promote = s.h.promotions.calls.find((c) => c.request.intent === "failover");
		expect(promote?.request).toMatchObject({ targets: ["eu-spare"], sourceCampId: "eu-000", pipeline: "web", node: "prod" });

		// GRACEFUL: nothing purged while the replacement is unqualified.
		await run(s, "hold", 3);
		expect(departs(s, "eu-000")).toEqual([]);
		expect(s.traffic.shifts).toEqual([]);
		expect((await s.failover.get(record?.failoverId as FailoverId))?.state).toBe(FailoverState.VERIFYING);

		await run(s, "pass", 3);
		const done = await s.failover.get(record?.failoverId as FailoverId);
		expect(done?.state).toBe(FailoverState.COMPLETED);
		expect(s.traffic.shifts.map((x) => x.campId)).toEqual(["eu-spare"]);
		expect(s.traffic.shifts[0]?.plan.backends.map((b) => b.id)).toEqual(["eu-spare"]);
		expect(departs(s, "eu-000")).toHaveLength(1);
		const promoteIndex = s.h.promotions.calls.findIndex((c) => c.request.intent === "failover");
		const departIndex = s.h.promotions.calls.findIndex((c) => c.request.intent === "depart");
		expect(departIndex).toBeGreaterThan(promoteIndex);

		// The node's effective decision now names the replacement (late entrant).
		const q = await s.h.controller.qualified({ pipeline: "web", node: "prod" });
		expect(q.qualifiedCampIds).toEqual(["eu-001", "eu-spare"]);
		expect(s.h.telemetry.count(FAILOVER_METRIC.completed)).toBe(1);
		expect(s.h.telemetry.count(FAILOVER_METRIC.stepError)).toBe(0);
	});

	it("never automatic unless the Rail allows it: PROPOSED until an authorized approval", async () => {
		const s = await setup({ automatic: false });
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await run(s, "pass", 3);
		const [record] = await s.failover.list();
		expect(record?.state).toBe(FailoverState.PROPOSED);
		expect(s.h.promotions.calls.some((c) => c.request.intent === "failover")).toBe(false);
		s.h.authorizer.proposalOnly.add("failover.approve");
		expect((await s.failover.approve(record?.failoverId as FailoverId, s.h.ctx)).ok).toBe(false);
		s.h.authorizer.proposalOnly.clear();
		expect((await s.failover.approve(record?.failoverId as FailoverId, s.h.ctx)).ok).toBe(true);
		await run(s, "pass", 4);
		expect((await s.failover.get(record?.failoverId as FailoverId))?.state).toBe(FailoverState.COMPLETED);
	});

	it("re-checks residency on the replacement even if placement offers a non-compliant Camp", async () => {
		const s = await setup({ ignoreResidency: true });
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await s.failover.tick(s.h.ctx);
		const [record] = await s.failover.list();
		expect(record?.state).toBe(FailoverState.REFUSED);
		expect(record?.reasons.at(-1)?.code).toBe(FAILOVER_REASON.residency);
		expect(s.h.promotions.calls.some((c) => c.request.intent === "failover")).toBe(false);
	});

	it("refuses without a placement context (fail closed)", async () => {
		const s = await setup({ withContext: false });
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await s.failover.tick(s.h.ctx);
		expect((await s.failover.list())[0]?.reasons.at(-1)?.code).toBe(FAILOVER_REASON.placementContextMissing);
	});
});

describe("failover: failover-unsafe (§10 WP23 row 5)", () => {
	it("a data resource in the source Camp refuses with failover-unsafe and names a Trails handover", async () => {
		const s = await setup();
		s.h.desired.place("eu-000", [
			{ name: "web", port: "hobo:http-service" },
			{ name: "orders-db", port: "database" },
		]);
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await s.failover.tick(s.h.ctx);
		const [record] = await s.failover.list();
		expect(record?.state).toBe(FailoverState.REFUSED);
		const why = record?.reasons.at(-1);
		expect(why?.code).toBe("failover-unsafe");
		expect(why?.message).toContain("orders-db");
		expect(why?.remediation).toContain("Trails replica handover");
		expect(s.h.promotions.calls.some((c) => c.request.intent === "failover" || c.request.intent === "depart")).toBe(false);
		expect(s.h.store.journal().some((e) => e.type === CD_EVENTS.FailoverRefused)).toBe(true);
	});

	it("an observed classified resource counts as data too", async () => {
		const s = await setup();
		s.h.desired.observations.set(
			"eu-000",
			create(ReconcileObservationRecordSchema, { campId: "eu-000", resources: [{ resource: "sessions", kind: "kv", classification: "pii" }] }),
		);
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await s.failover.tick(s.h.ctx);
		expect((await s.failover.list())[0]?.reasons.at(-1)?.code).toBe("failover-unsafe");
	});

	it("data unreachable from the replacement over a Junction is failover-unsafe", async () => {
		const s = await setup();
		const failover = createFailoverController({
			store: s.h.store,
			tenant: s.h.ctx.tenant,
			now: s.h.time.now,
			pipelines: s.pipelines,
			inventory: s.h.inventory,
			placement: s.placement,
			fanout: s.h.controller,
			promotions: s.h.promotions,
			desired: s.h.desired,
			topology: topologyOf(s.h.inventory),
			rails: s.rails,
			traffic: s.traffic,
			authorizer: s.h.authorizer,
			telemetry: s.h.telemetry,
			placementContext: async () => ({ stationId: "station-eu", subject: EU_ONLY }),
			junctions: async () => false,
		});
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await failover.tick(s.h.ctx);
		expect((await failover.list())[0]?.reasons.at(-1)?.code).toBe("failover-unsafe");
	});
});

describe("failover: no automatic failback (§10 WP23 row 6)", () => {
	it("a tainted Camp that recovers gets nothing back automatically", async () => {
		const s = await setup();
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await run(s, "pass", 6);
		expect((await s.failover.list())[0]?.state).toBe(FailoverState.COMPLETED);
		const calls = s.h.promotions.calls.length;
		s.h.inventory.setStatus("eu-000", healthy("eu-000"));
		await run(s, "pass", 6);
		await drive(s.h);
		expect(await s.failover.list()).toHaveLength(1);
		const later = s.h.promotions.calls.slice(calls);
		expect(later.some((c) => c.request.targets.includes(camp("eu-000")) && c.request.intent !== "depart")).toBe(false);
		expect((await s.h.controller.qualified({ pipeline: "web", node: "prod" })).qualifiedCampIds).not.toContain("eu-000");
	});
});

describe("failover: concurrency budget and lifecycle", () => {
	it("two concurrent failovers with max_concurrent 1 serialize", async () => {
		const s = await setup({ maxConcurrent: 1 });
		taint(s, "eu-000");
		taint(s, "eu-001");
		s.h.time.advance(6 * MINUTE);
		await s.failover.tick(s.h.ctx);
		const first = await s.failover.list();
		expect(first.filter((f) => f.state === FailoverState.PROPOSED)).toHaveLength(1);
		expect(first.filter((f) => f.state === FailoverState.VERIFYING)).toHaveLength(1);
		let peak = 0;
		for (let i = 0; i < 12; i += 1) {
			await s.failover.tick(s.h.ctx);
			const active = (await s.failover.list()).filter((f) =>
				[FailoverState.REPLACING, FailoverState.VERIFYING, FailoverState.SHIFTING, FailoverState.PURGING].includes(f.state),
			).length;
			peak = Math.max(peak, active);
			for (const p of s.h.promotions.live("failover")) s.h.promotions.settle(p.targetCampIds[0] ?? "", "pass");
			s.h.time.advance(MINUTE);
		}
		expect(peak).toBe(1);
		const done = await s.failover.list();
		expect(done.every((f) => f.state === FailoverState.COMPLETED)).toBe(true);
		expect(new Set(done.map((f) => f.toCampId))).toEqual(new Set(["eu-spare", "eu-spare2"]));
	});

	it("a replacement that fails verification abandons the failover and keeps the source", async () => {
		const s = await setup();
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await run(s, "fail", 4);
		const [record] = await s.failover.list();
		expect(record?.state).toBe(FailoverState.ABANDONED);
		expect(record?.reasons.at(-1)?.code).toBe(FAILOVER_REASON.replacementFailed);
		expect(departs(s, "eu-000")).toEqual([]);
	});

	it("GRACEFUL past the grace period keeps both Camps and escalates", async () => {
		const s = await setup();
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await run(s, "hold", 2);
		s.h.time.advance(31 * MINUTE);
		await run(s, "hold", 1);
		const [record] = await s.failover.list();
		expect(record?.state).toBe(FailoverState.ABANDONED);
		expect(record?.reasons.at(-1)?.code).toBe(FAILOVER_REASON.graceExpired);
		expect(departs(s, "eu-000")).toEqual([]);
	});

	it("IMMEDIATE without Rail allow_immediate_purge purges GRACEFUL; with it, purges at once", async () => {
		const s = await setup({ purge: PurgeMode.IMMEDIATE });
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await s.failover.tick(s.h.ctx);
		let [record] = await s.failover.list();
		expect(record?.purge).toBe(PurgeMode.GRACEFUL);
		expect(record?.reasons.at(-1)?.code).toBe(FAILOVER_REASON.immediatePurgeNotPermitted);
		expect(departs(s, "eu-000")).toEqual([]);

		const t = await setup({ purge: PurgeMode.IMMEDIATE, allowImmediatePurge: true });
		taint(t, "eu-000");
		t.h.time.advance(6 * MINUTE);
		await t.failover.tick(t.h.ctx);
		[record] = await t.failover.list();
		expect(record?.state).toBe(FailoverState.VERIFYING);
		expect(departs(t, "eu-000")).toHaveLength(1);
	});

	it("passes declared handover outputs from the source's last observation; refuses when one is missing", async () => {
		const s = await setup({ handoverOutputs: ["db_endpoint"] });
		s.h.desired.observations.set("eu-000", create(ReconcileObservationRecordSchema, { campId: "eu-000", handover: { db_endpoint: "db.internal:5432", other: "x" } }));
		taint(s, "eu-000");
		s.h.time.advance(6 * MINUTE);
		await s.failover.tick(s.h.ctx);
		expect((await s.failover.list())[0]?.handover).toEqual({ db_endpoint: "db.internal:5432" });

		const t = await setup({ handoverOutputs: ["db_endpoint"] });
		taint(t, "eu-000");
		t.h.time.advance(6 * MINUTE);
		await t.failover.tick(t.h.ctx);
		expect((await t.failover.list())[0]?.reasons.at(-1)?.code).toBe(FAILOVER_REASON.handoverMissing);
	});

	it("propose needs a NO_RUN taint and authorization; it is idempotent", async () => {
		const s = await setup({ automatic: false });
		const untainted = await s.failover.propose({ campId: camp("eu-000"), reason: "manual", idempotencyKey: "k1" }, s.h.ctx);
		expect(untainted.ok ? "" : untainted.reasons[0]?.code).toBe(FAILOVER_REASON.notTainted);
		taint(s, "eu-000");
		s.h.authorizer.deny.add("failover.propose");
		expect((await s.failover.propose({ campId: camp("eu-000"), reason: "manual", idempotencyKey: "k1" }, s.h.ctx)).ok).toBe(false);
		s.h.authorizer.deny.clear();
		const a = await s.failover.propose({ campId: camp("eu-000"), reason: "manual", idempotencyKey: "k1" }, s.h.ctx);
		const b = await s.failover.propose({ campId: camp("eu-000"), reason: "manual", idempotencyKey: "k1" }, s.h.ctx);
		expect(a.ok && b.ok && a.value[0]?.failoverId === b.value[0]?.failoverId).toBe(true);
		expect(await s.failover.list()).toHaveLength(1);
	});

	it("a matching toleration with toleration_ms 0 tolerates NO_RUN forever", () => {
		const t = noRun("region-down", T0);
		expect(noRunDue(t, [], T0 + 5 * MINUTE)).toBe(true);
		expect(noRunDue(t, [], T0 + 5 * MINUTE - 1)).toBe(false);
		expect(noRunDue(t, [{ key: "region-down", value: "", effect: TaintEffect.NO_RUN, tolerationMs: 0n, $typeName: "hobo.cd.v1.TolerationRecord" }], T0 + 1e9)).toBe(false);
		expect(noRunDue(t, [{ key: "region-down", value: "", effect: TaintEffect.NO_RUN, tolerationMs: BigInt(60 * MINUTE), $typeName: "hobo.cd.v1.TolerationRecord" }], T0 + 30 * MINUTE)).toBe(false);
	});
});

describe("rebalance", () => {
	it("is refused without authorization (denied or proposal-only)", async () => {
		const s = await setup();
		s.h.authorizer.deny.add("rebalance");
		const denied = await s.failover.rebalance({ pipeline: "web", node: "prod", reason: "spread", idempotencyKey: "r1" }, s.h.ctx);
		expect(denied.ok).toBe(false);
		s.h.authorizer.deny.clear();
		s.h.authorizer.proposalOnly.add("rebalance");
		const proposal = await s.failover.rebalance({ pipeline: "web", node: "prod", reason: "spread", idempotencyKey: "r1" }, s.h.ctx);
		expect(proposal.ok ? "" : proposal.reasons[0]?.code).toBe("proposal-only");
		expect(s.h.store.journal().some((e) => e.type === CD_EVENTS.RebalanceRequested)).toBe(false);
	});

	it("records the moves and runs them as GRACEFUL moves under the node's fan-out limit", async () => {
		const s = await setup();
		// Make the current members ineligible for the re-decision so both move.
		s.h.inventory.setStatus("eu-000", healthy("eu-000", [create(TaintRecordSchema, { key: "drain", effect: TaintEffect.NO_PLACE })]));
		s.h.inventory.setStatus("eu-001", healthy("eu-001", [create(TaintRecordSchema, { key: "drain", effect: TaintEffect.NO_PLACE })]));
		s.h.inventory.camps.delete("a-us-spare");
		const result = await s.failover.rebalance({ pipeline: "web", node: "prod", reason: "spread", idempotencyKey: "r1" }, s.h.ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.moves.map((m) => [m.fromCampId, m.toCampId])).toEqual([
			["eu-000", "eu-spare"],
			["eu-001", "eu-spare2"],
		]);
		let peak = 0;
		for (let i = 0; i < 12; i += 1) {
			await s.failover.tick(s.h.ctx);
			const moves = await s.failover.list();
			expect(moves.every((m) => m.purge === PurgeMode.GRACEFUL)).toBe(true);
			peak = Math.max(peak, moves.filter((m) => m.state > FailoverState.PROPOSED && m.state < FailoverState.COMPLETED).length);
			for (const p of s.h.promotions.live("failover")) s.h.promotions.settle(p.targetCampIds[0] ?? "", "pass");
			s.h.time.advance(MINUTE);
		}
		expect(peak).toBe(1); // node fan-out max_concurrency 1
		expect((await s.failover.list()).every((m) => m.state === FailoverState.COMPLETED)).toBe(true);
		expect(s.h.promotions.byId.size).toBeGreaterThan(0);
		expect([...s.h.promotions.byId.values()].filter((p) => p.state === PromotionState.PROMOTED).length).toBeGreaterThan(0);
		const again = await s.failover.rebalance({ pipeline: "web", node: "prod", reason: "spread", idempotencyKey: "r1" }, s.h.ctx);
		expect(again.ok && again.value.rebalanceId).toBe(result.value.rebalanceId);
	});
});
