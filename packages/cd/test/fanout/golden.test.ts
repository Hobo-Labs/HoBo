// Golden upcaster corpus for the fan-out event bodies (§1 "Every new event
// body has a golden upcaster corpus entry"). The corpus pins v1 bodies: the
// scenario must keep writing them byte-for-byte, and every corpus body must
// keep parsing (an incompatible change needs an upcaster, not a silent edit).
// Regenerate deliberately with UPDATE_GOLDEN=1.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { CD_EVENTS } from "../../src/events.js";
import {
	parseDeparted,
	parseHalted,
	parseProgressed,
	parseResumed,
	parseStarted,
	parseStatusFact,
} from "../../src/fanout/facts.js";
import { isJsonObject, jsonString } from "../../src/fanout/journal.js";
import { maybeWriteCorpus, readCorpus } from "./corpus.js";
import { fanoutScenario } from "./scenario.js";

const CORPUS = join(
	dirname(fileURLToPath(import.meta.url)),
	"golden",
	"fanout-events.v1.json",
);

/** Whether a body of `type` parses with the current fact parsers. */
const PARSES = new Map<string, (data: JsonValue) => boolean>([
	[CD_EVENTS.FanoutStarted, (data) => parseStarted(data) !== undefined],
	[CD_EVENTS.FanoutProgressed, (data) => parseProgressed(data) !== undefined],
	[CD_EVENTS.FanoutHalted, (data) => parseHalted(data) !== undefined],
	[CD_EVENTS.FanoutResumed, (data) => parseResumed(data) !== undefined],
	[CD_EVENTS.FanoutCompleted, (data) => parseStatusFact(data).atMs > 0],
	[CD_EVENTS.FanoutRolledBack, (data) => parseStatusFact(data).atMs > 0],
	[CD_EVENTS.CampDeparted, (data) => parseDeparted(data) !== undefined],
]);

function corpusKey(type: string, data: JsonValue): string {
	const outcome = isJsonObject(data) ? jsonString(data.outcome) : "";
	return outcome === "" ? type : `${type}:${outcome}`;
}

describe("fan-out golden upcaster corpus", () => {
	it("the scenario writes exactly the pinned v1 bodies, and each parses", async () => {
		const h = await fanoutScenario();
		const current = new Map<string, JsonValue>();
		for (const event of h.store.journal()) {
			if (!PARSES.has(event.type)) continue;
			const key = corpusKey(event.type, event.data);
			if (!current.has(key)) current.set(key, event.data);
		}
		maybeWriteCorpus(CORPUS, current);
		const pinned = readCorpus(CORPUS);
		expect(Object.fromEntries(current)).toEqual(Object.fromEntries(pinned));
		for (const [key, body] of pinned) {
			const parses = PARSES.get(key.split(":")[0] ?? "");
			expect(parses?.(body), key).toBe(true);
		}
	});
});
