import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sanitizeNodeOptions } from "./lib/env.ts";
import { nodeTestArguments } from "./lib/node-test-arguments.ts";
import {
	draftUnitPatterns,
	gitLsFiles,
	isNodeTestFile,
	legacyUnitPatterns,
	readShard,
	selectDraftShard,
	selectShard,
} from "./lib/unit-test-selection.ts";

const args = new Set(process.argv.slice(2));
const quiet = args.has("--quiet");
const categoryArg = process.argv.find((arg) => arg.startsWith("--category="));
const category = categoryArg?.slice("--category=".length) ?? "unit";
const rootOnly = process.argv.includes("--root-only");
const finalValidation = process.argv.includes("--final");
const changedScope = process.argv.includes("--changed");
const runTimeoutMs =
	Number.parseInt(process.env.HOBO_TEST_RUN_TIMEOUT_MS ?? "", 10) || 600_000;
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
	unit: rootOnly ? ["test/*test.ts", "test/*test.mjs"] : legacyUnitPatterns,
	draft: draftUnitPatterns,
	scripts: ["scripts/test/*.test.ts"],
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
		"test/*provider*.test.ts",
	],
	chaos: [
		"packages/**/test/*chaos*.test.ts",
		"examples/cd-*/test/*chaos*.test.ts",
	],
	load: [
		"examples/cd-*/test/*-load.test.ts",
		"packages/cd/test/**/*-load.test.ts",
		"packages/resolver-components/test/**/*-load.test.ts",
	],
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

const nodeTestFiles = new Set<string>();
const frozenLiveRepoTests = new Set([
	"src/draft/technical-proofs/s0-04-protobuf-cue-codegen/packages/schema-tools/test/codegen-pipeline.test.ts",
]);
const selectedFiles = gitLsFiles(patterns).filter((file) => {
	if (file.endsWith(".feature")) return false;
	if (frozenLiveRepoTests.has(file)) return false;
	if (isNodeTestFile(file)) {
		nodeTestFiles.add(file);
		return false;
	}
	return true;
});
const shard = readShard(process.argv.slice(2));
const testFiles =
	shard === undefined
		? selectedFiles
		: category === "draft"
			? selectDraftShard(selectedFiles, shard)
			: selectShard(selectedFiles, shard);
const rootNodeTestFiles = [...nodeTestFiles].filter(
	(file) => file.startsWith("test/") || file.startsWith("scripts/test/"),
);
const shardedRootNodeTestFiles =
	shard === undefined
		? rootNodeTestFiles
		: selectShard(rootNodeTestFiles, shard);
const deferredNodeTestFiles = [...nodeTestFiles].filter(
	(file) => !rootNodeTestFiles.includes(file),
);
if (deferredNodeTestFiles.length > 0) {
	console.log(
		`Skipping ${deferredNodeTestFiles.length} node:test-style file(s) covered by node:test lanes:`,
	);
	for (const file of deferredNodeTestFiles) console.log(`  ${file}`);
}
if (shardedRootNodeTestFiles.length > 0)
	console.log(
		`Running ${shardedRootNodeTestFiles.length} node:test-style file(s) under node --test after Vitest.`,
	);

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

if (testFiles.length === 0 && shardedRootNodeTestFiles.length === 0) {
	console.log(`No ${category} tests found; lane skipped.`);
	process.exit(0);
}

const configDir = mkdtempSync(join(tmpdir(), "hobo-vitest-"));
const configPath = join(configDir, "vitest.config.mjs");
const baseConfigUrl = pathToFileURL(
	resolve(process.cwd(), "vitest.config.ts"),
).href;
const configuredMaxWorkers = Math.max(
	1,
	Number.parseInt(
		process.env.HOBO_TEST_MAX_WORKERS ??
			process.env.HOBO_RELEVANT_CHECK_CONCURRENCY ??
			"4",
		10,
	) || 4,
);
const parsedMemoryMaxWorkers = Number.parseInt(
	process.env.HOBO_TEST_MAX_WORKERS ?? "",
	10,
);
const memoryMaxWorkers =
	Number.isInteger(parsedMemoryMaxWorkers) && parsedMemoryMaxWorkers > 0
		? parsedMemoryMaxWorkers
		: configuredMaxWorkers;
const maxWorkers = Math.min(configuredMaxWorkers, memoryMaxWorkers);
const progressReporter = resolve(
	process.cwd(),
	"scripts",
	"lib",
	"vitest-progress-reporter.ts",
);
const baseReporters = quiet
	? '["dot"]'
	: '(baseConfig.test.reporters ?? ["default"])';
writeFileSync(
	configPath,
	`import baseConfig from ${JSON.stringify(baseConfigUrl)};\nexport default { ...baseConfig, test: { ...baseConfig.test, include: ${JSON.stringify(testFiles)}, maxWorkers: ${maxWorkers}, pool: "forks", watch: false, reporters: [...${baseReporters}, ${JSON.stringify(progressReporter)}, "hanging-process"] } };\n`,
);

try {
	let exitCode = 0;
	if (testFiles.length > 0) {
		const vitestEntry = resolve(
			process.cwd(),
			"node_modules",
			"vitest",
			"vitest.mjs",
		);
		const wallStart = Date.now();
		const monotonicStart = performance.now();
		const result = spawnSync(
			process.execPath,
			[
				vitestEntry,
				"run",
				"--root",
				process.cwd(),
				"--config",
				configPath,
				...(quiet ? ["--silent"] : []),
			],
			{
				stdio: "inherit",
				shell: false,
				env: {
					...sanitizeNodeOptions(),
					HOBO_TEST_MAX_WORKERS: String(maxWorkers),
				},
				timeout: runTimeoutMs,
				killSignal: "SIGKILL",
			},
		);
		if (
			result.error &&
			"code" in result.error &&
			result.error.code === "ETIMEDOUT"
		) {
			console.error(
				`run-tests: vitest exceeded ${runTimeoutMs / 1000}s (HOBO_TEST_RUN_TIMEOUT_MS) and was killed`,
			);
		} else if (result.error) {
			console.error(
				`run-tests: vitest failed to start: ${result.error.message}`,
			);
		}
		if (result.signal) {
			console.error(
				`run-tests: vitest was killed by ${result.signal} (no exit status)`,
			);
		}
		const pausedMs =
			Date.now() - wallStart - (performance.now() - monotonicStart);
		if (pausedMs > 30_000) {
			console.error(
				`run-tests: the wall clock ran ${Math.round(pausedMs / 1000)}s ahead of the monotonic clock; the host was suspended or paused during this run`,
			);
		}
		exitCode = result.status ?? 1;
	}
	if (shardedRootNodeTestFiles.length > 0) {
		const nodeResult = spawnSync(
			process.execPath,
			nodeTestArguments(shardedRootNodeTestFiles, maxWorkers),
			{
				stdio: "inherit",
				shell: false,
				env: sanitizeNodeOptions(),
				timeout: runTimeoutMs,
				killSignal: "SIGKILL",
			},
		);
		if (nodeResult.error)
			console.error(
				`run-tests: node --test failed: ${nodeResult.error.message}`,
			);
		if (exitCode === 0) exitCode = nodeResult.status ?? 1;
	}
	process.exitCode = exitCode;
} finally {
	rmSync(configDir, { force: true, recursive: true });
}
