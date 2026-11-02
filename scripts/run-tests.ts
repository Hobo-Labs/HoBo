import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sanitizeNodeOptions } from "./lib/env.ts";

const args = new Set(process.argv.slice(2));
const quiet = args.has("--quiet");
const categoryArg = process.argv.find((arg) => arg.startsWith("--category="));
const category = categoryArg?.slice("--category=".length) ?? "unit";
const rootOnly = process.argv.includes("--root-only");
const finalValidation = process.argv.includes("--final");
const changedScope = process.argv.includes("--changed");
const isAgent =
	process.env.CI_AGENT === "true" ||
	process.env.CODEX === "true" ||
	process.env.CLAUDECODE === "true" ||
	process.env.CURSOR_AGENT === "true";
const broadAgentCategories = new Set([
	"contract-provider",
	"contract-consumer",
	"contract",
	"unit",
	"all",
]);

const categories = {
	unit: rootOnly
		? ["test/*test.ts", "test/*test.mjs"]
		: [
				"test/*test.ts",
				"test/*test.mjs",
				"src/draft/*/*/test/*test.ts",
				"src/draft/exp-proofs/*/*/test/*test.ts",
				"src/draft/*/*/test/*test.mjs",
				"src/draft/exp-proofs/*/*/test/*test.mjs",
				"src/draft/*/*/tests/*test.ts",
				"src/draft/exp-proofs/*/*/tests/*test.ts",
				"src/draft/*/*/tests/*test.mjs",
				"src/draft/exp-proofs/*/*/tests/*test.mjs",
			],
	types: [
		"src/draft/*/*/type-tests/*.ts",
		"src/draft/exp-proofs/*/*/type-tests/*.ts",
		"src/draft/*/*/test-types/*.ts",
		"src/draft/exp-proofs/*/*/test-types/*.ts",
		"**/*.test-d.ts",
	],
	"contract-consumer": [
		"src/draft/*/*/test/*contract*.test.ts",
		"src/draft/exp-proofs/*/*/test/*contract*.test.ts",
		"src/draft/*/*/test/*contract*.test.mjs",
		"src/draft/exp-proofs/*/*/test/*contract*.test.mjs",
		"src/draft/*/*/tests/*contract*.test.ts",
		"src/draft/exp-proofs/*/*/tests/*contract*.test.ts",
		"src/draft/*/*/tests/*contract*.test.mjs",
		"src/draft/exp-proofs/*/*/tests/*contract*.test.mjs",
		"src/draft/*/*/contracts/consumer/*test.ts",
		"src/draft/exp-proofs/*/*/contracts/consumer/*test.ts",
		"packages/runtimes/*/contracts/consumer/*test.ts",
		// Every package-level contract test, wherever it lives in the tree. The
		// `.contract.test.ts` suffix is the repo's deliberate marker for "this
		// test holds code to a published contract", so it is the thing to key
		// on. Before this pattern existed the category reached only
		// `src/draft/**` plus one runtimes path, so 30-odd real contract tests
		// under `packages/**` — including pact-driven ones — were unreachable
		// from `pnpm run test:contract` and could rot silently.
		"packages/**/*.contract.test.ts",
		"test/*contract*.test.ts",
	],
	"contract-provider": [
		"src/draft/*/*/test/*provider*.test.ts",
		"src/draft/exp-proofs/*/*/test/*provider*.test.ts",
		"src/draft/*/*/test/*provider*.test.mjs",
		"src/draft/exp-proofs/*/*/test/*provider*.test.mjs",
		"src/draft/*/*/tests/*provider*.test.ts",
		"src/draft/exp-proofs/*/*/tests/*provider*.test.ts",
		"src/draft/*/*/tests/*provider*.test.mjs",
		"src/draft/exp-proofs/*/*/tests/*provider*.test.mjs",
		"src/draft/*/*/contracts/provider/*test.ts",
		// Deliberately NOT extended to `packages/**`: in this repo "provider"
		// names a *cloud* provider far more often than a pact provider, so a
		// `*provider*` glob there would sweep in dozens of unrelated suites
		// (`add-aws-provider.test.ts`, `local-provider.test.ts`, every
		// `provider-*/test/provider.test.ts`) and make the category meaningless.
		// Package-level contract tests are matched by the `.contract.test.ts`
		// marker in `contract-consumer` above instead.
		"test/*provider*.test.ts",
	],
	// Chaos suites already existed and were documented in AGENTS.md ("Chaos
	// lanes, and which one proves what") but had no lane of their own: they ran
	// only as a side effect of a package's broad test run, so there was no way
	// to ask "is the chaos surface green" without running everything. The glob
	// keys on the `chaos` marker in the filename, which is how the two suites
	// AGENTS.md distinguishes are already named.
	chaos: ["packages/**/test/*chaos*.test.ts"],
	dom: ["tests/dom/**/*test.ts", "test/dom/**/*test.ts"],
	component: ["tests/component/**/*test.ts", "test/component/**/*test.ts"],
	behavior: ["tests/behavior/**/*test.ts", "features/**/*.feature"],
	visual: ["tests/visual/**/*test.ts"],
	property: ["packages/fuzz/test/property/**/*test.ts"],
	fuzz: [
		"packages/fuzz/test/harness/**/*test.ts",
		"packages/fuzz/test/api/**/*test.ts",
	],
	"agent-mock": ["evals/**/*.mock.test.ts", "test/evals/**/*.mock.test.ts"],
	"agent-live": ["evals/**/*.live.test.ts", "test/evals/**/*.live.test.ts"],
};

type CategoryKey = keyof typeof categories;
function isCategoryKey(name: string): name is CategoryKey {
	return Object.hasOwn(categories, name);
}
const patterns = isCategoryKey(category) ? categories[category] : undefined;
if (!patterns) {
	console.error(`unknown test category: ${category}`);
	process.exit(1);
}

// Category lanes run under Vitest, which cannot load node:test-style files.
// Files that import node:test belong to package-level `node --test` lanes
// (their package.json test:contract:* scripts), so exclude them here; the
// turbo part of the root lane still executes them under their owning engine.
const nodeTestFiles = new Set<string>();
// Frozen proofs cannot change after promotion (scripts/promotions.json), so a
// frozen proof test that runs its stale code against the live repo would fail
// forever. The promoted package carries the maintained copy of each test here.
const frozenLiveRepoTests = new Set([
	"src/draft/technical-proofs/s0-04-protobuf-cue-codegen/packages/schema-tools/test/codegen-pipeline.test.ts",
]);
const testFiles = gitLsFiles(patterns).filter((file) => {
	if (file.endsWith(".feature")) return false;
	if (frozenLiveRepoTests.has(file)) return false;
	if (isNodeTestFile(file)) {
		nodeTestFiles.add(file);
		return false;
	}
	return true;
});
if (nodeTestFiles.size > 0) {
	console.log(
		`Skipping ${nodeTestFiles.size} node:test-style file(s) covered by package lanes:`,
	);
	for (const file of nodeTestFiles) console.log(`  ${file}`);
}

if (isAgent && broadAgentCategories.has(category) && !finalValidation) {
	throw new Error(
		[
			`Refusing broad test category during agent edit loop: ${category}`,
			"Use:",
			"  pnpm run test:smoke <path>",
			"  pnpm run test:file <path>",
			"  pnpm run test:name <pattern> <path>",
			"  pnpm run test:changed",
			"Pass --final only after the implementation is complete.",
		].join("\n"),
	);
}

if (isAgent && testFiles.length > 3 && !changedScope && !finalValidation) {
	throw new Error(
		`Refusing ${testFiles.length} test files during agent edit loop. Use a targeted file, --changed, or --final.`,
	);
}

if (testFiles.length === 0) {
	console.log(`No ${category} tests found; lane skipped.`);
	process.exit(0);
}

// The tracked-file list goes through a temporary Vitest config instead of the
// command line so large categories cannot exceed the Windows command-length
// limit (the reason the old runner batched files by character budget).
const configDir = mkdtempSync(join(tmpdir(), "hobo-vitest-"));
const configPath = join(configDir, "vitest.config.mjs");
const baseConfigUrl = pathToFileURL(
	resolve(process.cwd(), "vitest.config.ts"),
).href;
const maxWorkers = Math.max(
	1,
	Number.parseInt(process.env.HOBO_RELEVANT_CHECK_CONCURRENCY ?? "4", 10) || 4,
);
writeFileSync(
	configPath,
	`import baseConfig from ${JSON.stringify(baseConfigUrl)};\nexport default { ...baseConfig, test: { ...baseConfig.test, include: ${JSON.stringify(testFiles)}, maxWorkers: ${maxWorkers}, pool: "forks", watch: false } };\n`,
);

try {
	const vitestEntry = resolve(
		process.cwd(),
		"node_modules",
		"vitest",
		"vitest.mjs",
	);
	const result = spawnSync(
		process.execPath,
		[
			vitestEntry,
			"run",
			"--root",
			process.cwd(),
			"--config",
			configPath,
			...(quiet ? ["--silent", "--reporter=dot"] : []),
		],
		{
			stdio: "inherit",
			shell: false,
			env: sanitizeNodeOptions(),
		},
	);
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(configDir, { force: true, recursive: true });
}

function isNodeTestFile(file: string): boolean {
	const source = readFileSync(file, "utf8");
	return /from\s+["']node:test["']|require\(\s*["']node:test["']\s*\)|import\s+["']node:test["']/.test(
		source,
	);
}

function gitLsFiles(globPatterns: string[]): string[] {
	const result = spawnSync("git", ["ls-files", ...globPatterns], {
		encoding: "utf8",
		shell: false,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		process.stderr.write(result.stderr || result.error?.message || "");
		process.exit(result.status ?? 1);
	}
	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}
