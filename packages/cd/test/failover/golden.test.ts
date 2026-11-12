// Golden upcaster corpus for the failover and rebalance event bodies. The
// corpus pins v1 bodies; every corpus body must keep parsing. Regenerate
// deliberately with UPDATE_GOLDEN=1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RebalanceRecordSchema } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { parseFailoverFact } from "../../src/fanout/facts.js";
import { decode } from "../../src/fanout/journal.js";
import { failoverScenario } from "./scenario.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");
const CORPUS = join(DIR, "failover-events.v1.json");

const PARSERS: Readonly<Record<string, (data: unknown) => unknown>> = {
	[CD_EVENTS.FailoverProposed]: parseFailoverFact,
	[CD_EVENTS.FailoverStarted]: parseFailoverFact,
	[CD_EVENTS.FailoverProgressed]: parseFailoverFact,
	[CD_EVENTS.FailoverCompleted]: parseFailoverFact,
	[CD_EVENTS.FailoverRefused]: parseFailoverFact,
	[CD_EVENTS.RebalanceRequested]: (data) =>
		decode(RebalanceRecordSchema, (data as { rebalance?: never }).rebalance),
};

describe("failover golden upcaster corpus", () => {
	it("the scenario writes exactly the pinned v1 bodies, and each parses", async () => {
		const s = await failoverScenario();
		const current: Record<string, unknown> = {};
		for (const event of s.h.store.journal()) {
			if (PARSERS[event.type] === undefined) continue;
			if (!(event.type in current)) current[event.type] = event.data;
		}
		mkdirSync(DIR, { recursive: true });
		if (process.env.UPDATE_GOLDEN === "1")
			writeFileSync(CORPUS, `${JSON.stringify(current, null, "\t")}\n`);
		const pinned = JSON.parse(readFileSync(CORPUS, "utf8")) as Record<string, unknown>;
		expect(current).toEqual(pinned);
		for (const [type, body] of Object.entries(pinned)) expect(PARSERS[type]?.(body), type).toBeDefined();
	});
});
