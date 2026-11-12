// Golden upcaster corpus for the failover and rebalance event bodies. The
// corpus pins v1 bodies; every corpus body must keep parsing. Regenerate
// deliberately with UPDATE_GOLDEN=1.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { RebalanceRecordSchema } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { parseFailoverFact } from "../../src/fanout/facts.js";
import { decode, jsonObject } from "../../src/fanout/journal.js";
import { maybeWriteCorpus, readCorpus } from "../fanout/corpus.js";
import { failoverScenario } from "./scenario.js";

const CORPUS = join(
	dirname(fileURLToPath(import.meta.url)),
	"golden",
	"failover-events.v1.json",
);

const failoverParses = (data: JsonValue) =>
	parseFailoverFact(data) !== undefined;

/** Whether a body of `type` parses with the current parsers. */
const PARSES = new Map<string, (data: JsonValue) => boolean>([
	[CD_EVENTS.FailoverProposed, failoverParses],
	[CD_EVENTS.FailoverStarted, failoverParses],
	[CD_EVENTS.FailoverProgressed, failoverParses],
	[CD_EVENTS.FailoverCompleted, failoverParses],
	[CD_EVENTS.FailoverRefused, failoverParses],
	[
		CD_EVENTS.RebalanceRequested,
		(data) =>
			decode(RebalanceRecordSchema, jsonObject(data).rebalance) !== undefined,
	],
]);

describe("failover golden upcaster corpus", () => {
	it("the scenario writes exactly the pinned v1 bodies, and each parses", async () => {
		const s = await failoverScenario();
		const current = new Map<string, JsonValue>();
		for (const event of s.h.store.journal()) {
			if (!PARSES.has(event.type)) continue;
			if (!current.has(event.type)) current.set(event.type, event.data);
		}
		maybeWriteCorpus(CORPUS, current);
		const pinned = readCorpus(CORPUS);
		expect(Object.fromEntries(current)).toEqual(Object.fromEntries(pinned));
		for (const [type, body] of pinned)
			expect(PARSES.get(type)?.(body), type).toBe(true);
	});
});
