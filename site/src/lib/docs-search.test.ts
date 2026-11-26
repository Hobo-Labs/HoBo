import { describe, expect, it } from "vitest";

import { nav } from "../nav";
import { docsSearchEntries } from "./docs-search";

describe("docs search index", () => {
	it("includes getting started, examples, legal-adjacent trail map, and the CLI guide", () => {
		const entries = docsSearchEntries(nav);
		const slugs = entries.map((entry) => entry.slug);
		expect(slugs).toContain("/guide/getting-started/");
		expect(slugs).toContain("/examples/");
		expect(slugs).toContain("/guide/status/");
		expect(slugs).toContain("/guide/cli/");
		expect(slugs).toContain("/primitives/");
	});
});
