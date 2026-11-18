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

function memoryIndex() {
	return openPatternIndex({ catalog, vocabulary });
}

describe("buildPatternIndex in memory", () => {
	it("reports the catalog and vocabulary it was built from", () => {
		const receipt = buildPatternIndex({ catalog, vocabulary });
		expect(receipt.catalogDigest).toBe(catalog.digest);
		expect(receipt.vocabularyDigest).toBe(vocabulary.digest);
		expect(receipt.encoderDigest).toBe(vocabulary.digest);
		expect(receipt.encoderId).toBe(vocabulary.encoderId);
	});

	it("reports the schema version the file was written against", () => {
		expect(buildPatternIndex({ catalog, vocabulary }).schemaVersion).toBe(
			"patterns-index-v1",
		);
	});

	it("counts every pattern it indexed", () => {
		expect(buildPatternIndex({ catalog, vocabulary }).patternCount).toBe(
			catalog.patterns.length,
		);
	});

	it("reports the in-memory path rather than inventing one", () => {
		expect(buildPatternIndex({ catalog, vocabulary }).path).toBe(":memory:");
	});

	it("states whether full-text search was available", () => {
		expect(typeof buildPatternIndex({ catalog, vocabulary }).ftsAvailable).toBe(
			"boolean",
		);
	});

	it("records that no model was involved", () => {
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
		const path = join(dir(), "dist", "assets", "patterns.sqlite");
		buildPatternIndex({ catalog, vocabulary, path });
		expect(existsSync(path)).toBe(true);
	});

	it("leaves no temporary file behind", () => {
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
		expect(defaultIndexPath("/pkg")).toBe(
			join("/pkg", "dist", "assets", "patterns.sqlite"),
		);
	});
});
