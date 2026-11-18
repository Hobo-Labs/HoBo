import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { checkDocumentationLinks } from "../scripts/check-documentation-links.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

async function withDocumentationFixture(
	callback: (root: string) => Promise<void>,
) {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-documentation-links-"));
	try {
		await mkdir(path.join(root, "docs", "technologies"), { recursive: true });
		await callback(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("checks relative files and anchors in supported documentation", async () => {
	await withDocumentationFixture(async (root) => {
		await writeFile(
			path.join(root, "docs", "technologies", "source.md"),
			[
				"# Source",
				"[missing file](./missing.md)",
				"[missing anchor](./target.md#missing-section)",
				"[missing local anchor](#not-here)",
				"[valid anchor](./target.md#custom)",
			].join("\n"),
		);
		await writeFile(
			path.join(root, "docs", "technologies", "target.md"),
			"# Target {#custom}\n",
		);

		const { problems } = await checkDocumentationLinks({ root });
		assert.deepEqual(problems.map(({ code }) => code).sort(), [
			"broken-anchor",
			"broken-anchor",
			"broken-link",
		]);
		assert.deepEqual(problems.map(({ line }) => line).sort(), [2, 3, 4]);
	});
});

test("checks explicitly selected documentation files", async () => {
	await withDocumentationFixture(async (root) => {
		await writeFile(path.join(root, "README.md"), "[missing](./missing.md)\n");
		await writeFile(path.join(root, "CLAUDE.md"), "[missing](./missing.md)\n");

		const { problems } = await checkDocumentationLinks({
			root,
			files: ["README.md"],
		});
		assert.deepEqual(
			problems.map(({ file }) => file),
			["README.md"],
		);
	});
});

test("checks links from supported documentation to legacy records", async () => {
	await withDocumentationFixture(async (root) => {
		await mkdir(path.join(root, "docs", "design"), { recursive: true });
		await writeFile(
			path.join(root, "docs", "design", "index.md"),
			"[missing](./missing.md)\n",
		);
		await writeFile(
			path.join(root, "README.md"),
			"[legacy](./docs/guide/absent.md)\n",
		);

		const { problems } = await checkDocumentationLinks({ root });
		assert.deepEqual(
			problems.map(({ file, target }) => ({ file, target })),
			[{ file: "README.md", target: "./docs/guide/absent.md" }],
		);
	});
});

test("repository documentation links resolve", {
	timeout: 120_000,
}, async () => {
	const { problems } = await checkDocumentationLinks({ root: repoRoot });
	assert.deepEqual(problems, []);
});
