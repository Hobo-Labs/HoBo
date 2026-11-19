import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	assertCorpusReplayEqualsLive,
	parseReplayCorpus,
	type ReplayCorpus,
} from "../src/index.ts";

const corpusDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../corpus/replay",
);

function loadCorpus(id: string): ReplayCorpus {
	return parseReplayCorpus(
		JSON.parse(readFileSync(join(corpusDir, `${id}.json`), "utf8")),
	);
}

describe("replay==live production corpus (S1-16)", () => {
	it("commits at least one corpus case (recorded from hello-bindle)", () => {
		const files = readdirSync(corpusDir).filter((name) =>
			name.endsWith(".json"),
		);
		expect(files.length).toBeGreaterThanOrEqual(2);
	});

	it("replays repeated greetings in their stream order", () => {
		const corpus = loadCorpus("hello-bindle-repeated-greetings");
		const result = assertCorpusReplayEqualsLive(corpus);
		expect(result.liveState.served.map((entry) => entry.name)).toEqual([
			"HoBo",
			"world",
			"HoBo",
		]);
		expect(result.report.stateDigest).toBe(corpus.expected.stateDigest);
	});

	it("rebuild-from-zero (replay) equals live byte-for-byte for the greeting corpus", () => {
		const corpus = loadCorpus("hello-bindle-greetings");
		const result = assertCorpusReplayEqualsLive(corpus);

		expect(result.digestMatches).toBe(true);
		expect(result.report.stateDigest).toBe(corpus.expected.stateDigest);
		expect(result.report.mode).toBe("replay");
		expect(result.liveState.count).toBe(2);
	});

	it("detects corpus tampering: a mutated event body breaks the golden digest", () => {
		const corpus = loadCorpus("hello-bindle-greetings");
		const tampered: ReplayCorpus = {
			...corpus,
			events: corpus.events.map((event, index) =>
				index === corpus.events.length - 1
					? {
							...event,
							// SAFETY: assertion to `event.data as object` is required at this boundary.
							data: { ...(event.data as object), message: "mutated" },
						}
					: event,
			),
		};

		expect(() => assertCorpusReplayEqualsLive(tampered)).toThrow(
			/live digest .* != committed/,
		);
	});
});
