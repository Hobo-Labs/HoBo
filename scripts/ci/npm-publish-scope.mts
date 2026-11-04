#!/usr/bin/env node
/**
 * Apply release/npm-scope-map.json to a staged package manifest (publish boundary only).
 * Does not rewrite workspace source manifests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const mapPath = join(root, "release", "npm-scope-map.json");

type ScopeMap = {
	publicScope: string;
	packages: Record<string, string>;
};

export function loadNpmScopeMap(): ScopeMap {
	const raw: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
	// SAFETY: `release/npm-scope-map.json` is repo-owned release metadata, validated in contract tests.
	return raw as ScopeMap;
}

export function mapPackageName(
	workspaceName: string,
	map: ScopeMap = loadNpmScopeMap(),
): string {
	const mapped = map.packages[workspaceName];
	if (!mapped) {
		throw new Error(
			`npm-scope-map: no public name for ${workspaceName} (add to release/npm-scope-map.json or keep private)`,
		);
	}
	return mapped;
}

type PackageJson = {
	name: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

function remapDeps(
	deps: Record<string, string> | undefined,
	map: ScopeMap,
): Record<string, string> | undefined {
	if (!deps) return deps;
	const out: Record<string, string> = {};
	for (const [name, range] of Object.entries(deps)) {
		if (name.startsWith("@hobo/") && map.packages[name]) {
			out[map.packages[name]!] = range;
		} else {
			out[name] = range;
		}
	}
	return out;
}

/** Returns a publish-ready manifest object (caller writes to staging dir). */
export function applyScopeToManifest(
	manifest: PackageJson,
	map: ScopeMap = loadNpmScopeMap(),
): PackageJson {
	const out: PackageJson = {
		...manifest,
		name: mapPackageName(manifest.name, map),
	};
	const deps = remapDeps(manifest.dependencies, map);
	const devDeps = remapDeps(manifest.devDependencies, map);
	const peerDeps = remapDeps(manifest.peerDependencies, map);
	const optDeps = remapDeps(manifest.optionalDependencies, map);
	if (deps) out.dependencies = deps;
	else delete out.dependencies;
	if (devDeps) out.devDependencies = devDeps;
	else delete out.devDependencies;
	if (peerDeps) out.peerDependencies = peerDeps;
	else delete out.peerDependencies;
	if (optDeps) out.optionalDependencies = optDeps;
	else delete out.optionalDependencies;
	return out;
}

function main(): void {
	const inPath = process.argv[2];
	const outPath = process.argv[3];
	if (!inPath || !outPath) {
		console.error(
			"usage: node scripts/ci/npm-publish-scope.mts <package.json> <out/package.json>",
		);
		process.exit(2);
	}
	const manifest = JSON.parse(readFileSync(inPath, "utf8"));
	// SAFETY: CLI passes a workspace package.json path; parse boundary is the publish staging step.
	const staged = applyScopeToManifest(manifest as PackageJson);
	writeFileSync(outPath, `${JSON.stringify(staged, null, "\t")}\n`, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
