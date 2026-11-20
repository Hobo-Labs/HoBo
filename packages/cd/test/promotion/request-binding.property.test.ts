import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { RolloutStrategy } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { fanoutIdFor } from "../../src/fanout/controller.js";
import type { PromoteRequest } from "../../src/ports.js";
import { PROMOTION_REASON } from "../../src/promotion/index.js";
import { resolvedFor } from "./doubles.js";
import { harness } from "./harness.js";
import { camp, fid, HOUR } from "./store.js";

function changedRequest(base: PromoteRequest, field: string): PromoteRequest {
	switch (field) {
		case "intent":
			return { ...base, intent: "up" };
		case "pipeline":
			return { ...base, pipeline: "other-pipeline" };
		case "node":
			return { ...base, node: "other-node" };
		case "source":
			return { ...base, sourceCampId: camp("other-source") };
		case "strategy":
			return { ...base, strategy: RolloutStrategy.CANARY };
		case "proposal":
			return { ...base, proposal: true };
		case "fanout":
			return {
				...base,
				fanoutId: fanoutIdFor("acme", "pipe", "node", "other"),
			};
		default:
			throw new Error(`unknown field ${field}`);
	}
}

const fields = fc.constantFrom(
	"intent",
	"pipeline",
	"node",
	"source",
	"strategy",
	"proposal",
	"fanout",
);

describe("promotion request binding", () => {
	it("preserves identical retries and refuses changed request fields after restart", async () => {
		await fc.assert(
			fc.asyncProperty(fields, async (field) => {
				const h = harness();
				h.freight.add("f1");
				const request = {
					freightId: fid("f1"),
					targets: [camp("dev-1")],
					idempotencyKey: "binding",
				};
				const first = await h.service.promote(request, h.ctx());
				expect(first.ok).toBe(true);
				const repeated = await h.restart().promote(request, h.ctx());
				expect(repeated.ok).toBe(true);
				if (!first.ok || !repeated.ok) throw new Error("expected promotion");
				expect(repeated.value.promotionId).toBe(first.value.promotionId);
				const effects = h.desired.applied.length;
				const changed = await h
					.restart()
					.promote(changedRequest(request, field), h.ctx());
				expect(changed.ok).toBe(false);
				if (!changed.ok)
					expect(changed.reasons[0]?.code).toBe(
						PROMOTION_REASON.idempotencyReused,
					);
				expect(h.desired.applied).toHaveLength(effects);
				expect(h.store.events(CD_EVENTS.EnvPromoteRequested)).toHaveLength(1);
			}),
			{ seed: 614453, numRuns: 100 },
		);
	});

	it("refuses one of two different requests racing for a key", async () => {
		await fc.assert(
			fc.asyncProperty(fields, async (field) => {
				const h = harness();
				h.freight.add("f1");
				const request = {
					freightId: fid("f1"),
					targets: [camp("dev-1")],
					idempotencyKey: "race",
				};
				const [first, second] = await Promise.all([
					h.service.promote(request, h.ctx()),
					h.restart().promote(changedRequest(request, field), h.ctx()),
				]);
				expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
				expect(h.store.events(CD_EVENTS.EnvPromoteRequested)).toHaveLength(1);
			}),
			{ seed: 614454, numRuns: 100 },
		);
	});

	it("rejects a concurrent different intent after the journal picks a winner", async () => {
		const h = harness();
		h.freight.add("f1");
		const request = {
			freightId: fid("f1"),
			targets: [camp("dev-1")],
			idempotencyKey: "intent-race",
		};
		const results = await Promise.all([
			h.service.promote(request, h.ctx()),
			h.restart().promote({ ...request, intent: "up" }, h.ctx()),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		const rejected = results.find((result) => !result.ok);
		if (!rejected || rejected.ok) throw new Error("expected a rejection");
		expect(rejected.reasons[0]?.code).toBe(PROMOTION_REASON.idempotencyReused);
		expect(h.store.events(CD_EVENTS.EnvPromoteRequested)).toHaveLength(1);
	});

	it("binds the target execution order", async () => {
		const h = harness();
		h.freight.add("f1");
		const request = {
			freightId: fid("f1"),
			targets: [camp("dev-1"), camp("dev-2")],
			idempotencyKey: "target-order",
		};
		expect((await h.service.promote(request, h.ctx())).ok).toBe(true);
		const reversed = await h
			.restart()
			.promote(
				{ ...request, targets: [...request.targets].reverse() },
				h.ctx(),
			);
		expect(reversed.ok).toBe(false);
		if (!reversed.ok)
			expect(reversed.reasons[0]?.code).toBe(
				PROMOTION_REASON.idempotencyReused,
			);
	});

	it("checks legacy records using available fields and refuses ambiguous replays", async () => {
		const h = harness();
		h.freight.add("f1");
		const request = {
			freightId: fid("f1"),
			targets: [camp("dev-1")],
			idempotencyKey: "legacy",
		};
		expect((await h.service.promote(request, h.ctx())).ok).toBe(true);
		const event = h.store.events(CD_EVENTS.EnvPromoteRequested)[0];
		if (!event?.meta) throw new Error("request metadata missing");
		delete event.meta.promotionRequestFingerprint;
		expect((await h.restart().promote(request, h.ctx())).ok).toBe(true);
		const changed = await h
			.restart()
			.promote({ ...request, intent: "up" }, h.ctx());
		expect(changed.ok).toBe(false);
		if (!changed.ok)
			expect(changed.reasons[0]?.code).toBe(PROMOTION_REASON.idempotencyReused);
	});

	it("checks preview inputs and returns the persisted preview on retry", async () => {
		const h = harness();
		h.freight.add("f1");
		h.desired.seed("dev-1", "f1", resolvedFor("dev-1", "alpha", "f1"));
		const request = {
			freightId: fid("f1"),
			sourceCampId: camp("dev-1"),
			ttlMs: HOUR,
			idempotencyKey: "preview-binding",
		};
		const first = await h.service.createPreview(request, h.ctx());
		if (!first.ok) throw new Error("expected preview");
		h.clock.advance(1000);
		const repeated = await h.restart().createPreview(request, h.ctx());
		expect(repeated.ok && repeated.value.expiresAt).toBe(first.value.expiresAt);
		for (const changed of [
			{ ...request, freightId: fid("f2") },
			{ ...request, sourceCampId: camp("dev-2") },
			{ ...request, ttlMs: HOUR + 1 },
			{ ...request, pipeline: "other" },
			{ ...request, node: "other" },
		]) {
			const result = await h.restart().createPreview(changed, h.ctx());
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.reasons[0]?.code).toBe(
					PROMOTION_REASON.idempotencyReused,
				);
		}
		for (const ttlMs of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
			expect(
				(
					await h.service.createPreview(
						{ ...request, idempotencyKey: "invalid", ttlMs },
						h.ctx(),
					)
				).ok,
			).toBe(false);
		}
	});

	it("refuses one of two different preview requests racing for a key", async () => {
		const h = harness();
		h.freight.add("f1");
		h.desired.seed("dev-1", "f1", resolvedFor("dev-1", "alpha", "f1"));
		const request = {
			freightId: fid("f1"),
			sourceCampId: camp("dev-1"),
			ttlMs: HOUR,
			idempotencyKey: "preview-race",
		};
		const [first, second] = await Promise.all([
			h.service.createPreview(request, h.ctx()),
			h.restart().createPreview(
				{ ...request, sourceCampId: camp("dev-2") },
				h.ctx(),
			),
		]);
		expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
		expect(h.store.events(CD_EVENTS.EnvPromoteRequested)).toHaveLength(1);
	});

	it("claims a rollback key before effects and refuses different concurrent work", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		for (const id of ["dev-1", "dev-2"]) {
			h.desired.seed(id, "f0", resolvedFor(id, "alpha", "f0"));
		}
		const promotion = await h.service.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1"), camp("dev-2")],
				idempotencyKey: "promotion-for-rollback",
			},
			h.ctx(),
		);
		expect(promotion.ok).toBe(true);
		const requests = [
			{
				campId: camp("dev-1"),
				reason: "restore",
				idempotencyKey: "rollback-race",
			},
			{
				campId: camp("dev-2"),
				reason: "restore",
				idempotencyKey: "rollback-race",
			},
		];
		const first = requests[0];
		const second = requests[1];
		if (!first || !second) throw new Error("missing rollback requests");
		const results = await Promise.all([
			h.service.rollback(first, h.ctx()),
			h.restart().rollback(second, h.ctx()),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		const rejected = results.find((result) => !result.ok);
		if (!rejected || rejected.ok) throw new Error("expected a rejection");
		expect(rejected.reasons[0]?.code).toBe(PROMOTION_REASON.idempotencyReused);
		const values = await Promise.all([
			h.desired.current(camp("dev-1")),
			h.desired.current(camp("dev-2")),
		]);
		expect(values.map((value) => value?.freightId).sort()).toEqual([
			"f0",
			"f1",
		]);
		expect(h.store.events(CD_EVENTS.EnvPromoteRolledBack)).toHaveLength(1);
	});

	it("does not perform rollback effects when its journal claim fails", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		await h.service.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "promotion",
			},
			h.ctx(),
		);
		const append = h.store.append.bind(h.store);
		vi.spyOn(h.store, "append").mockImplementation(
			async (stream, events, opts) => {
				if (
					events.some(
						(event) => event.meta?.idempotencyKey === "rollback:started",
					)
				)
					throw new Error("injected journal failure");
				return append(stream, events, opts);
			},
		);
		const result = await h.service.rollback(
			{
				campId: camp("dev-1"),
				reason: "restore",
				idempotencyKey: "failed-claim",
			},
			h.ctx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reasons[0]?.code).toBe(PROMOTION_REASON.journalConflict);
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f1");
		expect(h.store.events(CD_EVENTS.EnvPromoteRolledBack)).toHaveLength(0);
	});

	it("does not acknowledge a rollback when recording its result fails", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		await h.service.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "promotion",
			},
			h.ctx(),
		);
		const append = h.store.append.bind(h.store);
		vi.spyOn(h.store, "append").mockImplementation(
			async (stream, events, opts) => {
				if (
					events.some((event) => event.type === CD_EVENTS.EnvPromoteRolledBack)
				)
					throw new Error("injected result failure");
				return append(stream, events, opts);
			},
		);
		const result = await h.service.rollback(
			{
				campId: camp("dev-1"),
				reason: "restore",
				idempotencyKey: "failed-result",
			},
			h.ctx(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reasons[0]?.code).toBe(PROMOTION_REASON.journalConflict);
		expect(h.store.events(CD_EVENTS.EnvPromoteRolledBack)).toHaveLength(0);
		vi.restoreAllMocks();
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f0");
		const retried = await h.service.rollback(
			{
				campId: camp("dev-1"),
				reason: "restore",
				idempotencyKey: "failed-result",
			},
			h.ctx(),
		);
		expect(retried.ok).toBe(false);
		if (!retried.ok)
			expect(retried.reasons[0]?.code).toBe(PROMOTION_REASON.journalConflict);
		expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f0");
	});

	it("does not infer the requested Set of a legacy rollback", async () => {
		const h = harness();
		h.freight.add("f0");
		h.freight.add("f1");
		h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
		await h.service.promote(
			{
				freightId: fid("f1"),
				targets: [camp("dev-1")],
				idempotencyKey: "promotion",
			},
			h.ctx(),
		);
		const request = {
			campId: camp("dev-1"),
			reason: "restore",
			idempotencyKey: "legacy-rollback",
		};
		expect((await h.service.rollback(request, h.ctx())).ok).toBe(true);
		const event = h.store.events(CD_EVENTS.EnvPromoteRolledBack)[0];
		if (!event?.meta) throw new Error("rollback metadata missing");
		delete event.meta.rollbackRequestFingerprint;
		const repeated = await h.restart().rollback(request, h.ctx());
		expect(repeated.ok).toBe(false);
		if (!repeated.ok)
			expect(repeated.reasons[0]?.code).toBe(
				PROMOTION_REASON.idempotencyReused,
			);
	});
});

it("does not undo a Set installed after the rollback guard", async () => {
	const h = harness();
	h.freight.add("f0");
	h.freight.add("f1");
	h.freight.add("f2");
	h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
	await h.service.promote(
		{ freightId: fid("f1"), targets: [camp("dev-1")], idempotencyKey: "setup" },
		h.ctx(),
	);
	const current = h.desired.current.bind(h.desired);
	let reads = 0;
	vi.spyOn(h.desired, "current").mockImplementation(async (id) => {
		if (id === camp("dev-1") && ++reads === 3)
			h.desired.seed("dev-1", "f2", resolvedFor("dev-1", "alpha", "f2"));
		return current(id);
	});
	const result = await h.service.rollback(
		{
			campId: camp("dev-1"),
			reason: "restore",
			idempotencyKey: "race-current",
		},
		h.ctx(),
	);
	expect(result.ok).toBe(false);
	expect((await h.desired.current(camp("dev-1")))?.freightId).toBe("f2");
});
