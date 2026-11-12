// The placed-node reader resolves governed Camps from a recorded decision (D21).
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FanoutStatusRecordSchema,
	PlacementDecisionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import type { FanoutId } from "../../src/ports.js";
import { campsOfDecision, placedCampsFrom } from "../../src/promotion/index.js";

const decision = (id: string, node = "prod") =>
	create(PlacementDecisionRecordSchema, {
		decisionId: id,
		pipeline: "fleet",
		node,
		groups: [{ name: "a", index: 0, campIds: ["c-2", "c-1"] }],
		candidates: [
			{ campId: "c-3", selected: true },
			{ campId: "c-9", selected: false },
		],
	});

describe("placedCampsFrom", () => {
	const decisions = new Map([
		["dec-fo", decision("dec-fo")],
		["dec-other", decision("dec-other", "staging")],
	]);
	const reader = (latest = decision("dec-latest")) =>
		placedCampsFrom({
			fanout: {
				async get(id) {
					return create(FanoutStatusRecordSchema, {
						fanoutId: id,
						decisionId:
							id === "fo-1" ? "dec-fo" : id === "fo-2" ? "dec-other" : "",
					});
				},
				async qualified() {
					return { decision: latest, qualifiedCampIds: [] };
				},
			},
			placement: {
				async decision(id) {
					return decisions.get(id);
				},
			},
		});

	it("selects group Camps and selected candidates only", () => {
		expect(campsOfDecision(decision("d"))).toEqual(["c-1", "c-2", "c-3"]);
	});

	it("reads the fan-out's decision, else the node's latest", async () => {
		const read = reader();
		expect(
			await read({
				pipeline: "fleet",
				node: "prod",
				fanoutId: "fo-1" as FanoutId,
			}),
		).toEqual(["c-1", "c-2", "c-3"]);
		expect(await read({ pipeline: "fleet", node: "prod" })).toEqual([
			"c-1",
			"c-2",
			"c-3",
		]);
	});

	it("fails closed on a missing or mismatched decision", async () => {
		const read = reader();
		expect(
			await read({
				pipeline: "fleet",
				node: "prod",
				fanoutId: "fo-2" as FanoutId,
			}),
		).toBeUndefined();
		expect(
			await read({
				pipeline: "fleet",
				node: "prod",
				fanoutId: "fo-x" as FanoutId,
			}),
		).toBeUndefined();
		expect(await read({ pipeline: "other", node: "prod" })).toBeUndefined();
	});
});
