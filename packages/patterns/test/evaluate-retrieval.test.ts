/**
 * The retrieval evaluation harness.
 *
 * This is the thing that says whether pattern search is any good, so its own
 * arithmetic has to be right — a harness that over-reports is worse than no
 * harness, because it converts "search regressed" into "search is fine".
 *
 * Two properties carry that.
 *
 * **Abstention is scored separately from recall.** A case that expects search to
 * find *nothing* is not a retrieval success or failure; it is a different
 * question — did search correctly decline? Folding abstain cases into the recall
 * denominator would let a corpus of mostly-abstain cases report high recall for
 * a search that never found anything.
 *
 * **Empty denominators are answered, not divided.** Recall over zero scored
 * cases is `0` and abstain precision over zero abstain cases is `1` — both
 * chosen so an eval with no cases of one kind does not produce `NaN`, which
 * compares false against every threshold and would silently pass a gate.
 */
import { describe, expect, it } from "vitest";

import { loadPatternCatalog } from "../src/index.js";
import { evaluatePatternRetrieval, parseEvalCases } from "../src/validate.js";
import { buildHoboVocabulary } from "../src/vocabulary.js";

const catalog = loadPatternCatalog();
const vocabulary = buildHoboVocabulary();

function evaluate(cases: readonly unknown[]) {
	return evaluatePatternRetrieval({
		catalog,
		vocabulary,
		cases: cases as never,
	});
}

/** A query the catalog genuinely answers, and the id it should return first. */
const REAL_QUERY = "add an api resource to a bindle";

describe("evaluatePatternRetrieval", () => {
	it("counts every case it was given", () => {
		// The case count is the corpus size, not the scored size. Reporting the
		// scored count would hide that abstain cases existed at all.
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{ id: "b", query: "zzz nothing", expectedIds: [], expectAbstain: true },
		]);
		expect(report.cases).toBe(2);
	});

	it("scores recall at 1 only when the expected id came back first", () => {
		// Recall@1 is the strict measure: the top hit is what a caller acts on
		// without reading further, so a correct answer in second place is not the
		// same result.
		const good = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
		]);
		const bad = evaluate([
			{
				id: "a",
				query: REAL_QUERY,
				expectedIds: ["pattern.that.never.exists"],
			},
		]);
		expect(good.recallAt1).toBeGreaterThan(bad.recallAt1);
		expect(bad.recallAt1).toBe(0);
	});

	it("scores recall at 3 when any expected id is in the top three", () => {
		// The looser measure, for a caller that shows a short list. It has to be
		// at least as generous as recall@1 by construction — a corpus where
		// recall@3 came out lower would mean the arithmetic is wrong.
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
		]);
		expect(report.recallAt3).toBeGreaterThanOrEqual(report.recallAt1);
	});

	it("accepts any of several expected ids for recall at 3", () => {
		// A query with more than one defensible answer should not be scored as a
		// miss because search picked the other good one.
		const report = evaluate([
			{
				id: "a",
				query: REAL_QUERY,
				expectedIds: ["pattern.that.never.exists", "bindle.resource.api"],
			},
		]);
		expect(report.recallAt3).toBe(1);
	});

	it("ignores an expected-id list that is empty on a scored case", () => {
		// `expectedIds[0] &&` — a scored case with no expectation cannot be a
		// recall@1 hit. Treating a missing expectation as satisfied would inflate
		// the score for cases nobody finished writing.
		const report = evaluate([{ id: "a", query: REAL_QUERY, expectedIds: [] }]);
		expect(report.recallAt1).toBe(0);
		expect(report.recallAt3).toBe(0);
	});

	it("scores an abstain case by whether search declined", () => {
		// The abstain question is the opposite of the recall one: success is
		// *not* selecting anything. A search that always answered would score
		// zero here even while scoring well on recall.
		const report = evaluate([
			{
				id: "a",
				query: "zzzznotawordinanypattern",
				expectedIds: [],
				expectAbstain: true,
			},
		]);
		expect(report.abstainPrecision).toBe(1);
	});

	it("counts a failed abstention against precision", () => {
		// A query search does commit to, marked as expecting abstention: it
		// selects, so precision drops. This is the arm that makes the measure
		// able to fail at all.
		//
		// The query has to be an exact pattern id, which is itself worth
		// recording: search is markedly conservative about *selecting*. It ranks
		// `bindle.resource.api` first for "add an api resource to a bindle" and
		// still abstains — `selectedId` stays empty while `candidates` is
		// populated. So the two measures here read different fields on purpose,
		// and a natural-language query cannot be used to exercise a failed
		// abstention at all.
		const report = evaluate([
			{
				id: "a",
				query: "bindle.resource.api",
				expectedIds: [],
				expectAbstain: true,
			},
		]);
		expect(report.abstainPrecision).toBe(0);
	});

	it("abstains from selecting even when it ranks the right pattern first", () => {
		// The conservatism above, asserted directly rather than left implicit in
		// the test that depends on it. Recall and abstention are measuring
		// different things — `candidates` versus `selectedId` — and a reader who
		// assumed a top-ranked hit implies a selection would misread every
		// abstain score in this file.
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: [], expectAbstain: true },
		]);
		expect(report.abstainPrecision).toBe(1);
	});

	it("keeps abstain cases out of the recall denominator", () => {
		// The property that makes both numbers meaningful. One scored case that
		// hits, alongside any number of abstain cases, must still be recall 1.0 —
		// otherwise a mostly-abstain corpus would report search as failing when
		// it is doing exactly what was asked.
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{ id: "b", query: "zzz1", expectedIds: [], expectAbstain: true },
			{ id: "c", query: "zzz2", expectedIds: [], expectAbstain: true },
		]);
		expect(report.recallAt1).toBe(1);
		expect(report.cases).toBe(3);
	});

	it("keeps scored cases out of the abstain denominator", () => {
		// The mirror image. A corpus of scored cases with one abstain case must
		// report abstain precision from that one case alone.
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{ id: "b", query: "zzzznotaword", expectedIds: [], expectAbstain: true },
		]);
		expect(report.abstainPrecision).toBe(1);
	});

	it("answers zero recall for a corpus with nothing to score", () => {
		// Not NaN. A NaN compares false against every threshold, so a gate
		// checking `recall >= 0.8` would *pass* on a corpus that scored nothing —
		// the exact failure mode a harness must not have.
		const report = evaluate([
			{ id: "a", query: "zzz", expectedIds: [], expectAbstain: true },
		]);
		expect(report.recallAt1).toBe(0);
		expect(report.recallAt3).toBe(0);
		expect(Number.isNaN(report.recallAt1)).toBe(false);
	});

	it("answers perfect abstain precision for a corpus with no abstain cases", () => {
		// `1` rather than `0` or NaN: a corpus that asked no abstain questions has
		// no abstain failures, and reporting zero would make an unrelated gate
		// fail for a reason that does not exist.
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
		]);
		expect(report.abstainPrecision).toBe(1);
	});

	it("answers an empty corpus without dividing by zero", () => {
		const report = evaluate([]);
		expect(report.cases).toBe(0);
		expect(report.recallAt1).toBe(0);
		expect(report.recallAt3).toBe(0);
		expect(report.abstainPrecision).toBe(1);
	});

	it("reports elapsed time as a non-negative number", () => {
		// The eval is a gate in CI, so how long it took is worth recording — and
		// a negative or NaN elapsed would be a tell that the clock was read in
		// the wrong order.
		const report = evaluate([]);
		expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(report.elapsedMs)).toBe(true);
	});

	it("produces a recall between zero and one", () => {
		// A ratio outside its range would mean the numerator counted something
		// the denominator did not — the classic way a scoring bug reports better
		// than perfect.
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{
				id: "b",
				query: "kv resource",
				expectedIds: ["bindle.resource.kv-read-write"],
			},
			{ id: "c", query: "zzz", expectedIds: [], expectAbstain: true },
		]);
		for (const value of [
			report.recallAt1,
			report.recallAt3,
			report.abstainPrecision,
		]) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(1);
		}
	});

	it("is deterministic for the same corpus", () => {
		// The eval gates merges. A score that moved between runs would make the
		// gate flaky and, worse, teach everyone to re-run it until it passed.
		const cases = [
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{ id: "b", query: "zzz", expectedIds: [], expectAbstain: true },
		];
		const first = evaluate(cases);
		const second = evaluate(cases);
		expect(first.recallAt1).toBe(second.recallAt1);
		expect(first.recallAt3).toBe(second.recallAt3);
		expect(first.abstainPrecision).toBe(second.abstainPrecision);
	});
});

describe("parseEvalCases", () => {
	it("reads one case per JSONL line", () => {
		const cases = parseEvalCases(
			[
				'{"id":"a","query":"one","expectedIds":["x"]}',
				'{"id":"b","query":"two","expectedIds":["y"]}',
			].join("\n"),
		);
		expect(cases).toHaveLength(2);
		expect(cases[0]?.query).toBe("one");
	});

	it("skips blank lines rather than failing on them", () => {
		// A trailing newline is normal in a file, and a corpus that failed to
		// parse because of one would be maddening to debug.
		expect(
			parseEvalCases('\n{"id":"a","query":"one","expectedIds":["x"]}\n\n\n'),
		).toHaveLength(1);
	});

	it("returns nothing for an empty corpus", () => {
		expect(parseEvalCases("")).toEqual([]);
		expect(parseEvalCases("   \n  ")).toEqual([]);
	});
});
