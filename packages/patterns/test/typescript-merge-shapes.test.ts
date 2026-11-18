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

let runCounter = 0;

function root(source: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-pat-shape-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "bindle.ts"), source);
	return dir;
}

const read = (dir: string) =>
	readFileSync(join(dir, "src", "bindle.ts"), "utf8");

function apply(
	dir: string,
	patternId = "bindle.resource.api",
	params: Record<string, unknown> = { resourceName: "shop" },
) {
	runCounter += 1;
	return applyPatternPlan({
		catalog,
		patternId,
		isolationRoot: dir,
		targetPath: "src/bindle.ts",
		isolationRunId: `shape-${runCounter}`,
		params,
	} as never);
}

function bindleFile(
	body: string,
	importLine = 'import { bindle } from "@hobo/bindles";',
): string {
	return `${importLine}\n\nexport default bindle("demo", (b) => {\n${body}\n});\n`;
}

describe("import shapes the merge has to recognise", () => {
	it("handles a namespace import of the bindles package", () => {
		const dir = root(
			`import * as bindles from "@hobo/bindles";\nconst bindle = bindles.bindle;\n\nexport default bindle("demo", (b) => {\n  return {};\n});\n`,
		);
		expect(() => apply(dir)).not.toThrow();
		expect((read(dir).match(/from "@hobo\/bindles"/gu) ?? []).length).toBe(1);
	});

	it("handles a side-effect import with no clause at all", () => {
		const dir = root(
			`import "@hobo/bindles";\nimport { bindle } from "@hobo/bindles";\n\nexport default bindle("demo", (b) => {\n  return {};\n});\n`,
		);
		expect(() => apply(dir)).not.toThrow();
	});

	it("ignores imports from other modules when looking for its own", () => {
		const dir = root(
			`import { readFile } from "node:fs/promises";\nimport { bindle } from "@hobo/bindles";\n\nexport default bindle("demo", (b) => {\n  return {};\n});\n`,
		);
		apply(dir);
		expect(read(dir)).toContain(`import { readFile } from "node:fs/promises"`);
	});
});

describe("callback bodies the merge has to read", () => {
	it("skips non-declaration statements when collecting used names", () => {
		const dir = root(
			bindleFile(
				`  console.log("setting up");\n  if (process.env.DEBUG) {\n    console.log("debug");\n  }\n  return {};`,
			),
		);
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("b.api(");
	});

	it("allocates a fresh name when the wanted one is already declared", () => {
		const dir = root(
			bindleFile(`  const shop = "something else";\n  return { shop };`),
		);
		apply(dir);
		const source = read(dir);
		expect((source.match(/const shop\b/gu) ?? []).length).toBe(1);
		expect(source).toMatch(/const shop2\b/u);
	});

	it("keeps allocating past a second collision", () => {
		const dir = root(
			bindleFile(
				`  const shop = 1;\n  const shop2 = 2;\n  return { shop, shop2 };`,
			),
		);
		apply(dir);
		expect(read(dir)).toMatch(/const shop3\b/u);
	});

	it("adds the new name to a return object that already has properties", () => {
		const dir = root(bindleFile(`  const api = b.api();\n  return { api };`));
		apply(dir);

		expect(read(dir)).toMatch(/return \{ api\s*,\s*shop\s*\}/u);
	});

	it("reads a return object written with explicit property assignments", () => {
		const dir = root(
			bindleFile(`  const api = b.api();\n  return { api: api };`),
		);
		apply(dir);
		const source = read(dir);
		expect((source.match(/\bapi\b\s*:/gu) ?? []).length).toBe(1);
	});

	it("handles a callback that returns nothing at all", () => {
		const dir = root(bindleFile(`  const api = b.api();`));
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("b.api(");
	});

	it("handles a callback returning something other than an object literal", () => {
		const dir = root(
			bindleFile(`  const surface = { api: b.api() };\n  return surface;`),
		);
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("return surface;");
	});

	it("handles an empty return object", () => {
		const dir = root(bindleFile(`  return {};`));
		apply(dir);
		expect(read(dir)).toMatch(/return \{\s*shop\s*\}/u);
	});
});

describe("builder-chain merging", () => {
	const WITH_API = bindleFile(`  const api = b.api();\n  return { api };`);

	it("chains a dependsOn onto the declaration its snippet names", () => {
		const dir = root(
			bindleFile(
				`  const web = b.web();\n  const api = b.api();\n  return { web, api };`,
			),
		);
		apply(dir, "bindle.relationship.depends-on", {});
		expect(read(dir)).toMatch(/const web = b\.web\(\)\.dependsOn\(/u);
	});

	it("does not chain the same call twice", () => {
		const dir = root(
			bindleFile(
				`  const web = b.web();\n  const api = b.api();\n  return { web, api };`,
			),
		);
		apply(dir, "bindle.relationship.depends-on", {});
		const once = read(dir);
		apply(dir, "bindle.relationship.depends-on", {});
		expect(read(dir)).toBe(once);
	});

	it("refuses to chain onto a symbol the file does not declare", () => {
		const dir = root(WITH_API);
		expect(() => apply(dir, "bindle.relationship.depends-on", {})).toThrow(
			/unresolved symbol web/u,
		);
	});

	it("leaves the file untouched when it refuses to chain", () => {
		const dir = root(WITH_API);
		expect(() => apply(dir, "bindle.relationship.depends-on", {})).toThrow(
			PatternParseError,
		);
		expect(read(dir)).toBe(WITH_API);
	});

	it("refuses when the named symbol is declared without an initializer", () => {
		const dir = root(
			bindleFile(`  let web;\n  const api = b.api();\n  return { api };`),
		);
		expect(() => apply(dir, "bindle.relationship.depends-on", {})).toThrow(
			/unresolved symbol web/u,
		);
	});

	it("chains an annotation onto the declaration its snippet names", () => {
		const dir = root(
			bindleFile(`  const resource = b.api();\n  return { resource };`),
		);
		apply(dir, "bindle.annotation.env", {});
		expect(read(dir)).toMatch(/const resource = b\.api\(\)\.with\(/u);
	});

	it("does not add a second annotation of the same method", () => {
		const dir = root(
			bindleFile(`  const resource = b.api();\n  return { resource };`),
		);
		apply(dir, "bindle.annotation.env", {});
		const once = read(dir);
		apply(dir, "bindle.annotation.env", {});
		expect(read(dir)).toBe(once);
	});
});

describe("the merge verifies its own output", () => {
	it("still parses after the edit", () => {
		const dir = root(bindleFile(`  const api = b.api();\n  return { api };`));
		apply(dir);
		expect(() =>
			applyPatternPlan({
				catalog,
				patternId: "bindle.resource.kv-read-write",
				isolationRoot: dir,
				targetPath: "src/bindle.ts",
				isolationRunId: "reparse-check",
				params: { resourceName: "cache" },
			} as never),
		).not.toThrow();
	});

	it("still contains exactly one bindle definition after the edit", () => {
		const dir = root(bindleFile(`  return {};`));
		apply(dir);
		expect((read(dir).match(/bindle\(/gu) ?? []).length).toBe(1);
	});

	it("accumulates several resources across applies", () => {
		const dir = root(bindleFile(`  return {};`));
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.kv-read-write", { resourceName: "cache" });
		const source = read(dir);
		expect(source).toMatch(/const shop\b/u);
		expect(source).toMatch(/const cache\b/u);
		expect((source.match(/bindle\(/gu) ?? []).length).toBe(1);
	});
});
