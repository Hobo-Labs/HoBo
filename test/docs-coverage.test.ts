import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("issue-worker guardrails are required inside the embedded prompt", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-worker-coverage-"));
	const worker = "docs/automations/hobo-issue-worker.md";
	const source = await readFile(path.join(repoRoot, worker), "utf8");

	try {
		await write(root, worker, source);
		assert.deepEqual(
			checkDocsCoverage(root).filter((problem) => problem.startsWith(worker)),
			[],
		);

		const guardrails = [
			"Touch only the issue/PR this run owns.",
			"Never edit, reassign, or claim another worker's in-progress issue.",
			"Process only one issue per run in an isolated worktree, and preserve unrelated work and scope boundaries.",
			"Never push to main directly.",
			"Never force-push a shared branch.",
			"AUTO_MERGE is false: never merge your own PR.",
			"Follow applicable policy decisions, approval conditions, spend caps, and quotas; stop if a required decision or limit is unavailable or denies the action.",
			"Fail closed when required checks fail; mark a PR ready only after verification gates pass.",
			"Do not create plans, ADRs, design documents, explanatory code comments, or deferred-work markers.",
			"No secrets in code, commits, PRs, Linear comments, or docs.",
		];
		for (const guardrail of guardrails) {
			await write(
				root,
				worker,
				`${source.replace(`- ${guardrail}`, "")}\n${guardrail}\n`,
			);
			assert.ok(
				checkDocsCoverage(root).some((problem) => problem.startsWith(worker)),
				guardrail,
			);
		}

		await write(root, worker, source.replace("\nGUARDRAILS\n", "\nCONTROLS\n"));
		assert.ok(
			checkDocsCoverage(root).some((problem) =>
				problem.includes("block is missing"),
			),
		);
		await write(
			root,
			worker,
			source.replace("## Automation prompt", "## Former prompt") +
				"\n## Automation prompt\n\n```text\nGUARDRAILS\n```\n",
		);
		assert.ok(
			checkDocsCoverage(root).some((problem) => problem.startsWith(worker)),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("docs coverage flags missing community docs and README sections", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-docs-coverage-"));

	try {
		await write(root, "README.md", "# HoBo\n");
		await write(root, "CONTRIBUTING.md", "# Contributing\n");

		const problems = checkDocsCoverage(root);

		assert.ok(problems.some((problem) => problem.includes("SECURITY.md")));
		assert.ok(!problems.some((problem) => problem.includes("docs/design/")));
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
