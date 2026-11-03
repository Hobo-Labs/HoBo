#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function packageDistTrees(root: string): string[] {
	const distTrees: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const path = join(directory, entry.name);
			if (!entry.isDirectory()) continue;
			if (entry.name === "dist") {
				distTrees.push(relative(root, path));
			} else {
				walk(path);
			}
		}
	};
	walk(join(root, "packages"));
	return distTrees.sort();
}

export function packCodeTestBuildArtifact(
	repoRoot: string,
	archivePath: string,
): void {
	const root = resolve(repoRoot);
	const archive = resolve(archivePath);
	const distTrees = packageDistTrees(root);
	if (distTrees.length === 0) {
		throw new Error("no package dist trees found under packages/**/dist");
	}
	mkdirSync(dirname(archive), { recursive: true });
	const result = spawnSync("tar", ["-czf", archive, "-C", root, ...distTrees], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(
			`tar failed to pack code test build artifact (${result.status ?? result.error?.message})`,
		);
	}
	console.log(`packed ${distTrees.length} package dist trees into ${archive}`);
}

function main(): void {
	const [repoRoot, archivePath] = process.argv.slice(2);
	if (!repoRoot || !archivePath) {
		console.error(
			"usage: node scripts/ci/pack-code-test-build-artifact.mts <repo-root> <archive.tar.gz>",
		);
		process.exit(2);
	}
	packCodeTestBuildArtifact(repoRoot, archivePath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
