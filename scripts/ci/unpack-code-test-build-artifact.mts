#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function unpackCodeTestBuildArtifact(
	archivePath: string,
	repoRoot: string,
): void {
	const archive = resolve(archivePath);
	const root = resolve(repoRoot);
	mkdirSync(root, { recursive: true });
	const result = spawnSync("tar", ["-xzf", archive, "-C", root], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(
			`tar failed to unpack code test build artifact (${result.status ?? result.error?.message})`,
		);
	}
}

function main(): void {
	const [archivePath, repoRoot] = process.argv.slice(2);
	if (!archivePath || !repoRoot) {
		console.error(
			"usage: node scripts/ci/unpack-code-test-build-artifact.mts <archive.tar.gz> <repo-root>",
		);
		process.exit(2);
	}
	unpackCodeTestBuildArtifact(archivePath, repoRoot);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
