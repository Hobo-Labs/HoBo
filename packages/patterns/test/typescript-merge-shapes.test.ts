/**
 * The structural merge against bindle files with awkward shapes.
 *
 * `typescript-merge.test.ts` covers the ordinary shapes; this covers the ones a
 * real file grows into — an import written as a namespace rather than named
 * bindings, a callback whose body is not just declarations, a return literal
 * that already spells its properties out, a name the file has already used.
 *
 * Every one of these is a case where the merge has to *notice* something about
 * the existing file rather than assume a canonical layout. The failure mode is
 * always the same: a merge that assumed and got it wrong writes a file that
 * still compiles and means something else. A duplicated `const shop`, a
 * resource missing from the returned object, an import list that lost a name —
 * none of these throw at apply time. They surface much later, somewhere else.
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

/** Wrap a callback body in a bindle definition with the standard import. */
function bindleFile(
	body: string,
	importLine = 'import { bindle } from "@hobo/bindles";',
): string {
	return `${importLine}\n\nexport default bindle("demo", (b) => {\n${body}\n});\n`;
}

describe("import shapes the merge has to recognise", () => {
	it("handles a namespace import of the bindles package", () => {
		// `import * as x` has no named bindings, so the "does this file already
		// import what I need" lookup finds nothing. It must not crash, and it must
		// not conclude the module is unimported and add a second declaration —
		// two imports of one module is a TypeScript error.
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
		// The lookup walks every import declaration. Matching on the wrong module
		// would append a name to somebody else's import list.
		const dir = root(
			`import { readFile } from "node:fs/promises";\nimport { bindle } from "@hobo/bindles";\n\nexport default bindle("demo", (b) => {\n  return {};\n});\n`,
		);
		apply(dir);
		expect(read(dir)).toContain(`import { readFile } from "node:fs/promises"`);
	});
});

describe("callback bodies the merge has to read", () => {
	it("skips non-declaration statements when collecting used names", () => {
		// A callback body is not only `const` declarations — it can hold calls,
		// conditionals, comments. Treating every statement as a declaration would
		// either crash or mistake something for a name that is taken.
		const dir = root(
			bindleFile(
				`  console.log("setting up");\n  if (process.env.DEBUG) {\n    console.log("debug");\n  }\n  return {};`,
			),
		);
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("b.api(");
	});

	it("allocates a fresh name when the wanted one is already declared", () => {
		// The collision case. Emitting a second `const shop` would compile and
		// shadow the first — the worst kind of failure here, because the file
		// looks fine and one of the two resources silently disappears.
		const dir = root(
			bindleFile(`  const shop = "something else";\n  return { shop };`),
		);
		apply(dir);
		const source = read(dir);
		expect((source.match(/const shop\b/gu) ?? []).length).toBe(1);
		expect(source).toMatch(/const shop2\b/u);
	});

	it("keeps allocating past a second collision", () => {
		// `shop2` taken as well. A single fallback would collide again and
		// re-introduce the shadowing it exists to prevent.
		const dir = root(
			bindleFile(
				`  const shop = 1;\n  const shop2 = 2;\n  return { shop, shop2 };`,
			),
		);
		apply(dir);
		expect(read(dir)).toMatch(/const shop3\b/u);
	});

	it("adds the new name to a return object that already has properties", () => {
		// The returned object is the bindle's surface. A resource declared but not
		// returned is invisible to everything downstream, and nothing would say so.
		const dir = root(bindleFile(`  const api = b.api();\n  return { api };`));
		apply(dir);
		// Spacing pinned as produced: the new name is spliced in before the
		// closing brace, which leaves `{ api , shop}`. Ugly but syntactically
		// exact, and formatting is the repo formatter's job rather than this
		// merge's — asserting a prettier shape here would fail for a reason that
		// has nothing to do with correctness.
		expect(read(dir)).toMatch(/return \{ api\s*,\s*shop\s*\}/u);
	});

	it("reads a return object written with explicit property assignments", () => {
		// `{ api: api }` rather than `{ api }`. Recognising only the shorthand
		// would make the merge think `api` was unreturned and add it again.
		const dir = root(
			bindleFile(`  const api = b.api();\n  return { api: api };`),
		);
		apply(dir);
		const source = read(dir);
		expect((source.match(/\bapi\b\s*:/gu) ?? []).length).toBe(1);
	});

	it("handles a callback that returns nothing at all", () => {
		// No return statement is legal. Looking for a return literal that is not
		// there must not crash, and the declaration still has to land in the body.
		const dir = root(bindleFile(`  const api = b.api();`));
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("b.api(");
	});

	it("handles a callback returning something other than an object literal", () => {
		// `return someVar;` is not a shape the merge can add a property to, so it
		// must leave the return alone rather than editing it into nonsense.
		const dir = root(
			bindleFile(`  const surface = { api: b.api() };\n  return surface;`),
		);
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("return surface;");
	});

	it("handles an empty return object", () => {
		// No leading comma. `{ , shop }` would not parse, and the merge re-checks
		// its own output — so this would surface as "transformed TypeScript is
		// invalid" rather than a bad file, but it would still fail the apply.
		const dir = root(bindleFile(`  return {};`));
		apply(dir);
		expect(read(dir)).toMatch(/return \{\s*shop\s*\}/u);
	});
});

describe("builder-chain merging", () => {
	const WITH_API = bindleFile(`  const api = b.api();\n  return { api };`);

	it("chains a dependsOn onto the declaration its snippet names", () => {
		// The call has to attach to the declaration it names, not be appended as
		// a free-standing statement — `web.dependsOn(api)` outside the chain is
		// valid TypeScript that does nothing to the bindle graph.
		//
		// The snippet names `web` literally rather than taking it from a param,
		// so the target has to declare `web` for the edge to land.
		const dir = root(
			bindleFile(
				`  const web = b.web();\n  const api = b.api();\n  return { web, api };`,
			),
		);
		apply(dir, "bindle.relationship.depends-on", {});
		expect(read(dir)).toMatch(/const web = b\.web\(\)\.dependsOn\(/u);
	});

	it("does not chain the same call twice", () => {
		// Idempotence at the chain level. A second `.dependsOn(...)` is a
		// duplicate edge the graph then has to reconcile.
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
		// Named in the refusal. Attaching to nothing, or inventing the
		// declaration, would produce a file that either does not compile or
		// declares a resource the author never asked for.
		// The snippet chains onto `web`; a file that declares only `api` has no
		// such symbol, and the refusal names it.
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
		// `let api;` has nothing to chain onto. Appending to the declaration would
		// produce `let api.dependsOn(...)`, which does not parse.
		const dir = root(
			bindleFile(`  let web;\n  const api = b.api();\n  return { api };`),
		);
		expect(() => apply(dir, "bindle.relationship.depends-on", {})).toThrow(
			/unresolved symbol web/u,
		);
	});

	it("chains an annotation onto the declaration its snippet names", () => {
		// This snippet chains onto a symbol literally called `resource`, so the
		// target has to declare one. Pinned rather than parameterised because the
		// name is the snippet's, not the caller's.
		const dir = root(
			bindleFile(`  const resource = b.api();\n  return { resource };`),
		);
		apply(dir, "bindle.annotation.env", {});
		expect(read(dir)).toMatch(/const resource = b\.api\(\)\.with\(/u);
	});

	it("does not add a second annotation of the same method", () => {
		// `initText.includes(".with(")`. A resource carrying two `.with(...)`
		// calls is not obviously wrong to read, which is exactly why a duplicate
		// would survive review.
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
		// The re-parse at the end is the last guard. Every test above would pass
		// on a merge that produced valid-looking garbage; this is what makes the
		// output checkable rather than merely written.
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
		// The count is re-checked on the *output*, so a merge that somehow
		// duplicated the definition is caught before the file is written.
		const dir = root(bindleFile(`  return {};`));
		apply(dir);
		expect((read(dir).match(/bindle\(/gu) ?? []).length).toBe(1);
	});

	it("accumulates several resources across applies", () => {
		// The realistic sequence. Each apply reads the previous output, so an
		// error in the merge compounds rather than staying local.
		const dir = root(bindleFile(`  return {};`));
		apply(dir, "bindle.resource.api", { resourceName: "shop" });
		apply(dir, "bindle.resource.kv-read-write", { resourceName: "cache" });
		const source = read(dir);
		expect(source).toMatch(/const shop\b/u);
		expect(source).toMatch(/const cache\b/u);
		expect((source.match(/bindle\(/gu) ?? []).length).toBe(1);
	});
});
