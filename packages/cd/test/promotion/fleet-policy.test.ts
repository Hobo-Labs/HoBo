// WP6 rollback, Trails, previews and the fleet-and-policy bullets (D11, D12,
// D20–D25): intents, Rail subject, fan-out aggregate.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FanoutStatusRecordSchema,
	FreightSubject,
	PlacementDecisionRecordSchema,
	PolicyMode,
	PromotionState,
	RailDeliveryRecordSchema,
	SetOrigin,
} from "../../src/_generated/cd_pb.js";
import { createFanoutAggregateGate } from "../../src/adapters/gatekeeper.js";
import { createTrailsMigrations, type DataMigrationRun, MIGRATION_LABEL } from "../../src/adapters/trails.js";
import { CD_EVENTS, FANOUT_BUDGET_EXCEEDED, SHADOW_REQUIRED } from "../../src/events.js";
import { PROMOTION_REASON, previewSourceOf } from "../../src/promotion/index.js";
import type { CampTopology, DeltaIntent, FanoutController, FanoutId, PlacementEngine, RailDeliveryReader, TopologyReader } from "../../src/ports.js";
import { pipelineNode, RecordingTelemetry, resolvedFor } from "./doubles.js";
import { harness } from "./harness.js";
import { AGENT, camp, DAY, fid, HOUR, MINUTE } from "./store.js";

function trailsDouble() {
	const runs: { migrationId: string; campId: string; phase: string }[] = [];
	const trails = createTrailsMigrations({
		async execute(input): Promise<DataMigrationRun> {
			runs.push(input);
			return input.phase === "expand"
				? { status: "contract-blocked", dualWindowOpen: true, blockedReasons: ["legacy consumer"] }
				: { status: "completed", dualWindowOpen: false, blockedReasons: [] };
		},
	});
	return { trails, runs };
}

describe("rollback (D12, I7)", () => {
	it("is a Delta to the predecessor Set through the same gate", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		const seed = h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "p" }, h.ctx());
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f1");
		const rolled = await h.service.rollback({ campId: camp("dev-1"), reason: "error spike", idempotencyKey: "rb" }, h.ctx());
		expect(rolled.ok).toBe(true);
		if (!rolled.ok) return;
		expect(rolled.value.state).toBe(PromotionState.ROLLED_BACK);
		expect(rolled.value.freightId).toBe("f0");
		const current = await h.desired.current(camp("dev-1"));
		expect(current?.origin).toBe(SetOrigin.ROLLBACK);
		// The predecessor plan, re-sealed by the rollback's own gate decision.
		expect(current?.planHash).toBe(seed.planHash);
		const rollbackGate = h.gate.calls.find((c) => c.intent === "rollback");
		expect(rollbackGate?.delta.baseSetId).not.toBe("");
		expect(current?.gateDecisionId).toBe(`gate-${h.gate.calls.length}`);
		// Idempotent.
		const again = await h.service.rollback({ campId: camp("dev-1"), reason: "error spike", idempotencyKey: "rb" }, h.ctx());
		expect(again.ok && again.value.promotionId).toBe(rolled.value.promotionId);
		expect(h.store.events(CD_EVENTS.EnvPromoteRolledBack)).toHaveLength(1);
	});

	it("is refused when the gate denies it, and for a proposal-only principal", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "p" }, h.ctx());
		const agent = await h.service.rollback({ campId: camp("dev-1"), reason: "x", idempotencyKey: "a" }, h.ctx(AGENT));
		expect(agent.ok).toBe(false);
		h.gate.denyCamps.add("dev-1");
		const denied = await h.service.rollback({ campId: camp("dev-1"), reason: "x", idempotencyKey: "b" }, h.ctx());
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.reasons[0]?.code).toBe(PROMOTION_REASON.gateDenied);
	});

	it("refuses without a predecessor, naming what to do", async () => {
		const h = harness();
		h.freight.add("f1");
		await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "p" }, h.ctx());
		const result = await h.service.rollback({ campId: camp("dev-1"), reason: "x", idempotencyKey: "r" }, h.ctx());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons[0]?.code).toBe(PROMOTION_REASON.rollbackNoPredecessor);
	});
});

describe("Trails sequencing (D11)", () => {
	it("runs expand before apply and contract only after soak", async () => {
		const { trails, runs } = trailsDouble();
		const h = harness({ trails });
		h.pipelines.define("shop", [pipelineNode("dev", { campIds: ["dev-1"], requiredSoakMs: BigInt(HOUR) })]);
		h.freight.add("f1", { labels: { [MIGRATION_LABEL]: "orders-v2" } });
		h.pipelines.makeAvailable("shop", "dev", "f1");
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "m", pipeline: "shop", node: "dev" }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.PROMOTED);
		expect(runs.map((r) => r.phase)).toEqual(["expand"]);
		h.clock.advance(30 * MINUTE);
		await h.service.tick(h.ctx());
		expect(runs.map((r) => r.phase)).toEqual(["expand"]);
		h.clock.advance(31 * MINUTE);
		await h.service.tick(h.ctx());
		expect(runs.map((r) => r.phase)).toEqual(["expand", "contract"]);
	});

	it("refuses rollback past a completed contract, naming the compensating expand (§10)", async () => {
		const { trails } = trailsDouble();
		const h = harness({ trails });
		h.freight.add("f0");
		h.freight.add("f1", { labels: { [MIGRATION_LABEL]: "orders-v2" } });
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "m" }, h.ctx());
		await h.service.tick(h.ctx());
		const result = await h.service.rollback({ campId: camp("dev-1"), reason: "regret", idempotencyKey: "rb" }, h.ctx());
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reasons[0]?.code).toBe(PROMOTION_REASON.rollbackPastContract);
			expect(result.reasons[0]?.remediation).toMatch(/compensating Trails expand for migration orders-v2/);
		}
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f1");
	});

	it("refuses migration Freight when no Trails sequencer is composed (fail closed)", async () => {
		const h = harness();
		h.freight.add("f1", { labels: { [MIGRATION_LABEL]: "orders-v2" } });
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "m" }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.REJECTED);
		if (result.ok) expect(result.value.reasons[0]?.code).toBe(PROMOTION_REASON.trailsUnavailable);
		expect(h.desired.applied).toHaveLength(0);
	});
});

describe("previews (env.Cloned / env.Expired)", () => {
	it("a preview tears down at TTL", async () => {
		const h = harness();
		h.freight.add("f1");
		h.desired.seed("dev-1", "f1", resolvedFor("dev-1", "alpha", "f1"));
		const created = await h.service.createPreview({ freightId: fid("f1"), sourceCampId: camp("dev-1"), ttlMs: HOUR, idempotencyKey: "pr-42" }, h.ctx());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const previewCamp = camp(created.value.campId);
		expect(previewSourceOf(previewCamp)).toBe("dev-1");
		expect((await h.desired.current(previewCamp))?.origin).toBe(SetOrigin.PREVIEW);
		expect(h.store.events(CD_EVENTS.EnvCloned)).toHaveLength(1);
		expect(await h.service.listPreviews()).toHaveLength(1);
		expect(await h.service.expirePreviews(h.ctx())).toEqual([]);
		h.clock.advance(HOUR);
		const expired = await h.service.expirePreviews(h.ctx());
		expect(expired.map((p) => p.campId)).toEqual([previewCamp]);
		expect((await h.desired.current(previewCamp))?.origin).toBe(SetOrigin.TEARDOWN);
		expect(h.gate.calls.at(-1)?.intent).toBe("down");
		expect(h.store.events(CD_EVENTS.EnvExpired)).toHaveLength(1);
		expect(await h.service.listPreviews()).toHaveLength(0);
		expect(await h.service.expirePreviews(h.ctx())).toEqual([]);
	});

	it("refuses a non-positive TTL", async () => {
		const h = harness();
		h.freight.add("f1");
		const result = await h.service.createPreview({ freightId: fid("f1"), sourceCampId: camp("dev-1"), ttlMs: 0, idempotencyKey: "x" }, h.ctx());
		expect(result.ok).toBe(false);
	});
});

describe("fleet and policy (D20–D25)", () => {
	it.each<[DeltaIntent, SetOrigin]>([
		["topology", SetOrigin.TOPOLOGY],
		["failover", SetOrigin.FAILOVER],
		["depart", SetOrigin.DEPARTURE],
		["posture-remediate", SetOrigin.POSTURE_REMEDIATION],
		["config", SetOrigin.CONFIG],
	])("intent %s applies a Set with origin %s", async (intent, origin) => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: intent, intent }, h.ctx());
		expect(result.ok && result.value.state).toBe(PromotionState.PROMOTED);
		expect((await h.desired.current(camp("dev-1")))?.origin).toBe(origin);
		expect(h.resolver.calls.at(-1)?.intent).toBe(intent);
		expect(h.gate.calls.at(-1)?.intent).toBe(intent);
	});

	it("subject RAIL writes the binding through CampPolicy, not a Set, and rollback restores it", async () => {
		const h = harness();
		h.pipelines.define(
			"rail",
			[
				pipelineNode("inform", { campIds: ["dev-1"], policyMode: PolicyMode.INFORM }),
				pipelineNode("enforce", { campIds: ["dev-1"], fromNodes: ["inform"], policyMode: PolicyMode.ENFORCE }),
			],
			FreightSubject.RAIL,
		);
		h.freight.add("r1", { subject: FreightSubject.RAIL });
		h.pipelines.makeAvailable("rail", "inform", "r1");
		const inform = await h.service.promote({ freightId: fid("r1"), targets: [camp("dev-1")], idempotencyKey: "i", pipeline: "rail", node: "inform" }, h.ctx());
		expect(inform.ok && inform.value.state).toBe(PromotionState.PROMOTED);
		expect(h.desired.applied).toHaveLength(0);
		expect(h.rollouts.plans).toHaveLength(0);
		const digest = h.freight.records.get("r1")?.manifest?.declarationHash;
		expect((await h.campPolicy.binding(camp("dev-1")))?.candidateRailDigest).toBe(digest);
		expect(h.authorizer.calls[0]?.action).toBe("rail.promote");
		// ENFORCE without a qualified INFORM upstream: shadow-required (I23).
		const early = await h.service.promote({ freightId: fid("r1"), targets: [camp("dev-1")], idempotencyKey: "e0", pipeline: "rail", node: "enforce" }, h.ctx());
		expect(early.ok).toBe(false);
		if (!early.ok) expect(early.reasons[0]?.code).toBe(SHADOW_REQUIRED);
		h.pipelines.makeAvailable("rail", "enforce", "r1");
		const enforce = await h.service.promote({ freightId: fid("r1"), targets: [camp("dev-1")], idempotencyKey: "e", pipeline: "rail", node: "enforce" }, h.ctx());
		expect(enforce.ok && enforce.value.state).toBe(PromotionState.PROMOTED);
		expect((await h.campPolicy.binding(camp("dev-1")))?.enforcedRailDigest).toBe(digest);
		const rolled = await h.service.rollback({ campId: camp("dev-1"), reason: "too strict", idempotencyKey: "rb" }, h.ctx());
		expect(rolled.ok).toBe(true);
		expect((await h.campPolicy.binding(camp("dev-1")))?.enforcedRailDigest).toBe("");
	});

	it("an aggregate over budget is refused before any Camp starts (§10)", async () => {
		const decision = create(PlacementDecisionRecordSchema, {
			decisionId: "dec-1",
			groups: [{ name: "all", index: 0, campIds: ["c-1", "c-2", "c-3"] }],
		});
		const fanout: Pick<FanoutController, "get"> = {
			async get(id) {
				return create(FanoutStatusRecordSchema, { fanoutId: id, decisionId: "dec-1" });
			},
		};
		const placement: Pick<PlacementEngine, "decision"> = {
			async decision(id) {
				return id === "dec-1" ? decision : undefined;
			},
		};
		const topology: TopologyReader = {
			async camps() {
				return [];
			},
			async camp(id): Promise<CampTopology> {
				return { campId: id, yardId: "y", stationId: "st-1", provider: "alpha", regions: ["us-east-1"], envType: "prod", labels: {}, management: 1 };
			},
		};
		const rails: RailDeliveryReader = {
			async forStation() {
				return create(RailDeliveryRecordSchema, { maxFanoutCamps: 10 });
			},
			async forCamp() {
				return undefined;
			},
		};
		const aggregate = createFanoutAggregateGate({
			tenant: "acme",
			fanout: fanout as FanoutController,
			placement: placement as PlacementEngine,
			topology,
			rails,
			quote: async () => 40,
			budget: async () => ({ limit: 100, used: 0 }),
			telemetry: new RecordingTelemetry(),
		});
		const h = harness({ aggregate });
		h.freight.add("f1");
		const result = await h.service.promote(
			// SAFETY: test fan-out id literal.
			{ freightId: fid("f1"), targets: [camp("c-1")], idempotencyKey: "fo", fanoutId: "fo-1" as FanoutId },
			h.ctx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reasons[0]?.code).toBe(FANOUT_BUDGET_EXCEEDED);
			expect(result.reasons[0]?.message).toMatch(/costs 120/);
		}
		expect(h.store.events(CD_EVENTS.EnvPromoteRequested)).toHaveLength(0);
		expect(h.resolver.calls).toHaveLength(0);
	});

	it("a fan-out request without the aggregate gate composed is refused (fail closed)", async () => {
		const h = harness();
		h.freight.add("f1");
		// SAFETY: test fan-out id literal.
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("c-1")], idempotencyKey: "fo", fanoutId: "fo-1" as FanoutId }, h.ctx());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons[0]?.code).toBe(PROMOTION_REASON.fanoutAggregateUnavailable);
	});

	it("an expired hotfix approval does not cover lineage", async () => {
		const h = harness();
		h.pipelines.define("shop", [pipelineNode("prod", { campIds: ["prod-1"], fromNodes: ["staging"] })]);
		h.freight.add("f1");
		h.freight.approveFor("f1", "prod-1", h.clock.now() - DAY);
		const result = await h.service.promote({ freightId: fid("f1"), targets: [camp("prod-1")], idempotencyKey: "k", pipeline: "shop", node: "prod" }, h.ctx());
		expect(result.ok).toBe(false);
	});
});
