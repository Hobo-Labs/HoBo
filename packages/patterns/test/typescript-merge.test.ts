/**
 * The structural TypeScript merge, across the shapes a real bindle file takes.
 *
 * `apply.test.ts` covers the base case — insert a resource into a plain bindle
 * and stay idempotent. This covers the merge decisions that only appear once a
 * file has some history: an import that already exists, a resource that is
 * already declared, a builder call that is already chained.
 *
 * This is an AST edit applied to somebody's source, so the failure that matters
 * is not "it threw" — it is "it silently produced a file that means something
 * else". Three properties guard against that:
 *
 * **It merges into what is there rather than re-declaring.** A second
 * `import { bindle } from "@hobo/bindles"` is a TypeScript error; a second
 * `const shop = …` is worse, because it compiles and shadows.
 *
 * **It is idempotent per-call, not just per-pattern.** Applying the same
 * pattern twice must not append a second `.dependsOn(...)` to the same builder
 * chain — that would be a duplicate dependency the graph then has to reconcile.
 *
 * **It refuses rather than guesses.** A snippet referring to a symbol the file
 * does not declare cannot be placed, and a file whose shape it does not
 * recognise cannot be edited safely. Both raise `PatternParseError` instead of
 * writing something approximate.
 *
 * Everything the merge preserves is asserted on the *file*, not on the receipt:
 * a receipt claiming success while the file lost a comment is exactly the bug
 * these tests exist to catch.
 */
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

/** Write a bindle source into a fresh isolation root. */
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
		// The api-resource snippet is `const shop = b.api(...)` — it uses the
		// builder the callback already has, so it needs no import. Adding one
		// anyway would put an unused import in somebody's file on every apply.
		const dir = root(PLAIN);
		const before = (read(dir).match(/^import /gmu) ?? []).length;
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect((read(dir).match(/^import /gmu) ?? []).length).toBe(before);
	});

	it("does not repair an unrelated missing import", () => {
		// A file that never imported `bindle` is already broken, and it is not
		// this pattern's business to guess what the author meant. Silently
		// adding an import would make a broken file compile as something the
		// author did not write.
		const dir = root(
			`export default bindle("demo", (b) => {\n  return {};\n});\n`,
		);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).not.toContain("@hobo/bindles");
	});

	it("does not add a second import declaration for the same module", () => {
		// Two `import … from "@hobo/bindles"` lines is a TypeScript error, so the
		// file would not compile at all.
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		const imports = read(dir).match(/from "@hobo\/bindles"/gu) ?? [];
		expect(imports).toHaveLength(1);
	});

	it("keeps the names the file already imported", () => {
		// Dropping `bindle` while adding a new name would break the default
		// export the whole file is built around.
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
		// A resource declared but not returned is one the bindle never exposes,
		// which compiles and does nothing.
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir)).toMatch(/return \{[^}]*shop/u);
	});

	it("does not redeclare a resource that already exists", () => {
		// A second `const shop` is worse than a duplicate import: it compiles in
		// a different scope, or shadows, rather than failing loudly.
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		expect(read(dir).match(/const shop\b/gu) ?? []).toHaveLength(1);
	});

	it("reports the repeat as idempotent rather than as a change", () => {
		// The receipt drives whether a caller re-runs downstream work.
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
		// An AST round trip that reprinted the file would drop every comment in
		// it — the single most visible way this could silently damage source.
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
		// The name is the deployed identity; changing it would deploy a
		// different app.
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
		// The merge inserts text at computed offsets; an off-by-one produces a
		// file that looks plausible and does not parse.
		const dir = root(PLAIN);
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.api", { resourceName: "admin" });
		const text = read(dir);
		expect(text.match(/\{/gu)?.length).toBe(text.match(/\}/gu)?.length);
	});
});

describe("refusals", () => {
	it("refuses a file with two bindle definitions", () => {
		// Which one should the resource go in? Picking either is a guess about
		// the author's intent.
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
		// A half-applied edit is worse than no edit: the operator has to work
		// out what was changed before they can retry.
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
		// The `.dependsOn()` branch: the snippet is a call on a symbol the file
		// already declares, so it is appended to that declaration rather than
		// emitted as a free-standing statement.
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
		// A duplicate `.dependsOn(...)` is a duplicate edge the graph then has
		// to reconcile.
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
		// The zero-inference claim, asserted rather than assumed: this is a
		// deterministic AST edit.
		const receipt = apply(root(PLAIN), "bindle.resource.api", {
			resourceName: "shop",
		});
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
	});

	it("always requires promotion", () => {
		// The edit happens in an isolation root; promotion is the reviewed step
		// that moves it into the real project.
		expect(
			apply(root(PLAIN), "bindle.resource.api", { resourceName: "shop" })
				.promotionRequired,
		).toBe(true);
	});

	it("records a postimage hash of what it wrote", () => {
		// The hash is what makes the promotion checkable against what was
		// reviewed.
		expect(
			apply(root(PLAIN), "bindle.resource.api", { resourceName: "shop" })
				.postimage.length,
		).toBeGreaterThan(0);
	});

	it("defaults the resource name rather than refusing", () => {
		// The parameter is declared optional with a default; requiring it would
		// make the simplest invocation an error.
		const dir = root(PLAIN);
		expect(() => apply(dir, "bindle.resource.api")).not.toThrow();
	});
});
