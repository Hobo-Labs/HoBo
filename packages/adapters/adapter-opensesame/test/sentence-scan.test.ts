import { describe, expect, it } from "vitest";

import {
	createOutcomeScan,
	OWN_SENTENCES,
	parseOutcome,
} from "../src/outcome.js";
import {
	CARRY_LIMIT,
	OWN_PREFIX,
	SENTENCE_LIMIT,
	sentencesOf,
} from "../src/sentences.js";
import {
	SAMPLE_LINES,
	type SampleScenario,
} from "./fixtures/opensesame-lines.js";

const line = (scenario: SampleScenario) =>
	`${SAMPLE_LINES[scenario].join("\n")}\n`;

/** Which of OpenSesame's sentences a list of sentences holds. */
function kindsIn(sentences: readonly string[]): boolean[] {
	return OWN_SENTENCES.map((pattern) =>
		sentences.some((sentence) => pattern.test(sentence)),
	);
}

function scanned(chunks: readonly string[]): readonly string[] {
	const scan = createOutcomeScan();
	for (const chunk of chunks) scan.push(chunk);
	return scan.sentences();
}

function split(text: string, at: readonly number[]): string[] {
	const cuts = [0, ...at, text.length];
	return cuts.slice(1).map((cut, i) => text.slice(cuts[i], cut));
}

/** Small deterministic generator, so a failure repeats. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const TEXTS: readonly string[] = [
	`${line("misdirected")}`,
	`partial${line("misdirected")}`,
	`Working... 40%\r${line("sigterm")}`,
	`${line("plugin-absent")}${line("no-sealed-entry")}${line("sighup")}`,
	`a${OWN_PREFIX}b${OWN_PREFIX}${line("sigterm")}`,
	`${OWN_PREFIX}${"j".repeat(SENTENCE_LIMIT + 40)}${OWN_PREFIX}SIGHUP: the run is ended\r\n`,
	`${OWN_PREFIX}${"j".repeat(SENTENCE_LIMIT - 5)}${OWN_PREFIX}SIGTERM: the run is ended\n`,
	`opensesame:${OWN_PREFIX}surrogate.misdirected: x\nopens${OWN_PREFIX}`,
	`${"opensesame: ".repeat(40)}SIGHUP: the run is ended`,
	"no sentence at all\nonly Error: lines\n",
	// A sentence in two shapes at once (forged: OpenSesame writes none), after one that fills only the first of them.
	`${OWN_PREFIX}surrogate.misdirected: first\n${OWN_PREFIX}surrogate.misdirected: second, delivering placeholders\n`,
	`${OWN_PREFIX}SIGTERM: the run is ended\n${OWN_PREFIX}SIGTERM: the run is ended again, delivering placeholders\n`,
	`${OWN_PREFIX}SIGHUP: the run is ended\r${OWN_PREFIX}SIGHUP: the run is ended; delivering placeholders\r`,
	`${OWN_PREFIX}no surrogate for X; delivering placeholders\n${OWN_PREFIX}AWS_TOKEN will keep its placeholder; delivering placeholders\n`,
];

describe("scanning stderr as it arrives reads what reading the whole text reads", () => {
	it("whatever the chunking: every two-way split of each text", () => {
		for (const text of TEXTS) {
			const want = kindsIn(sentencesOf(text));
			for (let at = 0; at <= text.length; at += 1) {
				const got = scanned([text.slice(0, at), text.slice(at)]);
				expect(
					kindsIn(got),
					`${JSON.stringify(text.slice(0, 40))} at ${at}`,
				).toEqual(want);
			}
		}
	});

	it("whatever the chunking: one character at a time, and random cuts", () => {
		const next = random(7);
		for (const text of TEXTS) {
			const want = kindsIn(sentencesOf(text));
			expect(kindsIn(scanned([...text])), "one at a time").toEqual(want);
			for (let round = 0; round < 40; round += 1) {
				const cuts = Array.from({ length: 1 + Math.floor(next() * 8) }, () =>
					Math.floor(next() * text.length),
				).sort((a, b) => a - b);
				expect(kindsIn(scanned(split(text, cuts))), cuts.join(",")).toEqual(
					want,
				);
			}
		}
	});

	it("and so reads the same outcome from the scan's sentences as from the whole text, at every status", () => {
		for (const text of TEXTS) {
			for (const status of [0, 1, 77, 129, 143]) {
				expect(
					parseOutcome(status, null, text, scanned([...text])),
					`${JSON.stringify(text.slice(0, 50))} at ${status}`,
				).toEqual(parseOutcome(status, null, text));
			}
		}
	});

	it("keeps only text that is in the stream, cut as the whole-text reading cuts it", () => {
		for (const text of TEXTS) {
			const whole = sentencesOf(text);
			for (const sentence of scanned([...text])) {
				expect(
					whole.some((s) => s.startsWith(sentence)),
					sentence,
				).toBe(true);
				expect(sentence.length).toBeLessThanOrEqual(SENTENCE_LIMIT);
			}
		}
	});
});

describe("what the scan keeps is bounded, and a flood cannot push a sentence out of it", () => {
	const NOISE = `${OWN_PREFIX}nothing OpenSesame says ${"y".repeat(60)}\n`;
	const FORGED = `${OWN_PREFIX}SIGHUP: the run is ended (forged)\n`;

	it("holds at most one sentence per kind, each within the limit, after a million lines", () => {
		const scan = createOutcomeScan();
		scan.push(line("misdirected"));
		const chunk = (NOISE + FORGED).repeat(500);
		for (let round = 0; round < 40; round += 1) scan.push(chunk);
		const kept = scan.sentences();
		expect(kept.length).toBeLessThanOrEqual(OWN_SENTENCES.length);
		for (const sentence of kept) {
			expect(sentence.length).toBeLessThanOrEqual(SENTENCE_LIMIT);
		}
		expect(kept.some((s) => s.startsWith("surrogate.misdirected: "))).toBe(
			true,
		);
		expect(kept.some((s) => s.startsWith("SIGHUP: "))).toBe(true);
	});

	it("a real sentence that arrives after the flood is kept beside the forged kind", () => {
		const scan = createOutcomeScan();
		scan.push((NOISE + FORGED).repeat(20_000));
		scan.push(line("sigterm"));
		expect(kindsIn(scan.sentences())).toEqual(
			OWN_SENTENCES.map((pattern) =>
				[line("sigterm"), FORGED].some((text) =>
					pattern.test(text.slice(OWN_PREFIX.length)),
				),
			),
		);
	});

	it("an unfinished sentence at the end of the stream counts, as the end of the text ends a line", () => {
		const text = `child${OWN_PREFIX}SIGTERM: the run is ended and its surrogates are revoked (1); the child is sto`;
		expect(kindsIn(scanned([...text]))).toEqual(kindsIn(sentencesOf(text)));
		expect(kindsIn(scanned([...text])).some(Boolean)).toBe(true);
	});

	it("carries at most a window between chunks, however long the unterminated line it is in the middle of", () => {
		for (const size of [1, 7, 100, 513, 5000]) {
			const scan = createOutcomeScan();
			let most = 0;
			scan.push(`child text ${OWN_PREFIX}`);
			for (let sent = 0; sent < 200_000; sent += size) {
				scan.push("z".repeat(size));
				most = Math.max(most, scan.held());
			}
			expect(most, `chunks of ${size}`).toBeLessThanOrEqual(CARRY_LIMIT);
		}
	});

	it("reads a large chunk of repeated prefixes and keeps nothing of it", () => {
		const hostile = OWN_PREFIX.repeat(100_000);
		const scan = createOutcomeScan();
		scan.push(hostile);
		scan.push(`${hostile}\n${hostile}`);
		expect(scan.sentences()).toEqual([]);
	});
});
