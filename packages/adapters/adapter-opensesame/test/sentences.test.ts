import { describe, expect, it } from "vitest";

import {
	OWN_PREFIX,
	SENTENCE_LIMIT,
	sentencesOf,
	sentenceWindows,
} from "../src/sentences.js";

type Window = readonly [number, number];

const total = (windows: readonly Window[]) =>
	windows.reduce((sum, [from, end]) => sum + (end - from), 0);

/** The windows as they were before the perf fix: a full SENTENCE_LIMIT after every prefix, however close the next one is. */
function overlapping(text: string): Window[] {
	const out: Window[] = [];
	for (
		let at = text.indexOf(OWN_PREFIX);
		at >= 0;
		at = text.indexOf(OWN_PREFIX, at + OWN_PREFIX.length)
	) {
		const from = at + OWN_PREFIX.length;
		out.push([from, Math.min(from + SENTENCE_LIMIT, text.length)]);
	}
	return out;
}

const REPEATED = OWN_PREFIX.repeat(10_000);
// A prefix every 17 characters: each window is cut short by the next prefix, and they all overlap in the old reading.
const CLOSE = `${OWN_PREFIX}xxxxx`.repeat(10_000);
const TEXTS: readonly [string, string][] = [
	["a prefix repeated, back to back", `${REPEATED}\n${REPEATED}`],
	["a prefix every 17 characters", CLOSE],
	[
		"prefixes a window apart",
		`${OWN_PREFIX}${"y".repeat(SENTENCE_LIMIT)}`.repeat(200),
	],
	["one long line after the prefix", `${OWN_PREFIX}${"z".repeat(100_000)}`],
	["no prefix at all", "z".repeat(100_000)],
];

describe("the windows OpenSesame's sentences are read in", () => {
	for (const [label, text] of TEXTS) {
		it(`sum to at most the text and never overlap, so each character is read once: ${label}`, () => {
			const windows = sentenceWindows(text);
			expect(total(windows)).toBeLessThanOrEqual(text.length);
			let after = 0;
			for (const [from, end] of windows) {
				expect(from).toBeGreaterThanOrEqual(after);
				expect(end - from).toBeLessThanOrEqual(SENTENCE_LIMIT);
				after = end;
			}
		});
	}

	it("a repeated prefix costs one character-read each, not a full window each (the check fails for the overlapping reading)", () => {
		expect(total(sentenceWindows(CLOSE))).toBeLessThanOrEqual(CLOSE.length);
		expect(total(overlapping(CLOSE))).toBeGreaterThan(CLOSE.length * 10);
		expect(total(overlapping(REPEATED))).toBeGreaterThan(REPEATED.length * 10);
	});

	it("each sentence is the first line of its window, cut at the next prefix or the limit", () => {
		expect(
			sentencesOf(
				`x${OWN_PREFIX}one\ntwo${OWN_PREFIX}three${OWN_PREFIX}four\rfive`,
			),
		).toEqual(["one", "three", "four"]);
		expect(
			sentencesOf(`${OWN_PREFIX}${"a".repeat(SENTENCE_LIMIT + 9)}`),
		).toEqual(["a".repeat(SENTENCE_LIMIT)]);
		expect(sentencesOf("no prefix here")).toEqual([]);
	});
});
