import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const ROOT_VITEST_SHARDS = 4;
export const DRAFT_VITEST_SHARDS = 9;

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

function shardIndex(value: string, count: number): number {
	return createHash("sha256").update(value).digest().readUInt32BE(0) % count;
}

export function selectShard(files: string[], shard: TestShard): string[] {
	return files.filter((file) => shardIndex(file, shard.count) === shard.index);
}

export function draftProofDirectory(file: string): string {
	const directory =
		/^(src\/draft\/exp-proofs\/[^/]+\/[^/]+|src\/draft\/[^/]+\/[^/]+)\/tests?\//.exec(
			file,
		)?.[1];
	if (directory === undefined) {
		throw new Error(`draft test is not in a proof package: ${file}`);
	}
	return directory;
}

export function selectDraftShard(files: string[], shard: TestShard): string[] {
	if (
		shard.index < 0 ||
		shard.index >= shard.count ||
		shard.count !== DRAFT_VITEST_SHARDS
	) {
		throw new Error(`invalid draft shard ${shard.index}/${shard.count}`);
	}
	return files.filter(
		(file) =>
			shardIndex(draftProofDirectory(file), shard.count) === shard.index,
	);
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
