/**
 * Boundary tests for the checker's regexes and guard conditions.
 *
 * Written against a mutation-testing report rather than by reading the code and
 * guessing. Each block below corresponds to a mutant that survived — a change
 * the previous suite could not see — so these are the assertions that turn
 * "the tests execute this line" into "the tests would notice if it changed".
 *
 * Regex mutants are the bulk of them, and they share a shape: a pattern is only
 * pinned by inputs that sit on *both* sides of its boundary. Testing that
 * `research_date: 2026-05-01` is accepted proves nothing about the pattern;
 * testing that `2026-5-1` and `20260501` are rejected proves what it means.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
	CATEGORIES,
	checkCompetitorDocs,
	frontMatter,
	parseBlock,
} from "../scripts/check-competitor-docs.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Front-matter delimiter regex: /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
// ---------------------------------------------------------------------------

test("front matter must open at the very start of the document", () => {
	expect(frontMatter("\n---\ncompetitor:\n  slug: a\n---\n")).toBeUndefined();
	expect(frontMatter(" ---\ncompetitor:\n---\n")).toBeUndefined();
	expect(frontMatter("---\ncompetitor:\n  slug: a\n---\n")).toBeDefined();
});

test("front matter is non-greedy: a later --- does not swallow the body", () => {
	const parsed = frontMatter(
		"---\ncompetitor:\n  slug: a\n---\n# Body\n\n---\n\nmore\n",
	);
	expect(parsed?.raw.slug).toBe("a");
	expect(parsed?.body).toContain("# Body");
	expect(parsed?.body).toContain("more");
});

test("front matter requires a closing delimiter", () => {
	expect(frontMatter("---\ncompetitor:\n  slug: a\n")).toBeUndefined();
	expect(frontMatter("---\ncompetitor:\n  slug: a\n--\n")).toBeUndefined();
});

/**
 * A pinned laxness rather than a rule: the closing delimiter is matched as
 * `\n---`, so anything trailing on that line is left in the body instead of
 * rejecting the document. Real captures never do this, and tightening it would
 * be a behaviour change — recorded here so it stays a decision.
 */
test("trailing text after the closing delimiter falls into the body", () => {
	const parsed = frontMatter("---\ncompetitor:\n  slug: a\n--- trailing\n");
	expect(parsed?.raw.slug).toBe("a");
	expect(parsed?.body).toBe(" trailing\n");
});

test("front matter tolerates CRLF but not a bare CR", () => {
	expect(
		frontMatter("---\r\ncompetitor:\r\n  slug: a\r\n---\r\n"),
	).toBeDefined();
	expect(frontMatter("---\rcompetitor:\r  slug: a\r---\r")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Block-open regex: /^competitor:\s*$/
// ---------------------------------------------------------------------------

test("the competitor block opens only on an unindented, value-free key", () => {
	expect(parseBlock("competitor:\n  slug: a\n")).toEqual({ slug: "a" });
	// Indented: not the block opener.
	expect(parseBlock("  competitor:\n  slug: a\n")).toEqual({});
	// Carries a value: not the block opener.
	expect(parseBlock("competitor: inline\n  slug: a\n")).toEqual({});
	// A prefix match is not a match.
	expect(parseBlock("competitors:\n  slug: a\n")).toEqual({});
	// Trailing whitespace is allowed.
	expect(parseBlock("competitor:   \n  slug: a\n")).toEqual({ slug: "a" });
});

// ---------------------------------------------------------------------------
// Sequence-item regex: /^\s+-\s+(.*)$/ and the dedent guard /^\s/
// ---------------------------------------------------------------------------

test("a sequence item needs indentation, a dash, and a space", () => {
	expect(parseBlock("competitor:\n  sources:\n    - one\n")).toEqual({
		sources: ["one"],
	});
	// No space after the dash: not an item, and it is not a key either.
	expect(parseBlock("competitor:\n  sources:\n    -one\n")).toEqual({
		sources: [],
	});
	// Unindented dash ends the block entirely.
	expect(parseBlock("competitor:\n  sources:\n- one\n")).toEqual({
		sources: [],
	});
});

test("the first unindented line ends the competitor block", () => {
	expect(
		parseBlock("competitor:\n  slug: a\ntags: [x]\n  role: ignored\n"),
	).toEqual({ slug: "a" });
});

// ---------------------------------------------------------------------------
// Key regex: /^\s+([a-z_]+):\s*(.*)$/
// ---------------------------------------------------------------------------

test("keys are lowercase-and-underscore only, and must be indented", () => {
	expect(parseBlock("competitor:\n  research_date: 2026-01-01\n")).toEqual({
		research_date: "2026-01-01",
	});
	// Digits are not in the key class.
	expect(parseBlock("competitor:\n  slug2: a\n")).toEqual({});
	// Hyphens are not in the key class.
	expect(parseBlock("competitor:\n  hobo-surface: a\n")).toEqual({});
	// Uppercase is not in the key class.
	expect(parseBlock("competitor:\n  Slug: a\n")).toEqual({});
});

test("a key with no value opens a sequence rather than storing an empty string", () => {
	expect(parseBlock("competitor:\n  sources:\n")).toEqual({ sources: [] });
	expect(parseBlock("competitor:\n  sources:   \n")).toEqual({ sources: [] });
});

// ---------------------------------------------------------------------------
// unquote: /^(['"])([\s\S]*)\1$/
// ---------------------------------------------------------------------------

test("quotes are stripped only when they match and wrap the whole value", () => {
	expect(parseBlock('competitor:\n  role: "quoted"\n')).toEqual({
		role: "quoted",
	});
	expect(parseBlock("competitor:\n  role: 'quoted'\n")).toEqual({
		role: "quoted",
	});
	// Mismatched delimiters are not a quoted string.
	expect(parseBlock("competitor:\n  role: \"mixed'\n")).toEqual({
		role: "\"mixed'",
	});
	// Quotes inside the value are left alone.
	expect(parseBlock('competitor:\n  role: a "b" c\n')).toEqual({
		role: 'a "b" c',
	});
	// A quoted value may span the whole string including newline-ish content.
	expect(parseBlock('competitor:\n  role: ""\n')).toEqual({ role: "" });
});

// ---------------------------------------------------------------------------
// Field validation regexes
// ---------------------------------------------------------------------------

function capture(
	overrides: Partial<{
		slug: string;
		name: string;
		primary_category: string;
		categories: string;
		directness: string;
		role: string;
		posture: string;
		hobo_surface: string;
		evidence: string;
		status: string;
		research_date: string;
		contract: string;
	}> = {},
) {
	const fields = {
		slug: "acme",
		name: '"Acme"',
		primary_category: "infrastructure-from-code",
		categories: "[infrastructure-from-code]",
		directness: "direct",
		role: '"authoring analog"',
		posture: "[borrow]",
		hobo_surface: "[authoring]",
		evidence: "design-only",
		status: "active",
		research_date: "2026-05-01",
		contract: "v1",
		...overrides,
	};
	const lines = ["---", "type: Competitive Reference", "competitor:"];
	for (const [key, value] of Object.entries(fields))
		if (value !== undefined) lines.push(`  ${key}: ${value}`);
	lines.push("  sources:", "    - https://acme.example/docs", "---", "");
	lines.push(
		"# Acme",
		"",
		"## What it is",
		"## Core primitives and mental model",
		"## Feature surface",
		"## Architecture",
		"## How it competes with HoBo",
		"## Primitive mapping",
		"## Where Acme is stronger",
		"## Where HoBo is stronger or intentionally different",
		"## Adversarial critique",
		"## Better-together / integration posture",
		"## Threats and lessons",
		"## Sources",
		"",
	);
	return lines.join("\n");
}

function generated(name: string, title: string) {
	return `# ${title}\n\n<!-- BEGIN GENERATED: ${name} -->\n<!-- END GENERATED: ${name} -->\n`;
}

async function corpus(files: Record<string, string> = {}, slug = "acme") {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-competitor-bounds-"));
	await mkdir(path.join(root, "docs", "competitors", "categories"), {
		recursive: true,
	});
	const all = {
		"docs/competitors/index.md": generated("competitor-index", "Index"),
		"docs/competitors/matrix.md": generated("competitor-matrix", "Matrix"),
		"docs/competitors/categories/index.md": generated(
			"category-index",
			"Categories",
		),
		...Object.fromEntries(
			CATEGORIES.map((category) => [
				`docs/competitors/categories/${category}.md`,
				`# ${category}\n`,
			]),
		),
		[`docs/competitors/${slug}.md`]: capture(),
		"docs/competitors/categories/infrastructure-from-code.md": `# IfC\n\n| [Acme](../${slug}.md) |\n`,
		...files,
	};
	for (const [rel, content] of Object.entries(all))
		await writeFile(path.join(root, rel), content);
	return root;
}

async function messages(files: Record<string, string>, slug?: string) {
	const root = await corpus(files, slug);
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	return problems.map((p) => p.message);
}

test("research_date must be exactly YYYY-MM-DD", async () => {
	for (const bad of [
		"2026-5-1",
		"20260501",
		"2026-05-01T00:00:00Z",
		"26-05-01",
	])
		expect(
			(
				await messages({
					"docs/competitors/acme.md": capture({ research_date: bad }),
				})
			).some((m) => m.includes("research_date")),
			`expected "${bad}" to be rejected`,
		).toBe(true);

	expect(
		(
			await messages({
				"docs/competitors/acme.md": capture({ research_date: "2026-05-01" }),
			})
		).some((m) => m.includes("research_date")),
	).toBe(false);
});

test("a slug must be lowercase alphanumeric segments joined by single hyphens", async () => {
	for (const bad of ["Acme", "acme_corp", "acme--corp", "-acme", "acme-"])
		expect(
			(
				await messages(
					{ [`docs/competitors/${bad}.md`]: capture({ slug: bad }) },
					bad,
				)
			).some((m) => m.includes("is not a valid slug")),
			`expected "${bad}" to be rejected`,
		).toBe(true);
});

test("a slug that is valid but does not match the filename is reported", async () => {
	expect(
		await messages({ "docs/competitors/acme.md": capture({ slug: "other" }) }),
	).toContainEqual(expect.stringContaining("must match the filename"));
});

// ---------------------------------------------------------------------------
// Section-heading matching
// ---------------------------------------------------------------------------

test("the competitor-strengths heading is matched by shape, not exact name", async () => {
	const withPlural = capture().replace(
		"## Where Acme is stronger",
		"## Where these hosts are stronger",
	);
	expect(
		(await messages({ "docs/competitors/acme.md": withPlural })).some((m) =>
			m.includes("Where <competitor> is stronger"),
		),
	).toBe(false);
});

test("the HoBo-strengths heading does not satisfy the competitor-strengths section", async () => {
	const dropped = capture().replace("## Where Acme is stronger\n", "");
	expect(
		(await messages({ "docs/competitors/acme.md": dropped })).some((m) =>
			m.includes("Where <competitor> is stronger"),
		),
	).toBe(true);
});

test("heading matching ignores level and leading hashes", async () => {
	const asH3 = capture().replace(
		"## Where Acme is stronger",
		"### Where Acme is stronger",
	);
	expect(
		(await messages({ "docs/competitors/acme.md": asH3 })).some((m) =>
			m.includes("Where <competitor> is stronger"),
		),
	).toBe(false);
});

// ---------------------------------------------------------------------------
// Link checking: /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g and /^(https?:|mailto:|#)/
// ---------------------------------------------------------------------------

test("external, mailto and anchor targets are skipped by the link checker", async () => {
	const withLinks = `${capture()}\n[a](https://example.com/x) [b](http://example.com) [c](mailto:x@example.com) [d](#anchor)\n`;
	expect(
		(await messages({ "docs/competitors/acme.md": withLinks })).some((m) =>
			m.includes("broken relative link"),
		),
	).toBe(false);
});

test("a broken relative link is reported", async () => {
	const withLink = `${capture()}\n[gone](./nope.md)\n`;
	expect(
		(await messages({ "docs/competitors/acme.md": withLink })).some((m) =>
			m.includes("broken relative link"),
		),
	).toBe(true);
});

test("a link with a title attribute still resolves its target", async () => {
	const withTitle = `${capture()}\n[gone](./nope.md "a title")\n`;
	expect(
		(await messages({ "docs/competitors/acme.md": withTitle })).some((m) =>
			m.includes("broken relative link"),
		),
	).toBe(true);
});

test("a protocol-relative or scheme-like target is not treated as a file", async () => {
	const tricky = `${capture()}\n[a](https://example.com/a.md) [b](#/not-a-path)\n`;
	expect(
		(await messages({ "docs/competitors/acme.md": tricky })).some((m) =>
			m.includes("broken relative link"),
		),
	).toBe(false);
});

// ---------------------------------------------------------------------------
// Required-field guard: undefined vs empty array
// ---------------------------------------------------------------------------

test("an empty list is treated as missing, not as a present empty value", async () => {
	expect(
		(
			await messages({
				"docs/competitors/acme.md": capture({ categories: "[]" }),
			})
		).some((m) => m.includes("categories is required")),
	).toBe(true);
	expect(
		(
			await messages({
				"docs/competitors/acme.md": capture({ posture: "[]" }),
			})
		).some((m) => m.includes("posture is required")),
	).toBe(true);
});

test("every required field is reported by name when absent", async () => {
	const fields = [
		"slug",
		"name",
		"primary_category",
		"categories",
		"directness",
		"role",
		"posture",
		"hobo_surface",
		"evidence",
		"status",
		"research_date",
	];
	for (const field of fields) {
		const found = await messages({
			"docs/competitors/acme.md": capture({ [field]: undefined }),
		});
		expect(
			found.some((m) => m.includes(`competitor.${field} is required`)),
			`expected a required-field problem for ${field}`,
		).toBe(true);
	}
});

// ---------------------------------------------------------------------------
// Directory listing: .md filter and sort
// ---------------------------------------------------------------------------

test("non-markdown files in the corpus directory are ignored", async () => {
	const root = await corpus();
	await writeFile(path.join(root, "docs/competitors/notes.txt"), "not a doc");
	await writeFile(path.join(root, "docs/competitors/.DS_Store"), "junk");
	const { problems, competitors } = await checkCompetitorDocs({
		root,
		fix: true,
		now: NOW,
	});
	expect(competitors.map((c) => c.slug)).toEqual(["acme"]);
	expect(problems).toEqual([]);
});

test("a missing corpus directory yields no captures rather than throwing", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-competitor-empty-"));
	await expect(checkCompetitorDocs({ root, now: NOW })).resolves.toBeDefined();
});

// ---------------------------------------------------------------------------
// Problem line numbers
// ---------------------------------------------------------------------------

test("a problem points at the competitor block's line, not line 1", async () => {
	const root = await corpus();
	const { problems } = await checkCompetitorDocs({
		root: await corpus({
			"docs/competitors/acme.md": capture({ directness: "wrong" }),
		}),
		now: NOW,
	});
	const enumProblem = problems.find((p) => p.message.includes("is not one of"));
	expect(enumProblem?.line).toBeGreaterThan(1);
	expect(root).toBeDefined();
});
