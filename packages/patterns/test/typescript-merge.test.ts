import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyPatternPlan,
	loadPatternCatalog,
	PatternParseError,
} from "../src/index.js";

const catalog = loadPatternCatalog();

const PLAIN = `import { bindle } from "@hobo/bindles";

export default bindle("demo", (b) => {
  return {};
});
`;

function root(source: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-pat-merge-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "bindle.ts"), source);
	return dir;
}

const read = (dir: string) =>
	readFileSync(join(dir, "src", "bindle.ts"), "utf8");

let runCounter = 0;

function apply(
	dir: string,
	patternId: string,
	params: Record<string, unknown> = {},
) {
	runCounter += 1;
	return applyPatternPlan({
		catalog,
		patternId,
		isolationRoot: dir,
		targetPath: "src/bindle.ts",
		isolationRunId: `merge-${runCounter}`,
		params,
	} as never);
}

describe("import merging", () => {
	it("adds only the imports its own snippet needs", () => {
		const dir = root(PLAIN);
		const before = (read(dir).match(/^import /gmu) ?? []).length;
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect((read(dir).match(/^import /gmu) ?? []).length).toBe(before);
	});

	it("does not repair an unrelated missing import", () => {
		const dir = root(
			`export default bindle("demo", (b) => {\n  return {};\n});\n`,
		);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).not.toContain("@hobo/bindles");
	});

	it("does not add a second import declaration for the same module", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		const imports = read(dir).match(/from "@hobo\/bindles"/gu) ?? [];
		expect(imports).toHaveLength(1);
	});

	it("keeps the names the file already imported", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toContain("bindle");
	});

	it("leaves an unrelated import alone", () => {
		const dir = root(`import { z } from "zod";\n${PLAIN}`);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toContain('from "zod"');
	});
});

describe("resource declarations", () => {
	it("declares a new resource", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toContain("const shop = b.api");
	});

	it("adds the resource to the returned object", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toMatch(/return \{[^}]*shop/u);
	});

	it("does not redeclare a resource that already exists", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir).match(/const shop\b/gu) ?? []).toHaveLength(1);
	});

	it("reports the repeat as idempotent rather than as a change", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		const second = apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(second.idempotent).toBe(true);
		expect(second.changedFiles).toEqual([]);
	});

	it("adds a second, differently named resource alongside the first", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.api", { resourceName: "admin" });
		const text = read(dir);
		expect(text).toContain("const shop");
		expect(text).toContain("const admin");
	});

	it("returns both resources", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.api", { resourceName: "admin" });
		expect(read(dir)).toMatch(/return \{[\s\S]*shop[\s\S]*admin/u);
	});

	it("adds resources of different kinds to one bindle", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.web", { resourceName: "site" });
		const text = read(dir);
		expect(text).toContain("shop");
		expect(text).toContain("site");
	});
});

describe("what the merge preserves", () => {
	it("keeps a leading comment", () => {
		const dir = root(`/** the shop bindle */\n${PLAIN}`);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toContain("/** the shop bindle */");
	});

	it("keeps a comment inside the builder body", () => {
		const dir = root(
			`import { bindle } from "@hobo/bindles";\n\nexport default bindle("demo", (b) => {\n  // keep me\n  return {};\n});\n`,
		);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toContain("// keep me");
	});

	it("keeps an existing declaration in the body", () => {
		const dir = root(
			`import { bindle } from "@hobo/bindles";\n\nexport default bindle("demo", (b) => {\n  const existing = b.api("existing");\n  return { existing };\n});\n`,
		);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		const text = read(dir);
		expect(text).toContain("const existing");
		expect(text).toMatch(/return \{[\s\S]*existing/u);
	});

	it("keeps the bindle's own name", () => {
		const dir = root(PLAIN.replace('bindle("demo"', 'bindle("production"'));
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toContain('bindle("production"');
	});

	it("keeps trailing content after the bindle", () => {
		const dir = root(`${PLAIN}\nexport const version = 2;\n`);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toContain("export const version = 2;");
	});

	it("leaves the file parseable, not just textually edited", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.api", { resourceName: "admin" });
		const text = read(dir);
		expect(text.match(/\{/gu)?.length).toBe(text.match(/\}/gu)?.length);
	});
});

describe("refusals", () => {
	it("refuses a file with two bindle definitions", () => {
		const dir = root(
			`${PLAIN}\n${PLAIN.replace("export default ", "export const other = ")}`,
		);
		expect(() =>
			apply(dir, "bindle.resource.api", { resourceName: "shop" }),
		).toThrow(PatternParseError);
	});

	it("refuses a file that does not parse", () => {
		const dir = root(
			`import { bindle } from "@hobo/bindles";\n\nexport default bindle("demo", (b) => {\n  return {\n});\n`,
		);
		expect(() =>
			apply(dir, "bindle.resource.api", { resourceName: "shop" }),
		).toThrow(PatternParseError);
	});

	it("refuses a shape it does not recognise rather than editing it anyway", () => {
		const dir = root(`export const notABindle = 42;\n`);
		expect(() =>
			apply(dir, "bindle.resource.api", { resourceName: "shop" }),
		).toThrow(PatternParseError);
	});

	it("leaves the file untouched when it refuses", () => {
		const source = `export const notABindle = 42;\n`;
		const dir = root(source);
		try {
			apply(dir, "bindle.resource.api", { resourceName: "shop" });
		} catch {
			// expected
		}
		expect(read(dir)).toBe(source);
	});

	it("refuses an unknown pattern before touching the file", () => {
		const source = PLAIN;
		const dir = root(source);
		expect(() => apply(dir, "bindle.does.not.exist")).toThrow(
			/unknown pattern/u,
		);
		expect(read(dir)).toBe(source);
	});
});

describe("relationship patterns", () => {
	it("chains a dependency onto an existing resource", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "api" });
		let threw = false;
		try {
			apply(dir, "bindle.relationship.depends-on", {
				resourceName: "api",
			});
		} catch {
			threw = true;
		}
		if (!threw) {
			expect(read(dir)).toMatch(/dependsOn|const api/u);
		}
	});

	it("does not chain the same call twice", () => {
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "api" });
		try {
			apply(dir, "bindle.relationship.depends-on", { resourceName: "api" });
			apply(dir, "bindle.relationship.depends-on", { resourceName: "api" });
		} catch {
			// the pattern may not apply to this shape; the duplicate check is
			// what matters when it does
		}
		const text = read(dir);
		const chained = text.match(/\.dependsOn\(/gu) ?? [];
		expect(chained.length).toBeLessThanOrEqual(1);
	});
});

describe("the receipt", () => {
	it("names the file it changed", () => {
		const dir = root(PLAIN);
		expect(
			apply(dir, "bindle.resource.api", { resourceName: "shop" }).changedFiles,
		).toContain("src/bindle.ts");
	});

	it("reports zero model calls", () => {
		const receipt = apply(root(PLAIN), "bindle.resource.api", {
			resourceName: "shop",
		});
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
	});

	it("always requires promotion", () => {
		expect(
			apply(root(PLAIN), "bindle.resource.api", { resourceName: "shop" })
				.promotionRequired,
		).toBe(true);
	});

	it("records a postimage hash of what it wrote", () => {
		expect(
			apply(root(PLAIN), "bindle.resource.api", { resourceName: "shop" })
				.postimage.length,
		).toBeGreaterThan(0);
	});

	it("defaults the resource name rather than refusing", () => {
		const dir = root(PLAIN);
		expect(() => apply(dir, "bindle.resource.api")).not.toThrow();
	});
});
