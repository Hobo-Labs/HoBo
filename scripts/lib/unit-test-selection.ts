import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

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
		.filter((file) => file.length > 0 && existsSync(file));
}

export function isNodeTestSource(source: string, file = "test.ts"): boolean {
	if (
		!/\b(?:from\s+|require\s*\(\s*|import\s*(?:\(\s*)?)["'`](?:node:test|\.\/support\/test-runner\.ts)["'`]/u.test(
			source,
		)
	)
		return false;
	const kind = /\.[jt]sx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		kind,
	);
	const namesNodeTest = (node: ts.Node | undefined) =>
		Boolean(
			node &&
				ts.isStringLiteralLike(node) &&
				(node.text === "node:test" || node.text === "./support/test-runner.ts"),
		);
	const visit = (node: ts.Node): boolean => {
		if (ts.isImportDeclaration(node) && namesNodeTest(node.moduleSpecifier)) {
			const clause = node.importClause;
			if (!clause) return true;
			if (clause.isTypeOnly) return false;
			const named = clause.namedBindings;
			return Boolean(
				clause.name ||
					!named ||
					!ts.isNamedImports(named) ||
					named.elements.length === 0 ||
					named.elements.some((element) => !element.isTypeOnly),
			);
		}
		if (ts.isExportDeclaration(node) && namesNodeTest(node.moduleSpecifier)) {
			if (node.isTypeOnly) return false;
			const named = node.exportClause;
			return (
				!named ||
				!ts.isNamedExports(named) ||
				named.elements.length === 0 ||
				named.elements.some((element) => !element.isTypeOnly)
			);
		}
		if (ts.isExternalModuleReference(node) && namesNodeTest(node.expression))
			return (
				!ts.isImportEqualsDeclaration(node.parent) || !node.parent.isTypeOnly
			);
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require")) &&
			namesNodeTest(node.arguments[0])
		)
			return true;
		return ts.forEachChild(node, visit) === true;
	};
	return visit(parsed);
}

export function isNodeTestFile(file: string): boolean {
	return isNodeTestSource(readFileSync(file, "utf8"), file);
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
