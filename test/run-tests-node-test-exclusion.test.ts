import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { expect } from "vitest";

// scripts/run-tests.ts runs every --category lane under Vitest, which cannot
// load node:test-style files. The script excludes files that import node:test;
// this test pins the invariant that every such excluded file remains covered
// by a package-level `node --test` contract lane (the turbo part of the root
// test:contract:* commands).

const categoryGlobs = [
	"src/draft/*/*/contracts/consumer/*test.ts",
	"src/draft/exp-proofs/*/*/contracts/consumer/*test.ts",
	"src/draft/*/*/contracts/provider/*test.ts",
	"src/draft/exp-proofs/*/*/contracts/provider/*test.ts",
	"packages/runtimes/*/contracts/consumer/*test.ts",
	"packages/runtimes/*/contracts/provider/*test.ts",
];

function gitLsFiles(globs: string[]): string[] {
	const result = spawnSync("git", ["ls-files", ...globs], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.split(/\r?\n/).filter(Boolean);
}

function importsNodeTest(file: string): boolean {
	return /from\s+["']node:test["']|require\(\s*["']node:test["']\s*\)|import\s+["']node:test["']/.test(
		readFileSync(file, "utf8"),
	);
}

function nearestPackageDir(file: string): string {
	let dir = path.dirname(file);
	while (dir !== "." && !existsSync(path.join(dir, "package.json"))) {
		dir = path.dirname(dir);
	}
	assert.notEqual(dir, ".", `no package.json found above ${file}`);
	return dir;
}

test("node:test-style contract files stay covered by package node --test lanes", () => {
	const excluded = gitLsFiles(categoryGlobs).filter(importsNodeTest);
	expect(excluded.length).toBeGreaterThan(0);

	for (const file of excluded) {
		const lane = file.includes("/consumer/")
			? "test:contract:consumer"
			: "test:contract:provider";
		const packageDir = nearestPackageDir(file);
		// SAFETY: assertion to `JSON.parse( readFileSync(path.join(packageDir, "package.json"), "utf8"), ) as { scripts?: Record<string, string> }` is required at this boundary.
		const manifest = JSON.parse(
			readFileSync(path.join(packageDir, "package.json"), "utf8"),
		) as { scripts?: { [name: string]: string } };
		const script = manifest.scripts?.[lane] ?? "";
		assert.ok(
			script.includes("--test"),
			`${file} imports node:test but ${packageDir} ${lane} is not a node --test lane: ${script}`,
		);
	}
});

test("run-tests.ts excludes node:test-style files from vitest lanes", () => {
	const source = readFileSync("scripts/run-tests.ts", "utf8");
	expect(source).toContain("isNodeTestFile");
});

test("run-tests.ts preserves the canonical Vitest execution settings", () => {
	const source = readFileSync("scripts/run-tests.ts", "utf8");
	expect(source).toContain("pathToFileURL");
	expect(source).toContain('"vitest.config.ts"');
	expect(source).toContain("...baseConfig.test");
	expect(source).toContain('pool: "forks"');
	expect(source).toContain("HOBO_TEST_MAX_WORKERS");
	expect(source).toContain("HOBO_RELEVANT_CHECK_CONCURRENCY");
	expect(source).toContain("Math.min(configuredMaxWorkers, memoryMaxWorkers)");
	expect(source).toContain("HOBO_TEST_MAX_WORKERS: String(maxWorkers)");
	expect(source).toContain("maxWorkers:");
	expect(source).toContain("rootNodeTestFiles");
	expect(source).toContain('"--import", "tsx", "--test"');
});
