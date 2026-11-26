import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	buildHoboVocabulary,
	loadPatternCatalog,
	renderPattern,
	searchPatterns,
} from "../src/index.js";

describe("packed catalog consumer", () => {
	it("ships catalog trees and can search/render offline", () => {
		const manifest = JSON.parse(
			readFileSync(
				join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
				"utf8",
			),
		) as { files: string[] };
		expect(manifest.files).toEqual(
			expect.arrayContaining(["patterns", "atoms", "vocabulary", "dist"]),
		);
		const catalog = loadPatternCatalog();
		const vocabulary = buildHoboVocabulary();
		const search = searchPatterns({
			catalog,
			vocabulary,
			query: "bindle.named",
		});
		expect(search.selectedId).toBe("bindle.named");
		expect(search.llmCalls).toBe(0);
		const pattern = catalog.patterns.find((item) => item.id === "bindle.named");
		if (!pattern) throw new Error("missing bindle.named");
		const rendered = renderPattern({
			catalog,
			pattern,
			params: { resourceName: "pack" },
		});
		expect(rendered.files[0]?.contents).toContain('bindle("pack"');
		expect(rendered.llmCalls).toBe(0);
	});
});
