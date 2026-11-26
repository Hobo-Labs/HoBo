#!/usr/bin/env node
/**
 * Remove top-level packages/* directories that are not HoBo packages.
 *
 * Partial checkouts and leftover deps-layer trees (for example after
 * feature-branch layout moves) can leave packages/code/ with only
 * node_modules or dist. Konsistent then reports missing scaffolding.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const CATEGORY_CONTAINERS = new Set([
	"adapters",
	"connectors",
	"iac",
	"packs",
	"providers",
	"runtimes",
]);

export function pruneStrayWorkspacePackages(root = process.cwd()): string[] {
	const packagesRoot = join(root, "packages");
	if (!existsSync(packagesRoot)) return [];
	const removed: string[] = [];
	for (const entry of readdirSync(packagesRoot)) {
		if (CATEGORY_CONTAINERS.has(entry)) continue;
		const path = join(packagesRoot, entry);
		try {
			if (!statSync(path).isDirectory()) continue;
		} catch {
			continue;
		}
		if (existsSync(join(path, "package.json"))) continue;
		rmSync(path, { recursive: true, force: true });
		removed.push(path);
	}
	return removed;
}

const entry = process.argv[1];
if (entry?.endsWith("prune-stray-workspace-packages.mts")) {
	const removed = pruneStrayWorkspacePackages();
	for (const path of removed) console.log(`removed ${path}`);
}
