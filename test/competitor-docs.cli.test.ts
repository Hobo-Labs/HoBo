/**
 * Tests for the checker's CLI surface and its generation/writeback behaviour.
 *
 * These target the regions mutation testing showed were unprotected: the exit
 * code, the problem formatting, the summary line, the generated-block writeback
 * in `--fix` mode, and the category-page row reconciliation. Every one of them
 * is read by CI or by a human on every run, and none of them was reachable from
 * a test until `main` was extracted from a top-level `if`.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
	CATEGORIES,
	checkCompetitorDocs,
	main,
} from "../scripts/check-competitor-docs.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");

const cliCaptureDefaults = {
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
	research_date: "2026-01-01",
};

type CliCaptureOverrides = Partial<typeof cliCaptureDefaults> & {
	contract?: string | undefined;
};

function capture(overrides: CliCaptureOverrides = {}) {
	const fields = {
		...cliCaptureDefaults,
		research_date: "2026-05-01",
		contract: "v1",
		...overrides,
	};
	const lines = ["---", "type: Competitive Reference", "competitor:"];
	for (const [key, value] of Object.entries(fields))
		if (value !== undefined) lines.push(`  ${key}: ${value}`);
	lines.push("  sources:", "    - https://acme.example/docs", "---", "");
	// Every contract section, so section checking is satisfied by default and
	// each test isolates the one rule it is about.
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
	return [
		`# ${title}`,
		"",
		`<!-- BEGIN GENERATED: ${name} -->`,
		`<!-- END GENERATED: ${name} -->`,
		"",
	].join("\n");
}

const CATEGORY_PAGE = [
	"# Infrastructure-from-Code",
	"",
	"| Competitor |",
	"| ---------- |",
	"| [Acme](../acme.md) |",
	"",
].join("\n");

async function corpus(files: Record<string, string> = {}) {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-competitor-cli-"));
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
		"docs/competitors/acme.md": capture(),
		"docs/competitors/categories/infrastructure-from-code.md": CATEGORY_PAGE,
		...files,
	};
	for (const [rel, content] of Object.entries(all))
		await writeFile(path.join(root, rel), content);
	return root;
}

test("main returns 0 and reports the capture count on a clean corpus", async () => {
	const root = await corpus();
	const logs: string[] = [];
	const errors: string[] = [];
	// A clean corpus still needs its generated blocks filled in first.
	await main({
		root,
		argv: ["--fix"],
		now: NOW,
		log: () => {},
		error: () => {},
	});

	const code = await main({
		root,
		argv: [],
		now: NOW,
		log: (m) => logs.push(m),
		error: (m) => errors.push(m),
	});

	expect(code).toBe(0);
	expect(errors).toEqual([]);
	expect(logs).toHaveLength(1);
	expect(logs[0]).toBe(
		"competitor-docs: 1 canonical captures checked, 0 problem(s).",
	);
});

test("main returns 1 and formats every problem as file:line message", async () => {
	const root = await corpus({
		"docs/competitors/acme.md": capture({ directness: "somewhat" }),
	});
	const logs: string[] = [];
	const errors: string[] = [];

	const code = await main({
		root,
		argv: [],
		now: NOW,
		log: (m) => logs.push(m),
		error: (m) => errors.push(m),
	});

	expect(code).toBe(1);
	expect(errors.length).toBeGreaterThan(0);
	for (const line of errors)
		expect(line).toMatch(/^[\w./-]+:\d+ competitor-docs - .+/);
	expect(errors.some((line) => line.includes('"somewhat" is not one of'))).toBe(
		true,
	);
	// The summary still prints, and its problem count matches what was emitted.
	expect(logs[0]).toContain(`${errors.length} problem(s).`);
});

test("main passes --fix through, so a second run is clean", async () => {
	const root = await corpus();

	const first = await main({
		root,
		argv: [],
		now: NOW,
		log: () => {},
		error: () => {},
	});
	expect(first).toBe(1); // generated blocks are empty

	const fixed = await main({
		root,
		argv: ["node", "check", "--fix"],
		now: NOW,
		log: () => {},
		error: () => {},
	});
	expect(fixed).toBe(0);

	const again = await main({
		root,
		argv: [],
		now: NOW,
		log: () => {},
		error: () => {},
	});
	expect(again).toBe(0);
});

test("--fix writes the generated blocks and preserves surrounding content", async () => {
	const root = await corpus({
		"docs/competitors/matrix.md": [
			"# Matrix",
			"",
			"Prose above the block.",
			"",
			"<!-- BEGIN GENERATED: competitor-matrix -->",
			"stale content",
			"<!-- END GENERATED: competitor-matrix -->",
			"",
			"Prose below the block.",
			"",
		].join("\n"),
	});

	await checkCompetitorDocs({ root, fix: true, now: NOW });
	const text = await readFile(
		path.join(root, "docs/competitors/matrix.md"),
		"utf8",
	);

	expect(text).toContain("Prose above the block.");
	expect(text).toContain("Prose below the block.");
	expect(text).not.toContain("stale content");
	expect(text).toContain("| **Acme** |");
	// Markers survive exactly once each — a writeback that duplicated them would
	// corrupt every later run.
	expect(text.match(/BEGIN GENERATED: competitor-matrix/g)).toHaveLength(1);
	expect(text.match(/END GENERATED: competitor-matrix/g)).toHaveLength(1);
});

test("a missing generated marker is reported rather than silently skipped", async () => {
	const root = await corpus({
		"docs/competitors/matrix.md": "# Matrix\n\nno markers here\n",
	});
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	expect(
		problems.some((p) => p.message.includes("missing generated markers")),
	).toBe(true);
});

test("a missing generated file is reported with its own message", async () => {
	const root = await corpus();
	const { problems } = await checkCompetitorDocs({
		root: path.join(root, "nonexistent"),
		now: NOW,
	});
	expect(problems.some((p) => p.message.includes("missing"))).toBe(true);
});

test("an out-of-date generated block reports the line the block starts on", async () => {
	const root = await corpus({
		"docs/competitors/matrix.md": [
			"# Matrix",
			"",
			"line three",
			"",
			"<!-- BEGIN GENERATED: competitor-matrix -->",
			"<!-- END GENERATED: competitor-matrix -->",
			"",
		].join("\n"),
	});
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	const stale = problems.find((p) => p.message.includes("is out of date"));
	expect(stale).toBeDefined();
	// Five lines precede the marker, so the block starts on line 5.
	expect(stale?.line).toBe(5);
});

test("a category page missing a member's row is reported", async () => {
	const root = await corpus({
		"docs/competitors/categories/infrastructure-from-code.md":
			"# Infrastructure-from-Code\n\nno rows\n",
	});
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	expect(
		problems.some((p) => p.message.includes("missing row linking ../acme.md")),
	).toBe(true);
});

test("a category page linking a non-capture is reported", async () => {
	const root = await corpus({
		"docs/competitors/categories/infrastructure-from-code.md": `${CATEGORY_PAGE}\n| [Ghost](../ghost.md) |\n`,
	});
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	expect(
		problems.some((p) =>
			p.message.includes("links ../ghost.md, which is not a canonical"),
		),
	).toBe(true);
});

test("a category page linking a capture that does not declare it is reported", async () => {
	const root = await corpus({
		"docs/competitors/categories/runtime-substrates.md":
			"# Runtime substrates\n\n| [Acme](../acme.md) |\n",
	});
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	expect(
		problems.some((p) =>
			p.message.includes('does not declare category "runtime-substrates"'),
		),
	).toBe(true);
});

test("navigation links back to the corpus are not mistaken for rows", async () => {
	const root = await corpus({
		"docs/competitors/categories/infrastructure-from-code.md": [
			CATEGORY_PAGE,
			"",
			"- [All categories](index.md) · [corpus index](../index.md) · [matrix](../matrix.md) · [gaps](../gap-analysis.md)",
			"",
		].join("\n"),
	});
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	for (const problem of problems)
		expect(problem.message).not.toContain("is not a canonical competitor");
});

test("a category page outside the closed vocabulary is reported", async () => {
	const root = await corpus({
		"docs/competitors/categories/invented-category.md": "# Invented\n",
	});
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	expect(
		problems.some((p) =>
			p.message.includes('"invented-category" is not a category'),
		),
	).toBe(true);
});

test("a missing category page is reported because the vocabulary is closed", async () => {
	const root = await corpus();
	const { unlink } = await import("node:fs/promises");
	await unlink(
		path.join(root, "docs/competitors/categories/self-hosted-paas.md"),
	);
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	expect(
		problems.some((p) => p.message.includes("missing category index")),
	).toBe(true);
});

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

test("a matrix generated on one day passes the check on every later day", async () => {
	const root = await corpus({
		"docs/competitors/acme.md": capture({ research_date: "2026-05-01" }),
	});
	await checkCompetitorDocs({ root, fix: true, now: NOW });
	// 30 days on, and 400 days on, which carries the capture across the
	// 180-day staleness line. Neither may call for a regeneration.
	for (const days of [30, 400]) {
		const { problems } = await checkCompetitorDocs({
			root,
			now: NOW + days * DAY,
		});
		expect(problems, `${days} days later`).toEqual([]);
	}
});

test("the generated matrix is the same bytes on every day", async () => {
	const matrixAt = async (now: number) => {
		const root = await corpus({
			"docs/competitors/acme.md": capture({ research_date: "2026-05-01" }),
		});
		await checkCompetitorDocs({ root, fix: true, now });
		return readFile(path.join(root, "docs/competitors/matrix.md"), "utf8");
	};
	expect(await matrixAt(NOW + 400 * DAY)).toBe(await matrixAt(NOW));
});

test("the check lists a capture older than 180 days, by the clock it runs on", async () => {
	const root = await corpus({
		"docs/competitors/acme.md": capture({ research_date: "2026-05-01" }),
	});
	await checkCompetitorDocs({ root, fix: true, now: NOW });
	const run = async (now: number) => {
		const logs: string[] = [];
		const code = await main({
			root,
			argv: [],
			now,
			log: (m) => logs.push(m),
			error: () => {},
		});
		return { code, out: logs.join("\n") };
	};

	const early = await run(NOW);
	expect(early.code).toBe(0);
	expect(early.out).not.toContain("older than 180 days");

	// The same committed files, 400 days later: still clean, and now listed.
	const late = await run(NOW + 400 * DAY);
	expect(late.code).toBe(0);
	expect(late.out).toContain("1 capture(s) older than 180 days");
	expect(late.out).toContain("acme");
	expect(late.out).toContain("2026-05-01");
});

test("a capture is stale from the 181st day, not the 180th", async () => {
	const researched = (daysOld: number) =>
		corpus({
			"docs/competitors/acme.md": capture({
				research_date: isoDay(NOW - daysOld * DAY),
			}),
		});
	const listed = async (root: string) => {
		await checkCompetitorDocs({ root, fix: true, now: NOW });
		const logs: string[] = [];
		await main({
			root,
			argv: [],
			now: NOW,
			log: (m) => logs.push(m),
			error: () => {},
		});
		return logs.join("\n").includes("older than 180 days");
	};
	expect(await listed(await researched(180))).toBe(false);
	expect(await listed(await researched(181))).toBe(true);
});

test("staleness never turns into a build failure", async () => {
	const root = await corpus({
		"docs/competitors/acme.md": capture({ research_date: "2020-01-01" }),
	});
	await checkCompetitorDocs({ root, fix: true, now: NOW });
	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	expect(problems).toEqual([]);
});

test("a pre-v1 capture is exempt from section checks but marked in the ledger", async () => {
	const root = await corpus({
		"docs/competitors/acme.md": [
			// SAFETY: assertion to ` contract: undefined }).split("\n## ")[0] as string, "", ` is required at this boundary.
			capture({ contract: undefined }).split("\n## ")[0] as string,
			"",
		].join("\n"),
	});
	await checkCompetitorDocs({ root, fix: true, now: NOW });
	const matrix = await readFile(
		path.join(root, "docs/competitors/matrix.md"),
		"utf8",
	);
	expect(matrix).toContain("pre-v1");

	const { problems } = await checkCompetitorDocs({ root, now: NOW });
	// No section problems: the exemption is the whole point of the marker.
	expect(problems.filter((p) => p.message.includes("section"))).toEqual([]);
});
