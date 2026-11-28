import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AutoPromotion,
	DepartureAction,
	FanoutRecordSchema,
	FanoutState,
	FanoutStatusRecordSchema,
	FreightOrigin,
	PlacementDecisionRecordSchema,
	PromotionRecordSchema,
	PromotionState,
	ReasonRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import { haltedBody, startedBody, statusBody } from "../../src/fanout/facts.js";
import { PIPELINE_METRIC, pipelineKey } from "../../src/pipelines/index.js";
import { camp, fid, HOUR, MINUTE, T0 } from "./fakes.js";
import { harness, node, pipeline } from "./harness.js";

async function seedManualFanout(
	h: ReturnType<typeof harness>,
	fanoutId: string,
	freightId: string,
): Promise<void> {
	await h.store.seed(
		CD_STREAMS.fanout(fanoutId),
		CD_EVENTS.FanoutStarted,
		startedBody({
			fanoutId,
			pipeline: "shop",
			node: "dev",
			freightId,
			decision: create(PlacementDecisionRecordSchema),
			fanout: create(FanoutRecordSchema),
			departure: DepartureAction.UNSPECIFIED,
			windows: [],
			idempotencyKey: fanoutId,
			departing: [],
			atMs: T0,
		}),
		undefined,
		{ promotionRequestMode: "manual" },
	);
}

async function seedFanoutCompleted(
	h: ReturnType<typeof harness>,
	fanoutId: string,
	freightId: string,
): Promise<void> {
	await h.store.seed(
		CD_STREAMS.fanout(fanoutId),
		CD_EVENTS.FanoutCompleted,
		statusBody({
			atMs: T0,
			campIds: [],
			reasons: [],
			status: create(FanoutStatusRecordSchema, {
				fanoutId,
				pipeline: "shop",
				node: "dev",
				freightId,
				state: FanoutState.COMPLETED,
			}),
		}),
	);
}

describe("auto-promotion holds", () => {
	it("does not retain a manual hold after its promotion has already completed", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "manual-f1",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
	});

	it("does not turn an automatic request into a manual hold when newer Freight arrives", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR);
		await h.controller.tick(h.ctx);
		h.c.advance(MINUTE);
		h.ledger.add("f2", h.c.now());
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
	});

	it("recognizes pre-upgrade automatic requests during replay", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		await h.store.seed(
			CD_STREAMS.promotion("legacy-auto"),
			CD_EVENTS.EnvPromoteRequested,
			toJson(
				PromotionRecordSchema,
				create(PromotionRecordSchema, {
					promotionId: "legacy-auto",
					freightId: "f1",
					targetCampIds: ["dev-1"],
					pipeline: "shop",
					node: "dev",
					state: PromotionState.QUEUED,
					idempotencyKey: pipelineKey("shop", "dev", "f1"),
				}),
			),
		);
		const replayed = h.build();
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
	});

	it("recognizes pre-upgrade failover requests as automatic during replay", async () => {
		for (const idempotencyKey of [
			"failover:fo-1:promote",
			"failover:fo-1:purge",
		]) {
			const h = harness();
			await h.source("images");
			await h.controller.apply(
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						fromSources: ["images"],
						autoPromotion: AutoPromotion.NEWEST,
					}),
				]),
				h.ctx,
			);
			h.ledger.add("f1", T0 - 2 * HOUR);
			h.ledger.add("f2", T0 - HOUR);
			await h.store.seed(
				CD_STREAMS.promotion(`legacy-${idempotencyKey}`),
				CD_EVENTS.EnvPromoteRequested,
				toJson(
					PromotionRecordSchema,
					create(PromotionRecordSchema, {
						promotionId: `legacy-${idempotencyKey}`,
						freightId: "f1",
						targetCampIds: ["dev-1"],
						pipeline: "shop",
						node: "dev",
						state: PromotionState.QUEUED,
						idempotencyKey,
					}),
				),
			);
			const replayed = h.build();
			await replayed.tick(h.ctx);
			expect(await replayed.autoPromotionHolds()).toEqual([]);
			expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
		}
	});

	it("keeps a manual hold until every target Camp has promoted, including after replay", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1", "staging-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1"), camp("staging-1")],
				idempotencyKey: "manual-f1-all-camps",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.controller.tick(h.ctx);
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		const replayed = h.build();
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toHaveLength(1);
		expect(h.promotions.requests.map((r) => r.freightId)).not.toContain("f2");
		await h.promoted("f1", ["staging-1"], "shop", "dev");
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
	});

	it("retains a manual hold even if its key resembles an automatic key", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: pipelineKey("shop", "dev", "f1"),
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toMatchObject([
			{ pipeline: "shop", node: "dev", freightId: "f1" },
		]);
	});

	it("holds a non-candidate manual request for a list MATCH_NODE policy", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.MATCH_NODE,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		h.ledger.qualify("f2", "dev-1", "shop", "dev", T0 - MINUTE);
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "manual-match-node",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toMatchObject([
			{ pipeline: "shop", node: "dev", freightId: "f1" },
		]);
	});

	it("retains a manual fan-out hold until the fan-out completes, including after replay", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		const fanoutId = "manual-fanout";
		await h.store.seed(
			CD_STREAMS.fanout(fanoutId),
			CD_EVENTS.FanoutStarted,
			startedBody({
				fanoutId,
				pipeline: "shop",
				node: "dev",
				freightId: "f1",
				decision: create(PlacementDecisionRecordSchema),
				fanout: create(FanoutRecordSchema),
				departure: DepartureAction.UNSPECIFIED,
				windows: [],
				idempotencyKey: "manual-fanout-key",
				departing: [],
				atMs: T0,
			}),
			undefined,
			{ promotionRequestMode: "manual" },
		);
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		const replayed = h.build();
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toHaveLength(1);
		await h.store.seed(
			CD_STREAMS.fanout(fanoutId),
			CD_EVENTS.FanoutCompleted,
			statusBody({
				atMs: T0,
				campIds: [],
				reasons: [],
				status: create(FanoutStatusRecordSchema, {
					fanoutId,
					pipeline: "shop",
					node: "dev",
					freightId: "f1",
					state: FanoutState.COMPLETED,
				}),
			}),
		);
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
	});

	it("clears a manual fan-out hold when the fan-out halts, rolls back, or is superseded, including after replay", async () => {
		const terminals = [
			{
				type: CD_EVENTS.FanoutHalted,
				state: FanoutState.HALTED,
			},
			{
				type: CD_EVENTS.FanoutRolledBack,
				state: FanoutState.ROLLED_BACK,
			},
			{
				type: CD_EVENTS.FanoutCompleted,
				state: FanoutState.SUPERSEDED,
			},
		] as const;
		for (const terminal of terminals) {
			const h = harness();
			await h.source("images");
			await h.controller.apply(
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						fromSources: ["images"],
						autoPromotion: AutoPromotion.NEWEST,
					}),
				]),
				h.ctx,
			);
			h.ledger.add("f1", T0 - 2 * HOUR);
			h.ledger.add("f2", T0 - HOUR);
			const fanoutId = `manual-fanout-${terminal.state}`;
			const status = create(FanoutStatusRecordSchema, {
				fanoutId,
				pipeline: "shop",
				node: "dev",
				freightId: "f1",
				state: terminal.state,
			});
			await h.store.seed(
				CD_STREAMS.fanout(fanoutId),
				CD_EVENTS.FanoutStarted,
				startedBody({
					fanoutId,
					pipeline: "shop",
					node: "dev",
					freightId: "f1",
					decision: create(PlacementDecisionRecordSchema),
					fanout: create(FanoutRecordSchema),
					departure: DepartureAction.UNSPECIFIED,
					windows: [],
					idempotencyKey: `manual-fanout-key-${terminal.state}`,
					departing: [],
					atMs: T0,
				}),
				undefined,
				{ promotionRequestMode: "manual" },
			);
			await h.promoted("f1", ["dev-1"], "shop", "dev");
			const replayed = h.build();
			await replayed.tick(h.ctx);
			expect(await replayed.autoPromotionHolds()).toHaveLength(1);
			const body =
				terminal.type === CD_EVENTS.FanoutHalted
					? haltedBody({
							reason: create(ReasonRecordSchema, {
								code: "fanout-halted",
								message: "canary failed",
								remediation: "roll back or promote newer Freight",
							}),
							atMs: T0,
							status,
						})
					: statusBody({
							atMs: T0,
							campIds: [],
							reasons: [],
							status,
						});
			await h.store.seed(CD_STREAMS.fanout(fanoutId), terminal.type, body);
			await replayed.tick(h.ctx);
			expect(await replayed.autoPromotionHolds()).toEqual([]);
			expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
			const again = h.build();
			await again.tick(h.ctx);
			expect(await again.autoPromotionHolds()).toEqual([]);
		}
	});

	it("keeps an earlier manual fan-out hold when a later manual fan-out starts", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 3 * HOUR);
		h.ledger.add("f2", T0 - 2 * HOUR);
		h.ledger.add("f3", T0 - HOUR);
		await seedManualFanout(h, "manual-fanout-f1", "f1");
		await seedManualFanout(h, "manual-fanout-f2", "f2");
		const replayed = h.build();
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toMatchObject([
			{ pipeline: "shop", node: "dev", freightId: "f1" },
		]);
		expect(h.promotions.requests.map((r) => r.freightId)).not.toContain("f3");
		await seedFanoutCompleted(h, "manual-fanout-f1", "f1");
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toMatchObject([
			{ freightId: "f2" },
		]);
		expect(h.promotions.requests.map((r) => r.freightId)).not.toContain("f3");
		await seedFanoutCompleted(h, "manual-fanout-f2", "f2");
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f3");
		const again = h.build();
		await again.tick(h.ctx);
		expect(await again.autoPromotionHolds()).toEqual([]);
	});

	it("does not clear a newer manual hold when an older promotion completes", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 3 * HOUR);
		h.ledger.add("f2", T0 - 2 * HOUR);
		h.ledger.add("f3", T0 - HOUR);
		for (const freightId of ["f1", "f2"]) {
			await h.promotions.promote(
				{
					freightId: fid(freightId),
					targets: [camp("dev-1")],
					idempotencyKey: `manual-${freightId}`,
					pipeline: "shop",
					node: "dev",
				},
				h.ctx,
			);
			await h.controller.tick(h.ctx);
		}
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toMatchObject([
			{ freightId: "f2" },
		]);
		expect(h.promotions.requests.map((r) => r.freightId)).not.toContain("f3");
		await h.promoted("f2", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f3");
	});

	it("blocks auto-promotion after a manual non-candidate promote until pinned Freight is promoted on the node", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.at(-1)?.freightId).toBe("f2");
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "manual-f1",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.controller.tick(h.ctx);
		const holds = await h.controller.autoPromotionHolds();
		expect(holds).toEqual([
			{
				pipeline: "shop",
				node: "dev",
				freightId: "f1",
				heldAtMs: T0,
			},
		]);
		const returnedHold = holds[0];
		if (!returnedHold) throw new Error("missing manual hold");
		Reflect.set(returnedHold, "freightId", "changed");
		expect((await h.controller.autoPromotionHolds())[0]?.freightId).toBe("f1");
		expect(h.telemetry.named(PIPELINE_METRIC.autoPromotionHeld)).toHaveLength(
			1,
		);
		h.c.advance(MINUTE);
		h.ledger.add("f3", h.c.now());
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => r.freightId)).not.toContain("f3");
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		expect(await h.controller.autoPromotionHolds()).toEqual([]);
		h.c.advance(MINUTE);
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f3");
	});

	it("clears a manual hold when the promotion fails or is superseded, including after replay", async () => {
		const outcomes = [
			{
				type: CD_EVENTS.EnvPromoteRejected,
				state: PromotionState.FAILED,
			},
			{
				type: CD_EVENTS.EnvPromoteSuperseded,
				state: PromotionState.SUPERSEDED,
			},
			{
				type: CD_EVENTS.EnvPromoteRolledBack,
				state: PromotionState.ROLLED_BACK,
			},
		] as const;
		for (const outcome of outcomes) {
			const h = harness();
			await h.source("images");
			await h.controller.apply(
				pipeline("shop", [
					node("dev", {
						campIds: ["dev-1"],
						fromSources: ["images"],
						autoPromotion: AutoPromotion.NEWEST,
					}),
				]),
				h.ctx,
			);
			h.ledger.add("f1", T0 - 2 * HOUR);
			h.ledger.add("f2", T0 - HOUR);
			await h.promotions.promote(
				{
					freightId: fid("f1"),
					targets: [camp("dev-1")],
					idempotencyKey: "manual-f1",
					pipeline: "shop",
					node: "dev",
				},
				h.ctx,
			);
			await h.controller.tick(h.ctx);
			expect(await h.controller.autoPromotionHolds()).toHaveLength(1);
			const promotionId = h.promotions.records.get("manual-f1")?.promotionId;
			if (!promotionId) throw new Error("missing manual promotion");
			await h.store.seed(
				CD_STREAMS.promotion(promotionId),
				outcome.type,
				toJson(
					PromotionRecordSchema,
					create(PromotionRecordSchema, {
						promotionId,
						freightId: "f1",
						targetCampIds: ["dev-1"],
						pipeline: "shop",
						node: "dev",
						state: outcome.state,
						idempotencyKey: "manual-f1",
					}),
				),
			);
			await h.controller.tick(h.ctx);
			expect(await h.controller.autoPromotionHolds()).toEqual([]);
			expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
			const replayed = h.build();
			await replayed.tick(h.ctx);
			expect(await replayed.autoPromotionHolds()).toEqual([]);
		}
	});

	it("does not keep a manual hold after a failed promotion is retried and the retry promotes", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "manual-f1",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toMatchObject([
			{ freightId: "f1" },
		]);
		const failedId = h.promotions.records.get("manual-f1")?.promotionId;
		if (!failedId) throw new Error("missing failed promotion");
		await h.store.seed(
			CD_STREAMS.promotion(failedId),
			CD_EVENTS.EnvPromoteRejected,
			toJson(
				PromotionRecordSchema,
				create(PromotionRecordSchema, {
					promotionId: failedId,
					freightId: "f1",
					targetCampIds: ["dev-1"],
					pipeline: "shop",
					node: "dev",
					state: PromotionState.FAILED,
					idempotencyKey: "manual-f1",
				}),
			),
		);
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "manual-f1-retry",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		const retryId = h.promotions.records.get("manual-f1-retry")?.promotionId;
		if (!retryId) throw new Error("missing retried promotion");
		expect(retryId).not.toBe(failedId);
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toMatchObject([
			{ freightId: "f1" },
		]);
		expect(h.promotions.requests.map((r) => r.freightId)).not.toContain("f2");
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		expect(h.store.events(CD_EVENTS.EnvPromoted).at(-1)?.data).toMatchObject({
			promotionId: retryId,
		});
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.freightId)).toContain("f2");
		const replayed = h.build();
		await replayed.tick(h.ctx);
		expect(await replayed.autoPromotionHolds()).toEqual([]);
	});
});

describe("promoteByOrigin", () => {
	it("refuses a manual request when an older key has no recorded mode", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR);
		await h.store.seed(
			CD_STREAMS.promotion("legacy-request"),
			CD_EVENTS.EnvPromoteRequested,
			toJson(
				PromotionRecordSchema,
				create(PromotionRecordSchema, {
					promotionId: "legacy-request",
					freightId: "f1",
					targetCampIds: ["dev-1"],
					pipeline: "shop",
					node: "dev",
					state: PromotionState.QUEUED,
					idempotencyKey: "legacy-key",
				}),
			),
		);
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "dev",
				origin: "images",
				idempotencyKey: "legacy-key",
			},
			h.ctx,
		);
		expect(result.ok).toBe(false);
	});

	it("refuses to reuse a manual key for different Freight", async () => {
		const h = harness();
		await h.source("images-old");
		await h.source("images-new");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images-old", "images-new"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { sourceName: "images-old" });
		h.ledger.add("f2", T0, { sourceName: "images-new" });
		const request = {
			pipeline: "shop",
			node: "dev",
			origin: "images-old",
			idempotencyKey: "manual-reused",
		};
		expect((await h.controller.promoteByOrigin(request, h.ctx)).ok).toBe(true);
		expect(
			(
				await h.controller.promoteByOrigin(
					{ ...request, origin: "images-new" },
					h.ctx,
				)
			).ok,
		).toBe(false);
	});

	it("refuses to reuse an automatic request key for a manual promotion", async () => {
		const h = harness();
		await h.source("images-old");
		await h.source("images-new");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images-old", "images-new"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { sourceName: "images-old" });
		await h.controller.tick(h.ctx);
		h.ledger.add("f2", T0, { sourceName: "images-new" });
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "dev",
				origin: "images-old",
				idempotencyKey: pipelineKey("shop", "dev", "f1"),
			},
			h.ctx,
		);
		expect(result.ok).toBe(false);
	});

	it("does not claim a manual fan-out was requested when that Freight is already running", async () => {
		const h = harness();
		h.placement.add("fleet");
		await h.controller.apply(
			pipeline("shop", [
				node("fleet", {
					placement: "fleet",
					fromSources: ["origin:manifest"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { origin: FreightOrigin.MANIFEST });
		await h.controller.tick(h.ctx);
		expect(h.fanout.started).toHaveLength(1);
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "fleet",
				origin: "origin:manifest",
				idempotencyKey: "manual-running",
			},
			h.ctx,
		);
		expect(result.ok).toBe(false);
	});

	it("accepts a retry of the same manual fan-out idempotency key while that fan-out is running", async () => {
		const h = harness();
		h.placement.add("fleet");
		await h.controller.apply(
			pipeline("shop", [
				node("fleet", {
					placement: "fleet",
					fromSources: ["origin:manifest"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { origin: FreightOrigin.MANIFEST });
		const request = {
			pipeline: "shop",
			node: "fleet",
			origin: "origin:manifest",
			idempotencyKey: "manual-same-key",
		};
		expect((await h.controller.promoteByOrigin(request, h.ctx)).ok).toBe(true);
		expect(h.fanout.started).toHaveLength(1);
		const retry = await h.controller.promoteByOrigin(request, h.ctx);
		expect(retry.ok).toBe(true);
		if (!retry.ok) return;
		expect(retry.value.freightId).toBe("f1");
		expect(h.fanout.started).toHaveLength(1);
	});

	it("refuses a manual fan-out that reuses a running automatic fan-out's idempotency key", async () => {
		const h = harness();
		h.placement.add("fleet");
		await h.controller.apply(
			pipeline("shop", [
				node("fleet", {
					placement: "fleet",
					fromSources: ["origin:manifest"],
					autoPromotion: AutoPromotion.NEWEST,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { origin: FreightOrigin.MANIFEST });
		await h.controller.tick(h.ctx);
		expect(h.fanout.started).toHaveLength(1);
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "fleet",
				origin: "origin:manifest",
				idempotencyKey: pipelineKey("shop", "fleet", "f1"),
			},
			h.ctx,
		);
		expect(result.ok).toBe(false);
		expect(h.fanout.started).toHaveLength(1);
	});

	it("reports a refused promotion instead of claiming it was requested", async () => {
		const h = harness();
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["origin:manifest"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { origin: FreightOrigin.MANIFEST });
		h.promotions.refuseNext = true;
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "dev",
				origin: "origin:manifest",
				idempotencyKey: "refused-manifest",
			},
			h.ctx,
		);
		expect(result.ok).toBe(false);
	});

	it("requests promotion for the newest Freight matching an origin pseudo-source", async () => {
		const h = harness();
		await h.source("images");
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["origin:manifest"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { origin: FreightOrigin.SOURCE_DISCOVERY });
		h.ledger.add("f2", T0 - MINUTE, { origin: FreightOrigin.MANIFEST });
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "dev",
				origin: "origin:manifest",
				idempotencyKey: "by-origin-manifest",
			},
			h.ctx,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.freightId).toBe("f2");
		expect(h.promotions.requests.at(-1)).toMatchObject({
			freightId: "f2",
			pipeline: "shop",
			node: "dev",
			idempotencyKey: "by-origin-manifest",
		});
	});

	it("refuses when no Freight is available for the origin", async () => {
		const h = harness();
		await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["origin:manifest"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
			]),
			h.ctx,
		);
		h.ledger.add("f1", T0 - HOUR, { origin: FreightOrigin.MANIFEST });
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "dev",
				origin: "origin:hobo-ci",
				idempotencyKey: "missing",
			},
			h.ctx,
		);
		expect(result.ok).toBe(false);
	});
});
