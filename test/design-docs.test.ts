import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { checkDesignDocs } from "../scripts/check-design-docs.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

async function withDesignFixture(callback: (root: string) => Promise<void>) {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-design-docs-"));

	try {
		await mkdir(path.join(root, "docs", "design", "adr"), { recursive: true });
		await writeFile(
			path.join(root, "docs", "design", "glossary.md"),
			[
				"# HoBo Glossary",
				"",
				"| Term | Definition |",
				"|---|---|",
				"| Bindle | App topology mapped to ports. |",
			].join("\n"),
		);
		await writeFile(
			path.join(root, "docs", "design", "event-families.md"),
			[
				"# Event Families",
				"",
				"| Family | Events |",
				"|---|---|",
				"| `match.*` | `match.Decided` |",
			].join("\n"),
		);
		await writeFile(
			path.join(root, "docs", "design", "adr", "index.md"),
			[
				"# ADR index",
				"",
				"| ID | Title | Theme doc |",
				"|---|---|---|",
				"| 0001 | Example | [architecture-core](01-architecture-core.md#adr-0001) |",
			].join("\n"),
		);
		await writeFile(
			path.join(root, "docs", "design", "adr", "01-architecture-core.md"),
			["# Architecture Core", "", "## ADR-0001"].join("\n"),
		);

		return await callback(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("design doc checker rejects broken relative links and anchors", async () => {
	await withDesignFixture(async (root) => {
		await writeFile(
			path.join(root, "docs", "design", "source.md"),
			[
				"# Source",
				"",
				"[missing file](./missing.md)",
				"[missing anchor](./target.md#missing-section)",
			].join("\n"),
		);
		await writeFile(
			path.join(root, "docs", "design", "target.md"),
			["# Target", "", "Existing content."].join("\n"),
		);

		const result = await checkDesignDocs({ root });

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			["broken-link", "broken-anchor"],
		);
	});
});

test("design doc checker rejects broken same-file anchors", async () => {
	await withDesignFixture(async (root) => {
		await writeFile(
			path.join(root, "docs", "design", "source.md"),
			["# Source", "", "[missing local anchor](#not-here)"].join("\n"),
		);

		const result = await checkDesignDocs({ root });

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			["broken-anchor"],
		);
	});
});

test("design doc checker rejects duplicate canonical glossary terms", async () => {
	await withDesignFixture(async (root) => {
		await writeFile(
			path.join(root, "docs", "design", "glossary.md"),
			[
				"# HoBo Glossary",
				"",
				"| Term | Definition |",
				"|---|---|",
				"| Bindle | App topology mapped to ports. |",
				"| bindle | A conflicting second definition. |",
			].join("\n"),
		);

		const result = await checkDesignDocs({ root });

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			["duplicate-glossary-term"],
		);
	});
});

test("design doc checker rejects ADR references missing from the ADR index", async () => {
	await withDesignFixture(async (root) => {
		await writeFile(
			path.join(root, "docs", "design", "source.md"),
			"This contract cites ADR-9999, which is not indexed.",
		);

		const result = await checkDesignDocs({ root });

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			["unknown-adr-reference"],
		);
	});
});

test("design doc checker requires hobo sdk package disambiguation", async () => {
	await withDesignFixture(async (root) => {
		await writeFile(
			path.join(root, "docs", "design", "source.md"),
			[
				"# SDK terms",
				"",
				"The `hobo:sdk` and `@hobo/sdk` names are both used here.",
			].join("\n"),
		);

		const result = await checkDesignDocs({ root });

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			["missing-sdk-disambiguation"],
		);
	});
});

test("design doc checker rejects event families missing from the catalog", async () => {
	await withDesignFixture(async (root) => {
		await writeFile(
			path.join(root, "docs", "design", "source.md"),
			"The deployment emits `mystery.Decided` when it should use a cataloged family.",
		);

		const result = await checkDesignDocs({ root });

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			["unknown-event-family"],
		);
	});
});

// Cold-CI machines run the doc linters far slower than local dev boxes;
// give the real-repo lint sweep room instead of flaking at the 5s default.
test("repository design docs pass link, ADR, glossary, and event-family lint", {
	timeout: 120_000,
}, async () => {
	const result = await checkDesignDocs({ root: repoRoot });
	assert.deepEqual(result.problems, []);
});
