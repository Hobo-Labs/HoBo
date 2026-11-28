#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const mapPath = join(root, "release", "npm-scope-map.json");

type ScopeMap = {
	publicScope: string;
	packages: Record<string, string>;
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
	version?: string,
	development = false,
): Record<string, string> | undefined {
	if (!deps) return deps;
	const out: Record<string, string> = {};
	for (const [name, range] of Object.entries(deps)) {
		const mapped = map.packages[name];
		if (version && !development && name.startsWith("@hobo/") && !mapped) {
			throw new Error(
				`npm-scope-map: runtime workspace dependency ${name} has no public package mapping`,
			);
		}
		if (range.startsWith("workspace:")) {
			if (!version) {
				out[mapped ?? name] = range;
			} else if (mapped) {
				out[name] = `npm:${mapped}@${version}`;
			} else if (!development) {
				throw new Error(
					`npm-scope-map: runtime workspace dependency ${name} has no public package mapping`,
				);
			}
		} else if (mapped && version) {
			out[name] = `npm:${mapped}@${range}`;
		} else {
			out[mapped ?? name] = range;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

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
	const deps = remapDeps(manifest.dependencies, map, options?.version);
	const devDeps = remapDeps(
		manifest.devDependencies,
		map,
		options?.version,
		true,
	);
	const peerDeps = remapDeps(manifest.peerDependencies, map, options?.version);
	const optDeps = remapDeps(
		manifest.optionalDependencies,
		map,
		options?.version,
	);
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
