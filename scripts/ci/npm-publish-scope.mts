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
	/**
	 * The source repository every published manifest names. npmjs verifies a
	 * provenance bundle against it: the statement's workflow repository must
	 * match `repository.url` in the tarball's package.json.
	 */
	repository?: string;
};

export function assertNpmScopeMapAllowlist(map: ScopeMap): void {
	if (!map.publicScope.startsWith("@hobo-labs")) {
		throw new Error("npm-scope-map: publicScope must be @hobo-labs");
	}
	if (
		map.repository !== undefined &&
		!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
			map.repository,
		)
	) {
		throw new Error(
			"npm-scope-map: repository must be https://github.com/<owner>/<repo>",
		);
	}
	for (const [workspace, published] of Object.entries(map.packages)) {
		if (!workspace.startsWith("@hobo/")) {
			throw new Error(`npm-scope-map: invalid workspace key ${workspace}`);
		}
		if (!published.startsWith("@hobo-labs/")) {
			throw new Error(`npm-scope-map: invalid public name for ${workspace}`);
		}
	}
}

export function loadNpmScopeMap(): ScopeMap {
	const parsed: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
	// SAFETY: `release/npm-scope-map.json` is repo-owned release metadata; contract tests pin every row.
	const map = parsed as ScopeMap;
	assertNpmScopeMapAllowlist(map);
	return map;
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
	version?: string;
	repository?: string | { type: string; url: string };
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

const WORKSPACE_RANGE = /^workspace:/;

/** Replace workspace ranges with the release semver for published @hobo-labs deps. */
function pinReleaseDependencyRanges(
	deps: Record<string, string> | undefined,
	map: ScopeMap,
	version: string,
): Record<string, string> | undefined {
	if (!deps) return deps;
	const published = new Set(Object.values(map.packages));
	const out: Record<string, string> = {};
	for (const [name, range] of Object.entries(deps)) {
		if (WORKSPACE_RANGE.test(range)) {
			if (published.has(name)) {
				out[name] = version;
			}
			continue;
		}
		out[name] = range;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Returns a publish-ready manifest object (caller writes to staging dir). */
export function applyScopeToManifest(
	manifest: PackageJson,
	map: ScopeMap = loadNpmScopeMap(),
	options?: { version?: string },
): PackageJson {
	const out: PackageJson = {
		...manifest,
		name: mapPackageName(manifest.name, map),
	};
	if (options?.version) {
		out.version = options.version;
	}
	if (map.repository) {
		out.repository = { type: "git", url: `git+${map.repository}.git` };
	}
	let deps = remapDeps(manifest.dependencies, map);
	let devDeps = remapDeps(manifest.devDependencies, map);
	let peerDeps = remapDeps(manifest.peerDependencies, map);
	let optDeps = remapDeps(manifest.optionalDependencies, map);
	if (options?.version) {
		deps = pinReleaseDependencyRanges(deps, map, options.version);
		devDeps = pinReleaseDependencyRanges(devDeps, map, options.version);
		peerDeps = pinReleaseDependencyRanges(peerDeps, map, options.version);
		optDeps = pinReleaseDependencyRanges(optDeps, map, options.version);
	}
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
