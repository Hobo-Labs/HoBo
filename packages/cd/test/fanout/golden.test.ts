// Golden upcaster corpus for the fan-out event bodies (§1 "Every new event
// body has a golden upcaster corpus entry"). The corpus pins v1 bodies: the
// scenario must keep writing them byte-for-byte, and every corpus body must
// keep parsing (an incompatible change needs an upcaster, not a silent edit).
// Regenerate deliberately with UPDATE_GOLDEN=1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { fanoutScenario } from "./scenario.js";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "golden", "fanout-events.v1.json");

const PARSERS: Readonly<Record<string, (data: unknown) => unknown>> = {
	[CD_EVENTS.FanoutStarted]: parseStarted,
	[CD_EVENTS.FanoutProgressed]: parseProgressed,
	[CD_EVENTS.FanoutHalted]: parseHalted,
	[CD_EVENTS.FanoutResumed]: parseResumed,
	[CD_EVENTS.FanoutCompleted]: parseStatusFact,
	[CD_EVENTS.FanoutRolledBack]: parseStatusFact,
	[CD_EVENTS.CampDeparted]: parseDeparted,
};

function corpusKey(type: string, data: unknown): string {
	const outcome = typeof data === "object" && data !== null && "outcome" in data ? `:${String(data.outcome)}` : "";
	return `${type}${outcome}`;
}

describe("fan-out golden upcaster corpus", () => {
	it("the scenario writes exactly the pinned v1 bodies, and each parses", async () => {
		const h = await fanoutScenario();
		const current: Record<string, unknown> = {};
		for (const event of h.store.journal()) {
			if (PARSERS[event.type] === undefined) continue;
			const key = corpusKey(event.type, event.data);
			if (!(key in current)) current[key] = event.data;
		}
		if (process.env.UPDATE_GOLDEN === "1") {
			mkdirSync(dirname(CORPUS), { recursive: true });
			writeFileSync(CORPUS, `${JSON.stringify(current, null, "\t")}\n`);
		}
		const pinned = JSON.parse(readFileSync(CORPUS, "utf8")) as Record<string, unknown>;
		expect(current).toEqual(pinned);
		for (const [key, body] of Object.entries(pinned)) {
			const type = key.split(":")[0] ?? "";
			const parse = PARSERS[type];
			expect(parse, key).toBeDefined();
			expect(parse?.(body), key).toBeDefined();
		}
	});
});
