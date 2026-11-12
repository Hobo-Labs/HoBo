// data-models/failover.cue and the failover controller must agree: every
// failover and rebalance body the controller records vets clean.
import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FailoverPolicyRecordSchema,
	FailoverRecordSchema,
	FailoverState,
	PurgeMode,
	RebalanceMoveRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { cue, vetter } from "../fanout/cue-support.js";
import { failoverScenario } from "./scenario.js";

const vets = vetter("failover.cue");

const DEFINITION: Readonly<Record<string, string>> = {
	[CD_EVENTS.FailoverProposed]: "#FailoverBody",
	[CD_EVENTS.FailoverStarted]: "#FailoverBody",
	[CD_EVENTS.FailoverProgressed]: "#FailoverBody",
	[CD_EVENTS.FailoverCompleted]: "#FailoverBody",
	[CD_EVENTS.FailoverRefused]: "#FailoverBody",
	[CD_EVENTS.RebalanceRequested]: "#RebalanceRequestedBody",
};

describe.skipIf(cue === undefined)(
	"failover.cue agrees with the failover controller (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets every failover and rebalance body the scenario journals", async () => {
			const s = await failoverScenario();
			const seen = new Set<string>();
			for (const event of s.h.store.journal()) {
				const definition = DEFINITION[event.type];
				if (definition === undefined) continue;
				seen.add(event.type);
				const result = vets(definition, event.data);
				expect(
					result.error,
					`${event.type} ${JSON.stringify(event.data).slice(0, 300)}`,
				).toBe("");
			}
			expect([...seen].sort()).toEqual(Object.keys(DEFINITION).sort());
		}, 60_000);

		it("refuses a self-move, a started failover without a replacement, and secret-shaped handover names", () => {
			expect(
				vets(
					"#RebalanceMoveRecord",
					toJson(
						RebalanceMoveRecordSchema,
						create(RebalanceMoveRecordSchema, {
							fromCampId: "a",
							toCampId: "a",
						}),
					),
				).ok,
			).toBe(false);
			const started = create(FailoverRecordSchema, {
				failoverId: `failover-${"0".repeat(32)}`,
				pipeline: "web",
				node: "prod",
				fromCampId: "a",
				state: FailoverState.REPLACING,
				purge: PurgeMode.GRACEFUL,
				updatedAt: "2026-11-12T12:00:00.000Z",
			});
			expect(
				vets("#FailoverRecord", toJson(FailoverRecordSchema, started)).ok,
			).toBe(false);
			const complete = create(FailoverRecordSchema, {
				...started,
				toCampId: "b",
				freightId: "sha256:aa",
				promotionId: "prm-1",
			});
			expect(
				vets("#FailoverRecord", toJson(FailoverRecordSchema, complete)).ok,
			).toBe(true);
			const policy = create(FailoverPolicyRecordSchema, {
				handoverOutputs: ["db password=hunter2"],
			});
			expect(
				vets(
					"#FailoverPolicyRecord",
					toJson(FailoverPolicyRecordSchema, policy),
				).ok,
			).toBe(false);
		});
	},
);
