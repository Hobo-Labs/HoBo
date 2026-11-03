#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function workspacePackageRoots(root: string): string[] {
	const globs: string[][] = [];
	let inPackages = false;
	for (const line of readFileSync(
		join(root, "pnpm-workspace.yaml"),
		"utf8",
	).split("\n")) {
		if (line.startsWith("packages:")) {
			inPackages = true;
			continue;
		}
		if (!inPackages) continue;
		const match = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/u.exec(line);
		if (match?.[1] && !match[1].startsWith("!")) {
			globs.push(match[1].split("/"));
		} else if (/^\S/u.test(line)) {
			break;
		}
	}

	const packageRoots = new Set<string>();
	for (const glob of globs) {
		let directories = [root];
		for (const segment of glob) {
			if (segment !== "*") {
				directories = directories.map((directory) => join(directory, segment));
				continue;
			}
			directories = directories.flatMap((directory) => {
				try {
					return readdirSync(directory, { withFileTypes: true })
						.filter(
							(entry) => entry.isDirectory() && entry.name !== "node_modules",
						)
						.map((entry) => join(directory, entry.name));
				} catch {
					return [];
				}
			});
		}
		for (const directory of directories) packageRoots.add(directory);
	}
	return [...packageRoots];
}

export function packageDistTrees(root: string): string[] {
	const distTrees = new Set<string>();
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const path = join(directory, entry.name);
			if (!entry.isDirectory()) continue;
			if (entry.name === "dist") {
				distTrees.add(relative(root, path));
			} else {
				walk(path);
			}
		}
	};
	for (const packageRoot of workspacePackageRoots(root)) {
		if (existsSync(packageRoot)) walk(packageRoot);
	}
	return [...distTrees].sort();
}

export function packCodeTestBuildArtifact(
	repoRoot: string,
	archivePath: string,
): void {
	const root = resolve(repoRoot);
	const archive = resolve(archivePath);
	const distTrees = packageDistTrees(root);
	if (distTrees.length === 0) {
		throw new Error("no package dist trees found in pnpm workspace members");
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
