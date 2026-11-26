import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { checkDocsCoverage } from "../scripts/check-docs-coverage.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

async function write(
	root: string,
	file: string,
	content = `# ${path.basename(file)}\n`,
) {
	await mkdir(path.dirname(path.join(root, file)), { recursive: true });
	await writeFile(path.join(root, file), content);
}

test("repository has required docs coverage", () => {
	assert.deepEqual(checkDocsCoverage(repoRoot), []);
});

test("docs coverage flags missing community docs and README sections", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-docs-coverage-"));

	try {
		await write(root, "README.md", "# HoBo\n");
		await write(root, "CONTRIBUTING.md", "# Contributing\n");

		const problems = checkDocsCoverage(root);

		assert.ok(problems.some((problem) => problem.includes("SECURITY.md")));
		assert.ok(
			problems.some((problem) =>
				problem.includes("README must include a repository map"),
			),
		);
		assert.ok(
			problems.some((problem) =>
				problem.includes("CONTRIBUTING must list required local checks"),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
