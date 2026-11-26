// The placed-node reader resolves governed Camps from a recorded decision (D21).
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FanoutStatusRecordSchema,
	PlacementDecisionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import type { FanoutId } from "../../src/ports.js";
import { campsOfDecision, placedCampsFrom } from "../../src/promotion/index.js";

const asFanoutId = (id: string): FanoutId =>
	// SAFETY: test fixture ids are literal fan-out ids; the reader under test
	// only compares them by string equality.
	id as FanoutId;

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
				fanoutId: asFanoutId("fo-1"),
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
				fanoutId: asFanoutId("fo-2"),
			}),
		).toBeUndefined();
		expect(
			await read({
				pipeline: "fleet",
				node: "prod",
				fanoutId: asFanoutId("fo-x"),
			}),
		).toBeUndefined();
		expect(await read({ pipeline: "other", node: "prod" })).toBeUndefined();
	});
});
