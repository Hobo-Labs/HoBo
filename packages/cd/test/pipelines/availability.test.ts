// PipelineController.available (D4, D21, I13, I16): lineage from
// qualifications, soak from upstream env.Promoted, approvals per Camp until
// expiry, quorum over placement decisions with mandatory groups.

import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Availability,
	FreightOrigin,
	QuorumRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { quorumThreshold } from "../../src/pipelines/index.js";
import { decisionOf } from "./doubles.js";
import { HOUR, MINUTE, T0 } from "./fakes.js";
import { harness, node, pipeline } from "./harness.js";

async function arranged(availability: Availability, soakMs = 0n) {
	const h = harness();
	await h.source("images");
	const applied = await h.controller.apply(
		pipeline("shop", [
			node("dev", { campIds: ["dev-1"], fromSources: ["images"] }),
			node("staging", {
				campIds: ["staging-1", "staging-2"],
				fromSources: ["images"],
			}),
			node("prod", {
				campIds: ["prod-1"],
				fromNodes: ["dev", "staging"],
				availability,
				requiredSoakMs: soakMs,
			}),
		]),
		h.ctx,
	);
	expect(applied.ok).toBe(true);
	return h;
}

const ids = async (h: ReturnType<typeof harness>, n: string) =>
	(await h.controller.available({ pipeline: "shop", node: n })).map(
		(a) => a.freightId,
	);

describe("available", () => {
	it("roots see Freight from their sources, newest first, with the source as via", async () => {
		const h = await arranged(Availability.ONE_OF);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.ledger.add("f2", T0 - HOUR);
		h.ledger.add("other-source", T0, { sourceName: "charts" });
		h.ledger.add("other-bindle", T0, { bindle: "acme/other" });
		const dev = await h.controller.available({ pipeline: "shop", node: "dev" });
		expect(dev.map((a) => [a.freightId, a.via])).toEqual([
			["f2", ["images"]],
			["f1", ["images"]],
		]);
		expect(dev[0]?.availableAt).toBe(new Date(T0 - HOUR).toISOString());
	});

	it("Kargo parity: ONE_OF needs one qualified upstream; ALL needs every upstream Camp", async () => {
		const one = await arranged(Availability.ONE_OF);
		one.ledger.add("f1", T0 - HOUR);
		expect(await ids(one, "prod")).toEqual([]);
		one.ledger.qualify("f1", "staging-1", "shop", "staging", T0 - 10 * MINUTE);
		expect(
			(await one.controller.available({ pipeline: "shop", node: "prod" }))[0]
				?.via,
		).toEqual(["staging"]);

		const all = await arranged(Availability.ALL);
		all.ledger.add("f1", T0 - HOUR);
		all.ledger.qualify("f1", "staging-1", "shop", "staging", T0 - 10 * MINUTE);
		all.ledger.qualify("f1", "dev-1", "shop", "dev", T0 - 10 * MINUTE);
		expect(await ids(all, "prod")).toEqual([]);
		all.ledger.qualify("f1", "staging-2", "shop", "staging", T0 - 5 * MINUTE);
		const prod = await all.controller.available({
			pipeline: "shop",
			node: "prod",
		});
		expect(prod[0]?.via).toEqual(["dev", "staging"]);
		expect(prod[0]?.availableAt).toBe(new Date(T0 - 5 * MINUTE).toISOString());
	});

	it("I16: a qualification in another pipeline or node never counts", async () => {
		const h = await arranged(Availability.ONE_OF);
		h.ledger.add("f1", T0 - HOUR);
		h.ledger.qualify(
			"f1",
			"staging-1",
			"other-pipeline",
			"staging",
			T0 - MINUTE,
		);
		h.ledger.qualify("f1", "prod-1", "shop", "prod", T0 - MINUTE);
		expect(await ids(h, "prod")).toEqual([]);
	});

	it("Kargo parity: soak not yet elapsed withholds availability, measured from the upstream env.Promoted time", async () => {
		const h = await arranged(Availability.ONE_OF, BigInt(HOUR));
		h.ledger.add("f1", T0 - 3 * HOUR);
		h.c.set(T0 - 30 * MINUTE);
		await h.promoted("f1", ["staging-1"], "shop", "staging");
		h.c.set(T0);
		h.ledger.qualify("f1", "staging-1", "shop", "staging", T0 - 20 * MINUTE);
		expect(await ids(h, "prod")).toEqual([]);
		h.c.set(T0 + 30 * MINUTE);
		const prod = await h.controller.available({
			pipeline: "shop",
			node: "prod",
		});
		expect(prod.map((a) => a.freightId)).toEqual(["f1"]);
		expect(prod[0]?.availableAt).toBe(new Date(T0 + 30 * MINUTE).toISOString());
	});

	it("an approval bypasses only its Camp and only until expiry (expired approval: refused)", async () => {
		const h = await arranged(Availability.ONE_OF);
		h.ledger.add("hotfix", T0 - HOUR);
		h.ledger.approveFor("hotfix", "prod-1", T0 + HOUR);
		h.ledger.approveFor("hotfix", "staging-1", T0 + HOUR);
		const prod = await h.controller.available({
			pipeline: "shop",
			node: "prod",
		});
		expect(prod.map((a) => [a.freightId, a.via])).toEqual([
			["hotfix", ["approval"]],
		]);
		h.c.set(T0 + HOUR);
		expect(await ids(h, "prod")).toEqual([]);
	});

	it("I13: yanked or retired Freight is never available", async () => {
		const h = await arranged(Availability.ONE_OF);
		h.ledger.add("f1", T0 - HOUR);
		h.ledger.qualify("f1", "dev-1", "shop", "dev", T0 - MINUTE);
		h.ledger.unusable.add("f1");
		expect(await ids(h, "dev")).toEqual([]);
		expect(await ids(h, "prod")).toEqual([]);
	});

	it("matches pushed Freight through origin pseudo-sources only", async () => {
		const h = harness();
		await h.controller.apply(
			pipeline("shop", [
				node("dev", { campIds: ["dev-1"], fromSources: ["origin:manifest"] }),
			]),
			h.ctx,
		);
		h.ledger.add("pushed", T0, {
			origin: FreightOrigin.MANIFEST,
			sourceName: "",
		});
		h.ledger.add("pulled", T0, { origin: FreightOrigin.SOURCE_DISCOVERY });
		expect(await ids(h, "dev")).toEqual(["pushed"]);
	});

	it("is empty for an unknown pipeline or node", async () => {
		const h = await arranged(Availability.ONE_OF);
		expect(
			await h.controller.available({ pipeline: "nope", node: "dev" }),
		).toEqual([]);
		expect(
			await h.controller.available({ pipeline: "shop", node: "nope" }),
		).toEqual([]);
	});

	it("I8: a controller rebuilt from the same journal answers identically", async () => {
		const h = await arranged(Availability.ONE_OF);
		h.ledger.add("f1", T0 - HOUR);
		h.ledger.qualify("f1", "dev-1", "shop", "dev", T0 - MINUTE);
		const live = await h.controller.available({
			pipeline: "shop",
			node: "prod",
		});
		const replayed = await h
			.build()
			.available({ pipeline: "shop", node: "prod" });
		expect(replayed).toEqual(live);
	});
});

describe("available: placed upstream (AVAILABILITY_QUORUM)", () => {
	const fleet = Array.from(
		{ length: 400 },
		(_, i) => `fleet-${String(i).padStart(3, "0")}`,
	);

	async function placed(mandatory: readonly string[]) {
		const h = harness();
		await h.source("images");
		h.placement.add("fleet", ["pilot"]);
		const applied = await h.controller.apply(
			pipeline("shop", [
				node("fleet", {
					placement: "fleet",
					fromSources: ["images"],
					fanout: { mandatoryGroups: mandatory.length > 0 ? ["pilot"] : [] },
				}),
				node("prod", { campIds: ["prod-1"], fromNodes: ["fleet"] }),
			]),
			h.ctx,
		);
		expect(applied.ok).toBe(true);
		h.ledger.add("f1", T0 - 2 * HOUR);
		h.fanout.setQualified("shop", "fleet", decisionOf(fleet, mandatory), []);
		return h;
	}

	it("quorum threshold is 95% of the decision by default", () => {
		expect(quorumThreshold(undefined, 400)).toBe(380);
		expect(
			quorumThreshold(create(QuorumRecordSchema, { minQualified: 390 }), 400),
		).toBe(390);
		expect(
			quorumThreshold(
				create(QuorumRecordSchema, { minQualifiedPercent: 50 }),
				3,
			),
		).toBe(2);
		expect(quorumThreshold(undefined, 0)).toBe(1);
	});

	it("quorum 95% qualifies with 3 of 400 deferred", async () => {
		const h = await placed([]);
		for (const id of fleet.slice(3))
			h.ledger.qualify("f1", id, "shop", "fleet", T0 - HOUR);
		const prod = await h.controller.available({
			pipeline: "shop",
			node: "prod",
		});
		expect(prod.map((a) => [a.freightId, a.via])).toEqual([["f1", ["fleet"]]]);
	});

	it("does not qualify below quorum", async () => {
		const h = await placed([]);
		for (const id of fleet.slice(21))
			h.ledger.qualify("f1", id, "shop", "fleet", T0 - HOUR);
		expect(await ids(h, "prod")).toEqual([]);
	});

	it("a failed mandatory group blocks availability", async () => {
		const pilot = fleet.slice(0, 5);
		const h = await placed(pilot);
		for (const id of fleet.slice(1))
			h.ledger.qualify("f1", id, "shop", "fleet", T0 - HOUR);
		expect(await ids(h, "prod")).toEqual([]);
		h.ledger.qualify("f1", fleet[0] ?? "", "shop", "fleet", T0 - HOUR);
		expect(await ids(h, "prod")).toEqual(["f1"]);
	});

	it("no recorded decision means nothing is available downstream (fail closed)", async () => {
		const h = await placed([]);
		h.fanout.qualifiedBy.clear();
		for (const id of fleet)
			h.ledger.qualify("f1", id, "shop", "fleet", T0 - HOUR);
		expect(await ids(h, "prod")).toEqual([]);
		expect(h.store.events(CD_EVENTS.PipelineFreightAvailable)).toHaveLength(0);
	});
});
