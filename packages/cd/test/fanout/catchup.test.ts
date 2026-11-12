// D21 late entry: a Camp that recovers converges to the node's *current*
// qualified Freight, never to an older fan-out's Freight.
import { describe, expect, it } from "vitest";
import { FanoutState } from "../../src/_generated/cd_pb.js";
import type { FanoutId } from "../../src/ports.js";
import { decisionOf, FREIGHT, fanoutOf, healthy } from "./fakes.js";
import { addCamps, drive, freightB, harness, startInput } from "./harness.js";

describe("fan-out late entry (MATCH_NODE)", () => {
	it("a Camp deferred by two runs catches up only to the newest run's Freight", async () => {
		const h = harness();
		const decision = decisionOf(6, 3);
		addCamps(h, decision);
		h.inventory.setStatus("c004", healthy("c004", [], false));
		const first = await h.controller.start(
			startInput(decision, fanoutOf()),
			h.ctx,
		);
		if (!first.ok) throw new Error("start refused");
		await drive(h);
		const second = await h.controller.start(
			startInput(decision, fanoutOf(), { freightId: freightB }),
			h.ctx,
		);
		if (!second.ok) throw new Error("start refused");
		await drive(h);
		expect(
			(await h.controller.get(second.value.fanoutId as FanoutId))?.state,
		).toBe(FanoutState.COMPLETED);

		h.inventory.setStatus("c004", healthy("c004"));
		await drive(h);
		const toC004 = h.promotions.calls.filter(
			(c) => c.request.targets[0] === "c004",
		);
		expect(toC004.map((c) => c.request.freightId)).toEqual([freightB]);
		expect(toC004.some((c) => c.request.freightId === FREIGHT)).toBe(false);
		const q = await h.controller.qualified({ pipeline: "web", node: "prod" });
		expect(q.stableFreightId).toBe(freightB);
		expect(q.qualifiedCampIds).toContain("c004");
	});
});
