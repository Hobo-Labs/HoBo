// data-models/fanout.cue and the fan-out parse boundary must agree: every body
// the controller records vets clean, and what parseFanoutPlan refuses on the
// record alone, CUE refuses.
import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { FanoutRecordSchema, FanoutStrategy } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { parseFanoutPlan } from "../../src/fanout/index.js";
import { cue, vetter } from "./cue-support.js";
import { decisionOf } from "./fakes.js";
import { fanoutScenario } from "./scenario.js";

const vets = vetter("fanout.cue");

const DEFINITION: Readonly<Record<string, string>> = {
	[CD_EVENTS.FanoutStarted]: "#FanoutStartedBody",
	[CD_EVENTS.FanoutProgressed]: "#FanoutProgressedBody",
	[CD_EVENTS.FanoutHalted]: "#FanoutHaltedBody",
	[CD_EVENTS.FanoutResumed]: "#FanoutResumedBody",
	[CD_EVENTS.FanoutCompleted]: "#FanoutStatusBody",
	[CD_EVENTS.FanoutRolledBack]: "#FanoutStatusBody",
	[CD_EVENTS.CampDeparted]: "#CampDepartedBody",
};

describe.skipIf(cue === undefined)(
	"fanout.cue agrees with the fan-out controller (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets every event body the scenario journals, one of each type at least", async () => {
			const h = await fanoutScenario();
			const seen = new Set<string>();
			const outcomes = new Set<string>();
			for (const event of h.store.journal()) {
				const definition = DEFINITION[event.type];
				if (definition === undefined) continue;
				seen.add(event.type);
				if (event.type === CD_EVENTS.FanoutProgressed)
					outcomes.add(String((event.data as { outcome: string }).outcome));
				const result = vets(definition, event.data);
				expect(result.error, `${event.type} ${JSON.stringify(event.data).slice(0, 300)}`).toBe("");
			}
			expect([...seen].sort()).toEqual(Object.keys(DEFINITION).sort());
			expect([...outcomes].sort()).toEqual(
				["bound", "deferred", "failed", "requested", "rolled-back", "succeeded", "supersede-requested"].sort(),
			);
		}, 60_000);

		it("refuses what the parse boundary refuses on the record alone", () => {
			const decision = decisionOf(10, 5);
			const cases = [
				{ maxConcurrency: 2, maxConcurrencyPercent: 10 },
				{ maxFailures: 1, maxFailuresPercent: 5 },
				{ maxFailuresPercent: 101 },
				{ maxConcurrencyPercent: 150 },
			];
			for (const fields of cases) {
				const record = create(FanoutRecordSchema, { strategy: FanoutStrategy.PROGRESSIVE, ...fields });
				expect(parseFanoutPlan({ pipeline: "web", node: "prod", decision, fanout: record }).ok).toBe(false);
				expect(vets("#FanoutRecord", toJson(FanoutRecordSchema, record)).ok).toBe(false);
			}
			const good = create(FanoutRecordSchema, { strategy: FanoutStrategy.PROGRESSIVE, maxConcurrencyPercent: 20, maxFailures: 2 });
			expect(parseFanoutPlan({ pipeline: "web", node: "prod", decision, fanout: good }).ok).toBe(true);
			expect(vets("#FanoutRecord", toJson(FanoutRecordSchema, good)).ok).toBe(true);
		});
	},
);
