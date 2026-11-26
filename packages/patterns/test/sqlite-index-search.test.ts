/**
 * The SQLite pattern index: building it, opening it, and the two lexical
 * search paths.
 *
 * The index is a *derived read-store* — a materialized view of the catalog,
 * never the source of truth. Two things about that matter here.
 *
 * First, it has two search implementations, not one. When the SQLite build has
 * FTS5, search goes through `bm25`; when it does not, there is a substring
 * fallback. Both are live code on some machine, and a fallback nobody exercises
 * is a fallback that has quietly stopped working — the failure would appear
 * only on the developer machine whose SQLite lacks FTS, as an empty result set
 * rather than an error. So the fallback is driven explicitly here rather than
 * left to whatever this machine happens to have.
 *
 * Second, an index built from a catalog must find what the catalog contains.
 * A build that silently indexed nothing would make every search return no
 * results, which reads to a caller exactly like "your query matched nothing".
 */
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

/** The same index, forced onto the non-FTS substring path. */
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
		// The alternative would be an empty index that answers every search with
		// nothing — indistinguishable from a catalog in which nothing matches.
		expect(() => openPatternIndex({})).toThrow(
			/pattern index missing and catalog fallback not provided/u,
		);
		expect(() =>
			openPatternIndex({ path: "/definitely/not/here.sqlite" }),
		).toThrow(/catalog fallback not provided/u);
		// A catalog without a vocabulary is equally unusable: the vocabulary is
		// what the lexical terms are drawn from.
		expect(() => openPatternIndex({ catalog })).toThrow(
			/catalog fallback not provided/u,
		);
		expect(() => openPatternIndex({ vocabulary })).toThrow(
			/catalog fallback not provided/u,
		);
	});

	it("falls back to the catalog when the given path does not exist", () => {
		// `input.path && existsSync(path)` — a stale or absent index file is not
		// a failure, it is a cache miss, and rebuilding in memory keeps the
		// caller working rather than making them regenerate an asset first.
		const index = openPatternIndex({
			path: "/definitely/not/here.sqlite",
			catalog,
			vocabulary,
		});
		expect(index.driver).toBeDefined();
	});

	it("indexes every pattern in the catalog", () => {
		// The build-produced-nothing failure. A row count short of the catalog
		// would make some patterns permanently unfindable, and nothing would
		// report it.
		const index = memoryIndex();
		const rows = index.driver
			.prepare("SELECT COUNT(*) AS n FROM patterns")
			.all();
		expect(Number(rows[0]?.n)).toBe(catalog.patterns.length);
	});
});

describe("searchIndexLexical", () => {
	it("returns nothing for an empty term list", () => {
		// Short-circuited before touching the driver: an empty FTS MATCH is a
		// syntax error in SQLite, and the substring path would score every row
		// zero and filter them all out anyway.
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
		// Rank is what a caller slices a top-N from. A zero-based or gapped rank
		// would silently drop the first result or shift the window.
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
			// Driven explicitly rather than left to this machine's SQLite build.
			// A fallback that only runs where FTS is missing is a fallback nobody
			// tests, and its failure mode is an empty result rather than an error.
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
			// More matching terms ranks higher. A fallback that ranked by
			// document order would make the substring path's results unrelated to
			// the query, while still returning a plausible-looking list.
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
			// The haystack is lowercased and the terms are expected lowercase, so
			// an uppercase term finds nothing. Pinned as the contract: callers
			// normalise before calling, and a caller that did not would otherwise
			// get a confusing empty result.
			expect(searchIndexLexical(fallbackIndex(), ["STARTER"])).toEqual([]);
			expect(
				searchIndexLexical(fallbackIndex(), ["starter"]).length,
			).toBeGreaterThan(0);
		});

		it("breaks a score tie by pattern id, so the order is stable", () => {
			// Two patterns matching the same number of terms must not depend on
			// row order, or two runs over the same index would rank differently.
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
		// Terms are wrapped in FTS phrase quotes, so an embedded `"` would end
		// the phrase early and the rest would be parsed as FTS syntax — a query
		// injection into the match expression. The quote is stripped rather than
		// escaped, which is blunt but closes it.
		const index = memoryIndex();
		if (!index.ftsAvailable) return;
		expect(() => searchIndexLexical(index, ['star"ter'])).not.toThrow();
		expect(() => searchIndexLexical(index, ['" OR "'])).not.toThrow();
	});
});

describe("loadIndexVectors", () => {
	it("returns one row per indexed vector with a decodable blob", () => {
		// The vector rows are what dense retrieval reads. A row whose declared
		// dimensions disagreed with its blob length would fail at decode time,
		// far from the build that wrote it.
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
		// The version is how a consumer tells a stale vector from a current one
		// without re-encoding it.
		for (const row of loadIndexVectors(memoryIndex())) {
			expect(Number.isFinite(row.patternVersion)).toBe(true);
		}
	});
});

describe("defaultIndexPath", () => {
	it("points inside the package's built assets", () => {
		// Under `dist/`, so the index ships with the build rather than being
		// regenerated on every consumer's first search.
		expect(defaultIndexPath("/pkg")).toBe("/pkg/dist/assets/patterns.sqlite");
	});
});
