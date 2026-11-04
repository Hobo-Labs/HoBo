import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const ROOT_VITEST_SHARDS = 4;
export const DRAFT_VITEST_SHARDS = 4;

export const legacyUnitPatterns = [
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
];

const rootUnitPatterns = ["test/*test.ts", "test/*test.mjs"];
export const draftUnitPatterns = legacyUnitPatterns.filter((pattern) =>
	pattern.startsWith("src/draft/"),
);
const frozenLiveRepoTests = new Set([
	"src/draft/technical-proofs/s0-04-protobuf-cue-codegen/packages/schema-tools/test/codegen-pipeline.test.ts",
]);

export interface TestShard {
	index: number;
	count: number;
}

export function gitLsFiles(patterns: string[]): string[] {
	const result = spawnSync("git", ["ls-files", ...patterns], {
		encoding: "utf8",
		shell: false,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			result.stderr || result.error?.message || "git ls-files failed",
		);
	}
	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export function isNodeTestFile(file: string): boolean {
	const source = readFileSync(file, "utf8");
	return /from\s+["']node:test["']|require\(\s*["']node:test["']\s*\)|import\s+["']node:test["']/.test(
		source,
	);
}

function selectVitestFiles(patterns: string[]): string[] {
	return gitLsFiles(patterns).filter(
		(file) => !frozenLiveRepoTests.has(file) && !isNodeTestFile(file),
	);
}

export function rootUnitTestFiles(): string[] {
	return gitLsFiles(rootUnitPatterns);
}

export function draftUnitTestFiles(): string[] {
	return selectVitestFiles(draftUnitPatterns);
}

export function legacyUnitTestFiles(): string[] {
	return [...rootUnitTestFiles(), ...draftUnitTestFiles()];
}

export function readShard(args: string[]): TestShard | undefined {
	const argument = args.find((arg) => arg.startsWith("--shard="));
	if (argument === undefined) return undefined;
	const match = /^--shard=(\d+)\/(\d+)$/.exec(argument);
	if (match === null) {
		throw new Error(
			`invalid shard ${argument}; expected --shard=<index>/<count>`,
		);
	}
	const index = Number(match[1]);
	const count = Number(match[2]);
	if (count < 1 || index < 0 || index >= count) {
		throw new Error(`invalid shard ${argument}; expected 0 <= index < count`);
	}
	return { index, count };
}

export function selectShard(files: string[], shard: TestShard): string[] {
	return files.filter(
		(file) =>
			createHash("sha256").update(file).digest().readUInt32BE(0) %
				shard.count ===
			shard.index,
	);
}

const draftShardDirectories = [
	"src/draft/technical-proofs/",
	"src/draft/exp-proofs/",
	"src/draft/epic-proofs/",
	"src/draft/projects/",
];

export function selectDraftShard(files: string[], shard: TestShard): string[] {
	const directory = draftShardDirectories[shard.index];
	if (directory === undefined || shard.count !== DRAFT_VITEST_SHARDS) {
		throw new Error(`invalid draft shard ${shard.index}/${shard.count}`);
	}
	return files.filter((file) => file.startsWith(directory));
}

export const rootUnitTaskNames = [
	...Array.from(
		{ length: ROOT_VITEST_SHARDS },
		(_, index) => `//#test:unit:root:${index}`,
	),
	...Array.from(
		{ length: DRAFT_VITEST_SHARDS },
		(_, index) => `//#test:unit:draft:${index}`,
	),
];
