import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { CANONICAL_VERBS } from "../packages/cli/src/shell/verbs.js";

import {
	checkCliDocs,
	lintMarkdownContent,
	loadCliSpec,
} from "../scripts/check-cli-docs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("canonical CLI spec maps every verb to an implementation issue", async () => {
	const spec = await loadCliSpec(root);
	const verbs = new Map(spec.verbs.map((verb) => [verb.name, verb]));

	assert.equal(
		verbs.get("up")?.implementationIssues.includes("HOBO-130"),
		true,
	);
	// `deploy` is the attested CD observe family (status|logs|rollback), not lifecycle shipping.
	assert.equal(verbs.has("deploy"), true);
	assert.equal(verbs.has("trails"), true);
	assert.equal(verbs.has("yard"), true);
	assert.deepEqual(
		[...verbs.keys()].sort(),
		CANONICAL_VERBS.map((verb) => verb.name).sort(),
	);
	assert.equal(verbs.has("forge"), false);

	for (const verb of spec.verbs) {
		assert.match(
			verb.implementationIssues.join(" "),
			/(?:HOBO|ADR)-\d+/,
			`${verb.name} must cite at least one HOBO-* or ADR-* reference`,
		);
	}

	assert.equal(
		spec.retiredAliases.find((alias) => alias.name === "deploy"),
		undefined,
		"lifecycle deploy must not be retired while deploy is a canonical CD verb",
	);
});

test("repository docs contain no unreconciled CLI command mentions", async () => {
	const result = await checkCliDocs({ root });
	assert.deepEqual(result.problems, []);
});

test("fenced command examples reject retired lifecycle verbs", async () => {
	const spec = await loadCliSpec(root);
	const problems = lintMarkdownContent(
		"bad.md",
		["```bash", "hobo destroy --camp prod", "hobo teardown", "```"].join("\n"),
		spec,
	);

	assert.deepEqual(
		problems.map((problem) => problem.command),
		["hobo destroy", "hobo teardown"],
	);
});

test("cli package summaries reject retired and unknown pipe-delimited verbs", async () => {
	const spec = await loadCliSpec(root);
	const problems = lintMarkdownContent(
		"packages.md",
		"  cli/ @hobo/cli hobo dev|plan|inspect|login|registry|yard|forge\n",
		spec,
	);

	assert.deepEqual(
		problems.map((problem) => problem.command),
		["hobo forge"],
	);
});

test("doc checker can scan a focused docs tree", async () => {
	const tempRoot = await mkdtemp(path.join(tmpdir(), "hobo-cli-docs-"));

	try {
		await writeFile(
			path.join(tempRoot, "ok.md"),
			["```bash", "hobo up --camp prod", "hobo down --camp pr-1", "```"].join(
				"\n",
			),
		);

		const result = await checkCliDocs({
			root,
			files: [path.join(tempRoot, "ok.md")],
		});
		assert.deepEqual(result.problems, []);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
