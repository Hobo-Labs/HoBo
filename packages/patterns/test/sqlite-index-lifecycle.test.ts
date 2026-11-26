/**
 * Building and opening the pattern index.
 *
 * The index is a SQLite file that pattern search reads. Two properties shape
 * how it is written.
 *
 * **The build is atomic.** It writes to `<path>.tmp-<pid>` and renames only
 * after `integrity_check` passes, so a crash mid-build leaves the previous index
 * intact rather than a truncated file that opens fine and returns half the
 * patterns. A partial index is worse than a missing one: the missing one is
 * noticed.
 *
 * **Search degrades honestly when FTS is unavailable.** Not every SQLite build
 * ships the full-text extension, so the index probes for it and records the
 * answer on the receipt. What matters is that `ftsAvailable` says which path
 * ran, so a caller comparing result quality across machines knows why they
 * differ rather than concluding the catalog changed.
 *
 * Querying the built index is covered by `sqlite-index-search.test.ts`; this
 * file is about getting it written and opened correctly in the first place.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	buildPatternIndex,
	defaultIndexPath,
	loadPatternCatalog,
	openPatternIndex,
} from "../src/index.js";
import { buildHoboVocabulary } from "../src/vocabulary.js";

const catalog = loadPatternCatalog();
const vocabulary = buildHoboVocabulary();

function dir(): string {
	return mkdtempSync(join(tmpdir(), "hobo-pat-index-"));
}

/** An in-memory index, which is what most callers get in tests and CI. */
function memoryIndex() {
	return openPatternIndex({ catalog, vocabulary });
}

describe("buildPatternIndex in memory", () => {
	it("reports the catalog and vocabulary it was built from", () => {
		// These digests are what a later open checks against. An index whose
		// digests did not match its source would serve results for a catalog
		// nobody has any more.
		const receipt = buildPatternIndex({ catalog, vocabulary });
		expect(receipt.catalogDigest).toBe(catalog.digest);
		expect(receipt.vocabularyDigest).toBe(vocabulary.digest);
		expect(receipt.encoderDigest).toBe(vocabulary.digest);
		expect(receipt.encoderId).toBe(vocabulary.encoderId);
	});

	it("reports the schema version the file was written against", () => {
		// A reader that opened a newer schema would misinterpret its tables
		// rather than refuse, so the version travels with the file.
		expect(buildPatternIndex({ catalog, vocabulary }).schemaVersion).toBe(
			"patterns-index-v1",
		);
	});

	it("counts every pattern it indexed", () => {
		// The count is how a caller notices a build that silently dropped
		// patterns — a search returning nothing looks the same as a query that
		// matched nothing.
		expect(buildPatternIndex({ catalog, vocabulary }).patternCount).toBe(
			catalog.patterns.length,
		);
	});

	it("reports the in-memory path rather than inventing one", () => {
		// `:memory:` is honest. Reporting a filesystem path for an index that was
		// never written would send whoever read the receipt looking for a file.
		expect(buildPatternIndex({ catalog, vocabulary }).path).toBe(":memory:");
	});

	it("states whether full-text search was available", () => {
		// The honesty property. Search quality differs sharply between the two
		// paths, and a caller comparing results across machines needs to know
		// which ran rather than concluding the catalog changed.
		expect(typeof buildPatternIndex({ catalog, vocabulary }).ftsAvailable).toBe(
			"boolean",
		);
	});

	it("records that no model was involved", () => {
		// Indexing is deterministic. Non-zero token counts would misreport a
		// mechanical build as model output to anyone auditing spend.
		const receipt = buildPatternIndex({ catalog, vocabulary });
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});
});

describe("buildPatternIndex to a file", () => {
	it("writes the index at the path it was given", () => {
		const path = join(dir(), "patterns.sqlite");
		const receipt = buildPatternIndex({ catalog, vocabulary, path });
		expect(receipt.path).toBe(path);
		expect(existsSync(path)).toBe(true);
	});

	it("creates intermediate directories", () => {
		// A build into a fresh `dist/assets` tree is the normal case, and failing
		// on the missing directory would make the build order-dependent.
		const path = join(dir(), "dist", "assets", "patterns.sqlite");
		buildPatternIndex({ catalog, vocabulary, path });
		expect(existsSync(path)).toBe(true);
	});

	it("leaves no temporary file behind", () => {
		// The temp file is an implementation detail of the atomic write. One left
		// in `dist` would be shipped, and its name carries a pid that means
		// nothing on another machine.
		const root = dir();
		buildPatternIndex({
			catalog,
			vocabulary,
			path: join(root, "patterns.sqlite"),
		});
		expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual(
			[],
		);
	});

	it("writes a catalog manifest beside the index", () => {
		// The manifest is what lets a consumer check the index matches the
		// catalog without opening SQLite at all.
		const root = dir();
		buildPatternIndex({
			catalog,
			vocabulary,
			path: join(root, "patterns.sqlite"),
		});
		const manifest = JSON.parse(
			readFileSync(join(root, "catalog.json"), "utf8"),
		) as { digest: string; ids: string[] };
		expect(manifest.digest).toBe(catalog.digest);
		expect(manifest.ids).toHaveLength(catalog.patterns.length);
	});

	it("lists the pattern ids in the manifest in catalog order", () => {
		// Order is part of the digest's meaning. A reordered list would compare
		// unequal to a catalog that is in fact identical.
		const root = dir();
		buildPatternIndex({
			catalog,
			vocabulary,
			path: join(root, "patterns.sqlite"),
		});
		const manifest = JSON.parse(
			readFileSync(join(root, "catalog.json"), "utf8"),
		) as { ids: string[] };
		expect(manifest.ids).toEqual(catalog.patterns.map((item) => item.id));
	});

	it("rebuilds over an existing index", () => {
		// The rename is what makes this safe: the old file is replaced whole,
		// never edited in place, so a reader holding the old one is unaffected.
		const path = join(dir(), "patterns.sqlite");
		buildPatternIndex({ catalog, vocabulary, path });
		expect(() =>
			buildPatternIndex({ catalog, vocabulary, path }),
		).not.toThrow();
		expect(existsSync(path)).toBe(true);
	});
});

describe("openPatternIndex", () => {
	it("opens an index that was built to disk", () => {
		const path = join(dir(), "patterns.sqlite");
		buildPatternIndex({ catalog, vocabulary, path });
		const index = openPatternIndex({ path, catalog, vocabulary });
		expect(index.driver).toBeDefined();
		expect(typeof index.ftsAvailable).toBe("boolean");
	});

	it("falls back to an in-memory build when the file is absent", () => {
		// The path most tests and first runs take. Requiring a prebuilt file
		// would make the package unusable before its build step had run.
		const index = openPatternIndex({
			path: join(dir(), "missing.sqlite"),
			catalog,
			vocabulary,
		});
		expect(index.driver).toBeDefined();
	});

	it("builds in memory when no path is given at all", () => {
		expect(memoryIndex().driver).toBeDefined();
	});

	it("refuses when there is neither a file nor a catalog to fall back on", () => {
		// Without either there is nothing to search. Returning an empty index
		// would answer every query with no results, which reads as "no pattern
		// matches" rather than "the index is missing".
		expect(() =>
			openPatternIndex({ path: join(dir(), "missing.sqlite") }),
		).toThrow(/missing and catalog fallback not provided/u);
		expect(() => openPatternIndex({})).toThrow(/catalog fallback/u);
		expect(() => openPatternIndex({ catalog })).toThrow(/catalog fallback/u);
		expect(() => openPatternIndex({ vocabulary })).toThrow(/catalog fallback/u);
	});
});

describe("defaultIndexPath", () => {
	it("points into the package's built assets", () => {
		// The index is a build artifact, not a source file. Pointing at `src`
		// would put a binary in the tree and make it a review burden on every
		// rebuild.
		expect(defaultIndexPath("/pkg")).toBe(
			join("/pkg", "dist", "assets", "patterns.sqlite"),
		);
	});
});
