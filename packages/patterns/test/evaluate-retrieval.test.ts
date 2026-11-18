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

const REAL_QUERY = "add an api resource to a bindle";

describe("evaluatePatternRetrieval", () => {
	it("counts every case it was given", () => {
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{ id: "b", query: "zzz nothing", expectedIds: [], expectAbstain: true },
		]);
		expect(report.cases).toBe(2);
	});

	it("scores recall at 1 only when the expected id came back first", () => {
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
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
		]);
		expect(report.recallAt3).toBeGreaterThanOrEqual(report.recallAt1);
	});

	it("accepts any of several expected ids for recall at 3", () => {
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
		const report = evaluate([{ id: "a", query: REAL_QUERY, expectedIds: [] }]);
		expect(report.recallAt1).toBe(0);
		expect(report.recallAt3).toBe(0);
	});

	it("scores an abstain case by whether search declined", () => {
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
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: [], expectAbstain: true },
		]);
		expect(report.abstainPrecision).toBe(1);
	});

	it("keeps abstain cases out of the recall denominator", () => {
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{ id: "b", query: "zzz1", expectedIds: [], expectAbstain: true },
			{ id: "c", query: "zzz2", expectedIds: [], expectAbstain: true },
		]);
		expect(report.recallAt1).toBe(1);
		expect(report.cases).toBe(3);
	});

	it("keeps scored cases out of the abstain denominator", () => {
		const report = evaluate([
			{ id: "a", query: REAL_QUERY, expectedIds: ["bindle.resource.api"] },
			{ id: "b", query: "zzzznotaword", expectedIds: [], expectAbstain: true },
		]);
		expect(report.abstainPrecision).toBe(1);
	});

	it("answers zero recall for a corpus with nothing to score", () => {
		const report = evaluate([
			{ id: "a", query: "zzz", expectedIds: [], expectAbstain: true },
		]);
		expect(report.recallAt1).toBe(0);
		expect(report.recallAt3).toBe(0);
		expect(Number.isNaN(report.recallAt1)).toBe(false);
	});

	it("answers perfect abstain precision for a corpus with no abstain cases", () => {
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
		const report = evaluate([]);
		expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(report.elapsedMs)).toBe(true);
	});

	it("produces a recall between zero and one", () => {
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
		expect(
			parseEvalCases('\n{"id":"a","query":"one","expectedIds":["x"]}\n\n\n'),
		).toHaveLength(1);
	});

	it("returns nothing for an empty corpus", () => {
		expect(parseEvalCases("")).toEqual([]);
		expect(parseEvalCases("   \n  ")).toEqual([]);
	});
});
