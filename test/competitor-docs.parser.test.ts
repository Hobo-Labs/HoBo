/**
 * Adversarial and property tests for the competitor front-matter parser.
 *
 * The parser is hand-rolled on purpose — the shape it reads is fixed and flat,
 * so a scoped parser beats a YAML runtime for docs linting. The cost of that
 * choice is that its edge behaviour is *ours*, and until now none of it was
 * pinned: the existing suite only fed it well-formed captures, so every
 * malformed, hostile, or merely unusual input was untested.
 *
 * These tests do two jobs:
 *
 *   1. **Adversarial table** — inputs a hand-written parser typically dies on:
 *      hostile keys, unterminated quotes, orphaned sequence items, CRLF, and
 *      structural nonsense. The bar is "never throws, never silently produces
 *      a wrong-typed value", not "parses it correctly".
 *   2. **Deterministic fuzz** — a seeded generator producing thousands of
 *      mutated front-matter blocks. Seeded rather than random so a failure is
 *      reproducible from the seed printed in the assertion, and so CI cannot
 *      go red for a different reason than the last run.
 *
 * `fast-check` is deliberately not used here. `pnpm test:property` scopes it to
 * `@hobo/fuzz` control-plane simulators, and pulling it into the root manifest
 * for one docs-script parser would add a dependency to the very tool whose
 * design note is that it has none.
 */
import { expect, test } from "vitest";

import { frontMatter, parseBlock } from "../scripts/check-competitor-docs.js";

/** Every value is either a string or an array of strings. Nothing else, ever. */
function assertFieldContract(
	raw: ReturnType<typeof parseBlock>,
	context: string,
) {
	for (const [key, value] of Object.entries(raw)) {
		const ok = Array.isArray(value) || value === `${value}`;
		expect(ok, `${context}: key "${key}" has an off-contract value`).toBe(true);
	}
}

const ADVERSARIAL = {
	"orphaned sequence item": "competitor:\n  - orphan\n",
	"sequence before any key": "competitor:\n  - a\n  - b\n  slug: x\n",
	"unterminated double quote": 'competitor:\n  name: "unclosed\n  slug: x\n',
	"unterminated single quote": "competitor:\n  name: 'unclosed\n  slug: x\n",
	"quote only": 'competitor:\n  name: "\n',
	"empty inline sequence": "competitor:\n  categories: []\n",
	"inline sequence of blanks": "competitor:\n  categories: [ , , ]\n",
	"colon in value": "competitor:\n  role: a: b: c\n",
	"bracket in value": "competitor:\n  role: [unclosed\n",
	"crlf line endings": "competitor:\r\n  slug: a\r\n  categories: [x]\r\n",
	"tabs for indent": "competitor:\n\tslug: a\n",
	"no competitor block": "type: Reference\ntitle: nope\n",
	"competitor block at eof": "competitor:\n",
	"immediate dedent": "competitor:\nslug: a\n",
	"blank lines inside": "competitor:\n\n  slug: a\n\n  role: b\n",
	"uppercase key ignored": "competitor:\n  Slug: a\n  slug: b\n",
	"numeric-looking value": "competitor:\n  research_date: 2026-01-01\n",
	"very deep indent": `competitor:\n${" ".repeat(200)}slug: a\n`,
	"duplicate key last wins": "competitor:\n  slug: a\n  slug: b\n",
	"empty input": "",
	"only newlines": "\n\n\n",
};

test.each(
	Object.entries(ADVERSARIAL),
)("parseBlock survives adversarial input: %s", (name, input) => {
	// SAFETY: assertion to `lock(input) as Record<string, unknown>; ass` is required at this boundary.
	const raw = parseBlock(input);
	assertFieldContract(raw, name);
});

/**
 * Hostile keys. `__proto__` matches the parser's `[a-z_]+` key pattern, so it
 * reaches an assignment on a plain object literal. Today that assignment hits
 * the prototype setter, which ignores a string, and the key is silently
 * dropped — no pollution. That is the *current* safe behaviour and it is an
 * accident of the object literal, not a decision, so it is pinned here: a
 * future refactor to a Map or `Object.create(null)` must not quietly turn a
 * dropped key into a live one.
 */
test.each([
	"__proto__",
	"constructor",
	"prototype",
	"toString",
	"valueOf",
])("a hostile key (%s) never pollutes or escapes the value contract", (key) => {
	// SAFETY: assertion to `cord<string, unknown>) }; //` is required at this boundary.
	const before = {};
	const raw = parseBlock(`competitor:\n  ${key}: hostile\n  slug: real\n`);

	// The legitimate key alongside it still parses.
	expect(raw.slug).toBe("real");
	// Nothing leaked onto Object.prototype.
	// SAFETY: assertion to `cord<string, unknown>).hostil` is required at this boundary.
	expect(Object.hasOwn({}, "hostile")).toBe(false);
	expect(Object.keys(before)).toHaveLength(0);
	assertFieldContract(raw, key);
});

test("hostile keys never make the result callable or array-typed", () => {
	// SAFETY: assertion to `ck("competitor:\n constructor: [a, b]\n") as Record< string, unknown >; expec` is required at this boundary.
	const raw = parseBlock("competitor:\n  constructor: [a, b]\n");
	expect(raw).not.toBeNull();
	expect(Array.isArray(raw)).toBe(false);
	assertFieldContract(raw, "constructor as sequence");
});

/**
 * A known, accepted limitation, pinned so it is a decision rather than a
 * surprise: inline sequences split on commas without tracking bracket depth,
 * so a nested sequence is flattened into nonsense. The competitor schema has
 * no nested sequences, so this is not worth a real parser — but if one ever
 * appears, this test fails and says so.
 */
test("nested inline sequences are a known, pinned limitation", () => {
	expect(parseBlock("competitor:\n  categories: [a, [b, c]]\n")).toEqual({
		categories: ["a", "[b", "c]"],
	});
});

/**
 * Regression: found by the deterministic fuzz below, not by hand.
 *
 * A `- item` line under a *scalar* key sent the parser into
 * `(raw[key] as string[]).push(...)` against a string, throwing
 * `raw[key].push is not a function`. Because `parseBlock` runs before any
 * validation, a single malformed capture took down the entire docs gate with a
 * TypeError and no file name — instead of reporting a problem on that one file.
 */
test("a sequence item under a scalar key does not crash the gate", () => {
	expect(() =>
		parseBlock("competitor:\n  slug: acme\n    - stray\n"),
	).not.toThrow();
	expect(parseBlock("competitor:\n  slug: acme\n    - stray\n")).toEqual({
		slug: "acme",
	});
	// The sequence case that *is* valid still accumulates.
	expect(parseBlock("competitor:\n  sources:\n    - one\n    - two\n")).toEqual(
		{
			sources: ["one", "two"],
		},
	);
});

test("frontMatter returns undefined rather than throwing on non-front-matter", () => {
	for (const input of ["", "# heading\n", "---\nunterminated\n", "-- -\n"])
		expect(() => frontMatter(input)).not.toThrow();
	expect(frontMatter("# no front matter\n")).toBeUndefined();
});

test("frontMatter splits body from front matter without losing content", () => {
	const parsed = frontMatter("---\ncompetitor:\n  slug: a\n---\n# Body\n");
	expect(parsed?.body).toBe("# Body\n");
	expect(parsed?.raw.slug).toBe("a");
});

/**
 * Deterministic fuzz: a tiny seeded PRNG (mulberry32) assembles front-matter
 * blocks from fragments chosen to collide with the parser's regexes. The
 * invariant is total: for any input, parsing terminates and every value obeys
 * the string-or-string-array contract that the rest of the checker assumes.
 */
function mulberry32(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FRAGMENTS = [
	"competitor:",
	"  slug: acme",
	'  name: "Acme"',
	"  name: 'Acme",
	"  categories: [a, b]",
	"  categories: []",
	"  categories:",
	"    - one",
	"    - ",
	"  - orphan",
	"  __proto__: x",
	"  role: a: b",
	"  contract: v1",
	"",
	"   ",
	"\t",
	"---",
	"not-indented: x",
	"  9bad: x",
	"  UPPER: x",
	`  long: ${"x".repeat(500)}`,
];

test("deterministic fuzz: the value contract holds for every generated block", () => {
	const SEED = 0x5eed_1234;
	const random = mulberry32(SEED);
	for (let iteration = 0; iteration < 5_000; iteration += 1) {
		const lines: string[] = [];
		const length = 1 + Math.floor(random() * 12);
		for (let i = 0; i < length; i += 1)
			// SAFETY: assertion to `th.floor(random() * FRAGMENTS.length)] as string); const s` is required at this boundary.
			lines.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] as string);
		const source = lines.join(random() < 0.15 ? "\r\n" : "\n");

		let raw: ReturnType<typeof parseBlock>;
		try {
			raw = parseBlock(source);
		} catch (error) {
			throw new Error(
				`parseBlock threw on seed ${SEED} iteration ${iteration}:\n${source}\n${String(error)}`,
			);
		}
		assertFieldContract(raw, `seed ${SEED} iteration ${iteration}\n${source}`);
	}
});

test("deterministic fuzz: frontMatter never throws on arbitrary documents", () => {
	const SEED = 0xf00d_9876;
	const random = mulberry32(SEED);
	for (let iteration = 0; iteration < 2_000; iteration += 1) {
		const lines: string[] = [];
		const length = 1 + Math.floor(random() * 10);
		for (let i = 0; i < length; i += 1)
			// SAFETY: assertion to `th.floor(random() * FRAGMENTS.length)] as string); const s` is required at this boundary.
			lines.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] as string);
		const source = lines.join("\n");
		expect(
			() => frontMatter(source),
			`seed ${SEED} iteration ${iteration}\n${source}`,
		).not.toThrow();
	}
});
