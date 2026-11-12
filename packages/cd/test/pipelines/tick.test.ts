// PipelineController.tick (D4, D10, D21, I12, I17): auto-promotion with
// idempotency keys, availability facts, fan-outs for placed nodes, MATCH_NODE
// for late entrants, and windows read at request time.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AutoPromotion,
	ChangeWindowRecordSchema,
	DepartureAction,
	FanoutState,
	FanoutStrategy,
	PromotionState,
	WindowKind,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS } from "../../src/events.js";
import { PIPELINE_METRIC, pipelineKey } from "../../src/pipelines/index.js";
import { createChangeWindows } from "../../src/windows/index.js";
import { decisionOf } from "./doubles.js";
import { HOUR, MemoryEventStore, MINUTE, RecordingAuthorizer, T0, TENANT } from "./fakes.js";
import { harness, node, pipeline } from "./harness.js";

async function listPipeline(h: ReturnType<typeof harness>, prodAuto = AutoPromotion.NEWEST, windows: string[] = []) {
	await h.source("images");
	const applied = await h.controller.apply(
		pipeline("shop", [
			node("dev", { campIds: ["dev-1"], fromSources: ["images"], autoPromotion: AutoPromotion.NEWEST }),
			node("prod", { campIds: ["prod-1", "prod-2"], fromNodes: ["dev"], autoPromotion: prodAuto, windows }),
		]),
		h.ctx,
	);
	expect(applied.ok).toBe(true);
}

describe("tick: list nodes", () => {
	it("NEWEST requests the newest available Freight once, keyed pipeline:<p>:<node>:<freight> (I12)", async () => {
		const h = harness();
		await listPipeline(h);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		await h.controller.tick(h.ctx);
		await h.controller.tick(h.ctx);
		await h.build().tick(h.ctx);
		expect(h.promotions.requests.map((r) => [r.idempotencyKey, r.targets, r.pipeline, r.node, r.intent])).toEqual([
			[pipelineKey("shop", "dev", "f2"), ["dev-1"], "shop", "dev", "promote"],
		]);
		expect(h.telemetry.named(PIPELINE_METRIC.promotionRequested)).toHaveLength(1);
	});

	it("records pipeline.FreightAvailable once per node and Freight", async () => {
		const h = harness();
		await listPipeline(h);
		h.ledger.add("f1", T0 - HOUR);
		await h.controller.tick(h.ctx);
		await h.controller.tick(h.ctx);
		const facts = h.store.events(CD_EVENTS.PipelineFreightAvailable);
		expect(facts).toHaveLength(1);
		expect(facts[0]?.streamId).toBe("cd-pipeline-shop");
		expect(facts[0]?.data).toMatchObject({ pipeline: "shop", node: "dev", freightId: "f1", via: ["images"] });
	});

	it("I16: downstream waits for upstream qualification", async () => {
		const h = harness();
		await listPipeline(h);
		h.ledger.add("f1", T0 - HOUR);
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => r.node)).toEqual(["dev"]);
		h.ledger.qualify("f1", "dev-1", "shop", "dev", T0);
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => [r.node, r.targets])).toEqual([
			["dev", ["dev-1"]],
			["prod", ["prod-1", "prod-2"]],
		]);
	});

	it("leaves DISABLED nodes and preview nodes to explicit commands", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", { campIds: ["dev-1"], fromSources: ["images"], autoPromotion: AutoPromotion.DISABLED }),
				node("pr", { campIds: ["preview-1"], fromNodes: ["dev"], previewTtlMs: 3_600_000n, autoPromotion: AutoPromotion.NEWEST }),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR);
		h.ledger.qualify("f1", "dev-1", "shop", "dev", T0);
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests).toEqual([]);
	});

	it("an approval-only Freight is requested for the approved Camp alone", async () => {
		const h = harness();
		await listPipeline(h);
		h.ledger.add("hotfix", T0 - HOUR);
		h.ledger.approveFor("hotfix", "prod-2", T0 + HOUR);
		await h.controller.tick(h.ctx);
		const prod = h.promotions.requests.filter((r) => r.node === "prod");
		expect(prod.map((r) => [r.targets, r.idempotencyKey])).toEqual([[["prod-2"], `${pipelineKey("shop", "prod", "hotfix")}:approval:prod-2`]]);
	});

	it("Kargo parity: MATCH_UPSTREAM follows what the single upstream node runs", async () => {
		const h = harness();
		await listPipeline(h, AutoPromotion.MATCH_UPSTREAM);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		for (const f of ["f1", "f2"]) h.ledger.qualify(f, "dev-1", "shop", "dev", T0 - MINUTE);
		await h.promoted("f2", ["dev-1"], "shop", "dev");
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.filter((r) => r.node === "prod").map((r) => r.freightId)).toEqual(["f1"]);
	});

	it("a freeze beginning mid-tick blocks the request", async () => {
		const start = Date.parse("2026-11-12T11:59:00Z");
		const store = new MemoryEventStore(() => start);
		const windows = createChangeWindows({ store, tenant: TENANT, now: () => start, authorizer: new RecordingAuthorizer() });
		await windows.define(create(ChangeWindowRecordSchema, { name: "noon", kind: WindowKind.FREEZE, timezone: "UTC", startsAt: "2026-11-12T12:00:00Z", endsAt: "2026-11-12T13:00:00Z", rollbackAllowed: true }), { tenant: TENANT, principal: { kind: "user", id: "ops" }, now: () => start });
		const h = harness({ windows, start });
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("a", { campIds: ["dev-1"], fromSources: ["images"], autoPromotion: AutoPromotion.NEWEST, windows: ["noon"] }),
				node("b", { campIds: ["staging-1"], fromSources: ["images"], autoPromotion: AutoPromotion.NEWEST, windows: ["noon"] }),
			]),
			h.ctx,
		);
		h.ledger.add("f1", start - HOUR);
		// The first request takes the clock past noon: the freeze is now in force.
		h.promotions.onPromote = () => h.c.set(Date.parse("2026-11-12T12:00:30Z"));
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => r.node)).toEqual(["a"]);
		expect(h.telemetry.named(PIPELINE_METRIC.blocked).map((p) => p.attributes.reason)).toContain("window-closed");
		h.c.set(Date.parse("2026-11-12T13:00:00Z"));
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => r.node)).toEqual(["a", "b"]);
	});
});

describe("tick: placed nodes (D21)", () => {
	async function placedPipeline(h: ReturnType<typeof harness>, auto: AutoPromotion) {
		await h.source("images");
		h.placement.add("fleet");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("fleet", {
					placement: "fleet",
					fromSources: ["images"],
					autoPromotion: auto,
					fanout: { strategy: FanoutStrategy.PROGRESSIVE, maxConcurrency: 5 },
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
	}

	it("tick starts one fan-out through FanoutController for a placed node", async () => {
		const h = harness();
		await placedPipeline(h, AutoPromotion.NEWEST);
		h.ledger.add("f1", T0 - HOUR);
		await h.controller.tick(h.ctx);
		await h.controller.tick(h.ctx);
		expect(h.placement.decisions).toHaveLength(1);
		expect(h.fanout.started).toHaveLength(1);
		expect(h.fanout.started[0]).toMatchObject({
			pipeline: "shop",
			node: "fleet",
			freightId: "f1",
			departure: DepartureAction.ORPHAN_DATA,
			idempotencyKey: pipelineKey("shop", "fleet", "f1"),
			decision: { decisionId: "decision-1" },
			fanout: { strategy: FanoutStrategy.PROGRESSIVE, maxConcurrency: 5 },
		});
		expect(h.promotions.requests).toEqual([]);
	});

	it("applies fan-out defaults when the node declares none", async () => {
		const h = harness();
		await h.source("images");
		h.placement.add("fleet");
		await h.controller.apply(pipeline("shop", [node("fleet", { placement: "fleet", fromSources: ["images"], autoPromotion: AutoPromotion.NEWEST })]), h.ctx);
		h.ledger.add("f1", T0 - HOUR);
		await h.controller.tick(h.ctx);
		expect(h.fanout.started[0]?.fanout).toMatchObject({
			strategy: FanoutStrategy.PROGRESSIVE_PER_GROUP,
			maxFailuresPercent: CD_DEFAULTS.fanoutMaxFailuresPercent,
			minSuccessMs: BigInt(CD_DEFAULTS.fanoutMinSuccessMs),
			progressDeadlineMs: BigInt(CD_DEFAULTS.fanoutProgressDeadlineMs),
			rollbackOnHalt: true,
		});
	});

	it("does not start a fan-out without placement context (fail closed)", async () => {
		const h = harness({ placementContext: false });
		await placedPipeline(h, AutoPromotion.NEWEST);
		h.ledger.add("f1", T0 - HOUR);
		await h.controller.tick(h.ctx);
		expect(h.fanout.started).toEqual([]);
		expect(h.telemetry.named(PIPELINE_METRIC.blocked).map((p) => p.attributes.reason)).toContain("placement-context-missing");
	});

	it("tick requests MATCH_NODE promotions for Camps entering a node", async () => {
		const h = harness();
		await placedPipeline(h, AutoPromotion.MATCH_NODE);
		h.ledger.add("stable", T0 - 2 * HOUR);
		// fleet-4 was deferred; fleet-3 already runs stable; fleet-2 has a promotion in flight.
		h.fanout.setQualified("shop", "fleet", decisionOf(["fleet-1", "fleet-2", "fleet-3", "fleet-4"], []), ["fleet-1"], "stable");
		h.promotions.arrange("stable", "fleet-3", PromotionState.PROMOTED);
		h.promotions.arrange("other", "fleet-2", PromotionState.APPLYING);
		await h.controller.tick(h.ctx);
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => [r.freightId, r.targets, r.idempotencyKey])).toEqual([
			["stable", ["fleet-4"], `${pipelineKey("shop", "fleet", "stable")}:match:fleet-4`],
		]);
		expect(h.fanout.started).toEqual([]);
	});

	it("MATCH_NODE never selects in-flight Freight", async () => {
		const h = harness();
		await placedPipeline(h, AutoPromotion.MATCH_NODE);
		h.ledger.add("stable", T0 - 2 * HOUR);
		h.ledger.add("rolling", T0 - HOUR);
		h.fanout.setQualified("shop", "fleet", decisionOf(["fleet-1", "fleet-2", "fleet-3"], []), ["fleet-1"], "stable");
		// A fan-out of newer Freight is running and owns fleet-2.
		h.fanout.statuses.push(create(
			(await import("../../src/_generated/cd_pb.js")).FanoutStatusRecordSchema,
			{ fanoutId: "running", pipeline: "shop", node: "fleet", freightId: "rolling", state: FanoutState.RUNNING, inFlight: ["fleet-2"] },
		));
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => [r.freightId, r.targets])).toEqual([["stable", ["fleet-3"]]]);
		// No stable Freight recorded: nothing is requested.
		const fresh = harness();
		await placedPipeline(fresh, AutoPromotion.MATCH_NODE);
		fresh.ledger.add("rolling", T0 - HOUR);
		fresh.fanout.setQualified("shop", "fleet", decisionOf(["fleet-1"], []), []);
		await fresh.controller.tick(fresh.ctx);
		expect(fresh.promotions.requests).toEqual([]);
	});

	it("MATCH_NODE stops while a fan-out of the node is halted", async () => {
		const h = harness();
		await placedPipeline(h, AutoPromotion.MATCH_NODE);
		h.ledger.add("stable", T0 - 2 * HOUR);
		h.fanout.setQualified("shop", "fleet", decisionOf(["fleet-1", "fleet-2"], []), ["fleet-1"], "stable");
		h.fanout.statuses.push(create(
			(await import("../../src/_generated/cd_pb.js")).FanoutStatusRecordSchema,
			{ fanoutId: "halted", pipeline: "shop", node: "fleet", freightId: "next", state: FanoutState.HALTED },
		));
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests).toEqual([]);
	});
});
