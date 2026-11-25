import { describe, expect, it } from "vitest";

import { loadPatternCatalog } from "../src/catalog.js";
import {
	defaultIndexPath,
	loadIndexVectors,
	openPatternIndex,
	searchIndexLexical,
} from "../src/sqlite-index.js";
import { buildHoboVocabulary } from "../src/vocabulary.js";

const catalog = loadPatternCatalog();
const vocabulary = buildHoboVocabulary();

function memoryIndex() {
	return openPatternIndex({ catalog, vocabulary });
}

function fallbackIndex() {
	const index = memoryIndex();
	return { ...index, ftsAvailable: false };
}

describe("openPatternIndex", () => {
	it("builds an in-memory index from a catalog when no path is given", () => {
		const index = memoryIndex();
		expect(index.driver).toBeDefined();
		expect(typeof index.ftsAvailable).toBe("boolean");
	});

	it("refuses when neither a usable path nor a catalog fallback is available", () => {
		expect(() => openPatternIndex({})).toThrow(
			/pattern index missing and catalog fallback not provided/u,
		);
		expect(() =>
			openPatternIndex({ path: "/definitely/not/here.sqlite" }),
		).toThrow(/catalog fallback not provided/u);
		expect(() => openPatternIndex({ catalog })).toThrow(
			/catalog fallback not provided/u,
		);
		expect(() => openPatternIndex({ vocabulary })).toThrow(
			/catalog fallback not provided/u,
		);
	});

	it("falls back to the catalog when the given path does not exist", () => {
		const index = openPatternIndex({
			path: "/definitely/not/here.sqlite",
			catalog,
			vocabulary,
		});
		expect(index.driver).toBeDefined();
	});

	it("indexes every pattern in the catalog", () => {
		const index = memoryIndex();
		const rows = index.driver
			.prepare("SELECT COUNT(*) AS n FROM patterns")
			.all();
		expect(Number(rows[0]?.n)).toBe(catalog.patterns.length);
	});
});

describe("searchIndexLexical", () => {
	it("returns nothing for an empty term list", () => {
		expect(searchIndexLexical(memoryIndex(), [])).toEqual([]);
		expect(searchIndexLexical(fallbackIndex(), [])).toEqual([]);
	});

	it("finds a pattern by a term drawn from the catalog", () => {
		const index = memoryIndex();
		const hits = searchIndexLexical(index, ["starter"]);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((hit) => typeof hit.patternId === "string")).toBe(true);
	});

	it("assigns contiguous one-based ranks", () => {
		const hits = searchIndexLexical(memoryIndex(), ["starter"]);
		expect(hits.map((hit) => hit.rank)).toEqual(
			hits.map((_, index) => index + 1),
		);
	});

	it("returns nothing for a term that appears nowhere", () => {
		expect(searchIndexLexical(memoryIndex(), ["zzzznotapatternterm"])).toEqual(
			[],
		);
	});

	describe("the non-FTS substring fallback", () => {
		it("finds the same kind of match without FTS", () => {
			const hits = searchIndexLexical(fallbackIndex(), ["starter"]);
			expect(hits.length).toBeGreaterThan(0);
		});

		it("assigns contiguous one-based ranks too", () => {
			const hits = searchIndexLexical(fallbackIndex(), ["starter"]);
			expect(hits.map((hit) => hit.rank)).toEqual(
				hits.map((_, index) => index + 1),
			);
		});

		it("scores by how many distinct terms matched", () => {
			const hits = searchIndexLexical(fallbackIndex(), [
				"starter",
				"zzzznotapatternterm",
			]);
			const single = searchIndexLexical(fallbackIndex(), ["starter"]);
			expect(hits.map((hit) => hit.patternId)).toEqual(
				single.map((hit) => hit.patternId),
			);
		});

		it("matches case-insensitively", () => {
			expect(searchIndexLexical(fallbackIndex(), ["STARTER"])).toEqual([]);
			expect(
				searchIndexLexical(fallbackIndex(), ["starter"]).length,
			).toBeGreaterThan(0);
		});

		it("breaks a score tie by pattern id, so the order is stable", () => {
			const first = searchIndexLexical(fallbackIndex(), ["pattern"]);
			const second = searchIndexLexical(fallbackIndex(), ["pattern"]);
			expect(first.map((hit) => hit.patternId)).toEqual(
				second.map((hit) => hit.patternId),
			);
		});

		it("returns nothing when no row matches any term", () => {
			expect(
				searchIndexLexical(fallbackIndex(), ["zzzznotapatternterm"]),
			).toEqual([]);
		});
	});

	it("neutralises a double quote in a term on the FTS path", () => {
		const index = memoryIndex();
		if (!index.ftsAvailable) return;
		expect(() => searchIndexLexical(index, ['star"ter'])).not.toThrow();
		expect(() => searchIndexLexical(index, ['" OR "'])).not.toThrow();
	});
});

describe("loadIndexVectors", () => {
	it("returns one row per indexed vector with a decodable blob", () => {
		const rows = loadIndexVectors(memoryIndex());
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(typeof row.patternId).toBe("string");
			expect(row.patternId.length).toBeGreaterThan(0);
			expect(row.dimensions).toBeGreaterThan(0);
			expect(row.blob.byteLength).toBe(row.dimensions * 4);
		}
	});

	it("carries a pattern version for every row", () => {
		for (const row of loadIndexVectors(memoryIndex())) {
			expect(Number.isFinite(row.patternVersion)).toBe(true);
		}
	});
});

describe("defaultIndexPath", () => {
	it("points inside the package's built assets", () => {
		expect(defaultIndexPath("/pkg")).toBe("/pkg/dist/assets/patterns.sqlite");
	});
});
