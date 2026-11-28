import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AutoPromotion,
	FanoutStrategy,
	FreightOrigin,
	FreightOriginSlotRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { camp, fid, HOUR, MINUTE, T0 } from "./fakes.js";
import { harness, node, pipeline } from "./harness.js";

describe("origin slots", () => {
	it("rejects a slot name that is not a slug", async () => {
		const h = harness();
		await h.source("images");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "not:a-slug",
							fromSources: ["images"],
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(false);
	});

	it("holds slot auto-promotion while a different manual promotion is pending", async () => {
		const h = harness();
		await h.source("images");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("f1", T0 - 2 * HOUR, { sourceName: "images" });
		h.ledger.add("f2", T0 - HOUR, { sourceName: "images" });
		await h.promotions.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "manual-slot-f1",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.controller.tick(h.ctx);
		expect(await h.controller.autoPromotionHolds()).toMatchObject([
			{ pipeline: "shop", node: "dev", freightId: "f1" },
		]);
		expect(h.promotions.requests.map((request) => request.freightId)).toEqual([
			"f1",
		]);
		await h.promoted("f1", ["dev-1"], "shop", "dev");
		await h.build().tick(h.ctx);
		expect(h.promotions.requests.map((request) => request.freightId)).toEqual([
			"f1",
			"f2",
		]);
	});

	it("leaves a slot that inherits the node's DISABLED policy to explicit commands", async () => {
		const h = harness();
		await h.source("images");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("f1", T0 - 2 * HOUR, { sourceName: "images" });
		h.ledger.add("f2", T0 - HOUR, { sourceName: "images" });
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
		expect(await h.controller.autoPromotionHolds()).toEqual([]);
		expect(h.promotions.requests.map((r) => r.idempotencyKey)).toEqual([
			"manual-f1",
		]);
	});

	it("still promotes by origin while a slot hold is active", async () => {
		const h = harness();
		await h.source("images");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("f1", T0 - 2 * HOUR, { sourceName: "images" });
		h.ledger.add("f2", T0 - HOUR, { sourceName: "images" });
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
			{ pipeline: "shop", node: "dev", freightId: "f1" },
		]);
		const result = await h.controller.promoteByOrigin(
			{
				pipeline: "shop",
				node: "dev",
				origin: "images",
				idempotencyKey: "manual-by-origin",
			},
			h.ctx,
		);
		expect(result).toMatchObject({ ok: true, value: { freightId: "f2" } });
		expect(h.promotions.requests.at(-1)).toMatchObject({
			freightId: "f2",
			idempotencyKey: "manual-by-origin",
			requestMode: "manual",
		});
	});

	it("matches a slot's qualified Freight to a late entrant", async () => {
		const h = harness();
		await h.source("images");
		await h.source("packages");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1", "staging-1"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.MATCH_NODE,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("f2", T0 - HOUR, { sourceName: "images" });
		h.ledger.qualify("f2", "dev-1", "shop", "dev", T0 - MINUTE);
		h.ledger.add("other", T0 - MINUTE, { sourceName: "packages" });
		h.ledger.qualify("other", "dev-1", "shop", "dev", T0 - MINUTE);
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests).toEqual([
			expect.objectContaining({ freightId: "f2", targets: ["staging-1"] }),
		]);
	});

	it("uses a slot-scoped key for a placed-node fanout", async () => {
		const h = harness();
		await h.source("images");
		h.placement.add("fleet");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("fleet", {
					placement: "fleet",
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					fanout: { strategy: FanoutStrategy.PROGRESSIVE, maxConcurrency: 5 },
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("f2", T0 - HOUR, { sourceName: "images" });
		await h.controller.tick(h.ctx);
		expect(h.fanout.started).toMatchObject([
			{ idempotencyKey: "pipeline:shop:fleet:f2:slot:oci" },
		]);
	});

	it("matches the latest upstream promotion for each slot independently", async () => {
		const h = harness();
		await h.source("images");
		await h.source("packages");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images", "packages"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
				node("prod", {
					campIds: ["prod-1"],
					fromNodes: ["dev"],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.MATCH_UPSTREAM,
						}),
						create(FreightOriginSlotRecordSchema, {
							name: "npm",
							fromSources: ["packages"],
							autoPromotion: AutoPromotion.MATCH_UPSTREAM,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("image", T0 - 2 * HOUR, { sourceName: "images" });
		h.ledger.add("package", T0 - HOUR, { sourceName: "packages" });
		h.ledger.qualify("image", "dev-1", "shop", "dev", T0 - MINUTE);
		h.ledger.qualify("package", "dev-1", "shop", "dev", T0 - MINUTE);
		await h.promoted("image", ["dev-1"], "shop", "dev");
		await h.promoted("package", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		await h.build().tick(h.ctx);
		expect(
			h.promotions.requests.map((request) => request.freightId).sort(),
		).toEqual(["image", "package"]);
	});

	it("follows a manual upstream promotion only in the slot that admits its source", async () => {
		const h = harness();
		await h.source("images");
		await h.source("packages");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
						create(FreightOriginSlotRecordSchema, {
							name: "npm",
							fromSources: ["packages"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
					],
				}),
				node("prod", {
					campIds: ["prod-1"],
					fromNodes: ["dev"],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.MATCH_UPSTREAM,
						}),
						create(FreightOriginSlotRecordSchema, {
							name: "npm",
							fromSources: ["packages"],
							autoPromotion: AutoPromotion.MATCH_UPSTREAM,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("i2", T0 - 2 * HOUR, { sourceName: "images" });
		h.ledger.add("p2", T0 - HOUR, { sourceName: "packages" });
		h.ledger.qualify("i2", "dev-1", "shop", "dev", T0 - MINUTE);
		h.ledger.qualify("p2", "dev-1", "shop", "dev", T0 - MINUTE);
		await h.promoted("i2", ["dev-1"], "shop", "dev");
		await h.promoted("p2", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		h.ledger.add("i1", T0 - 3 * HOUR, { sourceName: "images" });
		h.ledger.qualify("i1", "dev-1", "shop", "dev", T0 - MINUTE);
		await h.promotions.promote(
			{
				freightId: fid("i1"),
				targets: [camp("dev-1")],
				idempotencyKey: "manual-i1",
				pipeline: "shop",
				node: "dev",
			},
			h.ctx,
		);
		await h.promoted("i1", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		expect(
			h.promotions.requests.map(
				(request) => `${request.freightId} ${request.idempotencyKey}`,
			),
		).toEqual([
			"i2 pipeline:shop:dev:i2:slot:oci",
			"p2 pipeline:shop:dev:p2:slot:npm",
			"i2 pipeline:shop:prod:i2:slot:oci",
			"p2 pipeline:shop:prod:p2:slot:npm",
			"i1 manual-i1",
			"i1 pipeline:shop:prod:i1:slot:oci",
		]);
	});

	it("matches an origin pseudo-source slot to the latest upstream promotion of that origin", async () => {
		const h = harness();
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["origin:hobo-ci"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
				node("prod", {
					campIds: ["prod-1"],
					fromNodes: ["dev"],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "ci",
							fromSources: ["origin:hobo-ci"],
							autoPromotion: AutoPromotion.MATCH_UPSTREAM,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("ci-build", T0 - 2 * HOUR, { origin: FreightOrigin.HOBO_CI });
		h.ledger.add("manifest", T0 - HOUR, { origin: FreightOrigin.MANIFEST });
		h.ledger.qualify("ci-build", "dev-1", "shop", "dev", T0 - MINUTE);
		h.ledger.qualify("manifest", "dev-1", "shop", "dev", T0 - MINUTE);
		await h.promoted("ci-build", ["dev-1"], "shop", "dev");
		await h.promoted("manifest", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests).toEqual([
			expect.objectContaining({
				freightId: "ci-build",
				idempotencyKey: "pipeline:shop:prod:ci-build:slot:ci",
			}),
		]);
	});

	it("auto-promotes through a slot with a slot-scoped idempotency key", async () => {
		const h = harness();
		await h.source("images");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
					],
				}),
			]),
			h.ctx,
		);
		if (!applied.ok) throw new Error(JSON.stringify(applied.reasons));
		h.ledger.add("f1", T0 - 2 * HOUR, { sourceName: "images" });
		h.ledger.add("f2", T0 - HOUR, { sourceName: "images" });
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests).toEqual([
			expect.objectContaining({
				freightId: "f2",
				idempotencyKey: "pipeline:shop:dev:f2:slot:oci",
			}),
		]);
	});

	it("does not fall back to an older upstream Freight when the latest is unusable", async () => {
		const h = harness();
		await h.source("images");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("dev", {
					campIds: ["dev-1"],
					fromSources: ["images"],
					autoPromotion: AutoPromotion.DISABLED,
				}),
				node("prod", {
					campIds: ["prod-1"],
					fromNodes: ["dev"],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.MATCH_UPSTREAM,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("old", T0 - 2 * HOUR, { sourceName: "images" });
		h.ledger.add("new", T0 - HOUR, { sourceName: "images" });
		h.ledger.qualify("old", "dev-1", "shop", "dev", T0 - MINUTE);
		h.ledger.qualify("new", "dev-1", "shop", "dev", T0 - MINUTE);
		h.ledger.unusable.add("new");
		await h.promoted("old", ["dev-1"], "shop", "dev");
		await h.promoted("new", ["dev-1"], "shop", "dev");
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests).toEqual([]);
	});

	it("runs independent NEWEST lanes per slot on different nodes", async () => {
		const h = harness();
		await h.source("images");
		await h.source("packages");
		h.topology.add("dev-2");
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("oci-dev", {
					campIds: ["dev-1"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "oci",
							fromSources: ["images"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
					],
				}),
				node("pkg-dev", {
					campIds: ["dev-2"],
					fromSources: [],
					autoPromotion: AutoPromotion.DISABLED,
					originSlots: [
						create(FreightOriginSlotRecordSchema, {
							name: "npm",
							fromSources: ["packages"],
							autoPromotion: AutoPromotion.NEWEST,
						}),
					],
				}),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("f2", T0 - HOUR, { sourceName: "images" });
		h.ledger.add("p2", T0 - HOUR, { sourceName: "packages" });
		await h.controller.tick(h.ctx);
		expect(h.promotions.requests.map((r) => r.freightId).sort()).toEqual([
			"f2",
			"p2",
		]);
	});
});
