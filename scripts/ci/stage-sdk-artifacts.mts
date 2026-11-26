#!/usr/bin/env node
/** Stage npm pack tarballs for allowlisted SDK packages into an artifact directory. */
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { releaseSemverFromEnv } from "../lib/release-version.mts";
import { turboConcurrencyArg } from "../lib/turbo-concurrency.ts";
import {
	applyScopeToManifest,
	loadNpmScopeMap,
	PINNED_EXTERNAL_WORKSPACE_VERSION,
} from "./npm-publish-scope.mts";

const root = join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);

export const SDK_PACKAGES = [
	"@hobo/core",
	"@hobo/policy",
	"@hobo/bindles",
	"@hobo/contracts",
	"@hobo/contract-harness",
	"@hobo/wit",
	"@hobo/pricing",
	"@hobo/fleet",
	"@hobo/backend-routing",
	"@hobo/data-core",
	"@hobo/provider-cedar",
	"@hobo/provider-opa",
	"@hobo/broker",
	"@hobo/dispatcher",
	"@hobo/storage-sqlite",
	"@hobo/runtime",
	"@hobo/runtime-local",
	"@hobo/runtime-rivet",
	"@hobo/iac-alchemy",
	"@hobo/alchemy-rivet",
	"@hobo/cli",
] as const;

/** Turbo argv for the SDK allowlist build (honors `HOBO_TURBO_CONCURRENCY`). */
export function releaseSdkTurboBuildArgv(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const filters = SDK_PACKAGES.map((pkg) => `--filter=${pkg}`);
	return [
		"exec",
		"turbo",
		"run",
		"build",
		turboConcurrencyArg(env),
		...filters,
	];
}

/** Turbo-build every allowlisted SDK package before `npm pack` staging. */
export function buildReleaseSdkPackages(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const result = spawnSync("pnpm", releaseSdkTurboBuildArgv(env), {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error("turbo build failed for SDK allowlist before npm pack");
	}
}

export type SdkArtifactManifest = {
	version: string;
	packages: { workspace: string; public: string; file: string }[];
};

type NpmPackLine = { filename: string };

type WorkspaceManifest = { name: string };

/** Install order for SDK tarballs (MANIFEST.json pack order, not lexical). */
export function orderedSdkTarballPaths(artifactsDir: string): string[] {
	const manifestPath = join(artifactsDir, "MANIFEST.json");
	if (!existsSync(manifestPath)) {
		throw new Error(
			`missing ${manifestPath}; extract SDK artifacts before overlay install`,
		);
	}
	const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	// SAFETY: stageSdkArtifactsDir writes MANIFEST.json from SdkArtifactManifest.
	const manifest = parsed as SdkArtifactManifest;
	const paths = manifest.packages.map((entry) =>
		join(artifactsDir, entry.file),
	);
	for (const path of paths) {
		if (!existsSync(path)) {
			throw new Error(`SDK tarball missing from artifacts dir: ${path}`);
		}
	}
	return paths;
}

const SDK_PACKAGE_DIRS = {
	"@hobo/runtime-local": "packages/runtimes/runtime-local",
	"@hobo/runtime-rivet": "packages/runtimes/runtime-rivet",
	"@hobo/iac-alchemy": "packages/iac/iac-alchemy",
	"@hobo/alchemy-rivet": "packages/extension-alchemy-rivet",
	"@hobo/provider-cedar": "packages/providers/provider-cedar",
	"@hobo/provider-opa": "packages/providers/provider-opa",
} satisfies Record<string, string>;

const EXTERNAL_SDK_WORKSPACES = {
	"ts-autocode-grounding":
		"external/ts-autocode/packages/grounding/package.json",
	"ts-autocode-training": "external/ts-autocode/packages/training/package.json",
} as const;

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: pinned sibling manifests are checked before their versions enter release artifacts. */
export function readExternalSdkWorkspaceVersions(
	repoRoot: string,
): Readonly<Record<string, string>> {
	const versions: Record<string, string> = Object.create(null);
	for (const [name, path] of Object.entries(EXTERNAL_SDK_WORKSPACES)) {
		const value: unknown = JSON.parse(
			readFileSync(join(repoRoot, path), "utf8"),
		);
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!("name" in value) ||
			value.name !== name ||
			!("version" in value) ||
			typeof value.version !== "string" ||
			value.version.length > 128 ||
			!PINNED_EXTERNAL_WORKSPACE_VERSION.test(value.version) ||
			("private" in value && value.private !== false)
		)
			throw new Error(`invalid pinned SDK dependency manifest: ${name}`);
		versions[name] = value.version;
	}
	return Object.freeze(versions);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: copied sibling manifests are checked again at the staging boundary. */
export function bundleExternalSdkWorkspaces(
	repoRoot: string,
	packageDir: string,
	manifest: {
		dependencies?: Record<string, string>;
		bundleDependencies?: string[];
	},
	versions: Readonly<Record<string, string>>,
): void {
	const bundled = [...(manifest.bundleDependencies ?? [])];
	for (const [name, path] of Object.entries(EXTERNAL_SDK_WORKSPACES)) {
		const version = manifest.dependencies?.[name];
		if (version === undefined) continue;
		if (
			version !== versions[name] ||
			!PINNED_EXTERNAL_WORKSPACE_VERSION.test(version)
		)
			throw new Error(`invalid SDK bundled dependency: ${name}`);
		const source = join(repoRoot, dirname(path));
		const target = join(packageDir, "node_modules", name);
		const raw = readFileSync(join(source, "package.json"), "utf8");
		const sibling: unknown = JSON.parse(raw);
		if (
			typeof sibling !== "object" ||
			sibling === null ||
			Array.isArray(sibling) ||
			!("name" in sibling) ||
			sibling.name !== name ||
			!("version" in sibling) ||
			sibling.version !== version ||
			("private" in sibling && sibling.private !== false)
		)
			throw new Error(`invalid SDK bundled dependency: ${name}`);
		for (const field of [
			"peerDependencies",
			"optionalDependencies",
			"bundleDependencies",
			"bundledDependencies",
		] as const) {
			if (Object.hasOwn(sibling, field))
				throw new Error(`unsupported SDK bundled dependency metadata: ${name}`);
		}
		if ("dependencies" in sibling) {
			const dependencies = sibling.dependencies;
			if (
				typeof dependencies !== "object" ||
				dependencies === null ||
				Array.isArray(dependencies)
			)
				throw new Error(`invalid SDK bundled dependencies: ${name}`);
			manifest.dependencies ??= {};
			for (const [dependency, range] of Object.entries(dependencies)) {
				if (
					dependency.length === 0 ||
					dependency.length > 214 ||
					typeof range !== "string" ||
					range.length === 0 ||
					range.length > 128 ||
					/^(?:workspace|file|link):/u.test(range)
				)
					throw new Error(`invalid SDK bundled dependencies: ${name}`);
				if (
					Object.hasOwn(manifest.dependencies, dependency) &&
					manifest.dependencies[dependency] !== range
				)
					throw new Error(`conflicting SDK bundled dependency: ${dependency}`);
				Object.defineProperty(manifest.dependencies, dependency, {
					value: range,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}
		if (!existsSync(join(source, "dist", "index.js")))
			throw new Error(`SDK bundled dependency is not built: ${name}`);
		rmSync(target, { recursive: true, force: true });
		mkdirSync(target, { recursive: true });
		cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
		writeFileSync(join(target, "package.json"), raw);
		cpSync(
			join(repoRoot, "external/ts-autocode/LICENSE"),
			join(target, "LICENSE"),
		);
		if (!bundled.includes(name)) bundled.push(name);
	}
	if (bundled.length > 0) manifest.bundleDependencies = bundled;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function findPackageDir(name: string): string {
	const nested = Object.entries(SDK_PACKAGE_DIRS).find(
		([packageName]) => packageName === name,
	)?.[1];
	if (nested) return join(root, nested);
	for (const rel of readdirSync(join(root, "packages"))) {
		const pkgPath = join(root, "packages", rel, "package.json");
		try {
			const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
			// SAFETY: only `name` is read to locate the workspace directory.
			const manifest = raw as { name?: string };
			if (manifest.name === name) return join(root, "packages", rel);
		} catch {
			/* skip */
		}
	}
	throw new Error(`package dir not found for ${name}`);
}

export function stageSdkArtifactsDir(outDir: string): SdkArtifactManifest {
	// SAFETY: staging runs after dependency installation; bootstrap imports do not load this module.
	const { rewriteStagedSdkDirectory } =
		require("./rewrite-sdk-specifiers.mts") as typeof import("./rewrite-sdk-specifiers.mts");
	buildReleaseSdkPackages();
	mkdirSync(outDir, { recursive: true });
	const map = loadNpmScopeMap();
	const semver = releaseSemverFromEnv();
	const externalWorkspaceVersions = readExternalSdkWorkspaceVersions(root);
	const manifest: SdkArtifactManifest = {
		version: semver,
		packages: [],
	};
	const staging = join(outDir, ".staging");
	mkdirSync(staging, { recursive: true });
	for (const workspaceName of SDK_PACKAGES) {
		const pkgDir = findPackageDir(workspaceName);
		const rawPkg: unknown = JSON.parse(
			readFileSync(join(pkgDir, "package.json"), "utf8"),
		);
		// SAFETY: workspace package.json must declare `name` before pack staging.
		const staged = applyScopeToManifest(rawPkg as WorkspaceManifest, map, {
			version: semver,
			externalWorkspaceVersions,
		});
		const pkgStaging = join(staging, workspaceName.replace("/", "_"));
		rmSync(pkgStaging, { recursive: true, force: true });
		cpSync(pkgDir, pkgStaging, {
			recursive: true,
			filter: (source) => basename(source) !== "node_modules",
		});
		rewriteStagedSdkDirectory(join(pkgStaging, "dist"), map.packages);
		bundleExternalSdkWorkspaces(
			root,
			pkgStaging,
			staged,
			externalWorkspaceVersions,
		);
		writeFileSync(
			join(pkgStaging, "package.json"),
			`${JSON.stringify(staged, null, "\t")}\n`,
		);
		const pack = spawnSync(
			"npm",
			["pack", "--pack-destination", outDir, "--json"],
			{
				cwd: pkgStaging,
				encoding: "utf8",
			},
		);
		if (pack.status !== 0) {
			console.error(pack.stderr || pack.stdout);
			process.exit(1);
		}
		const parsedRaw: unknown = JSON.parse(pack.stdout);
		// SAFETY: `npm pack --json` emits a one-element array with `filename`.
		const parsed = parsedRaw as NpmPackLine[];
		const file = parsed[0]?.filename;
		if (!file)
			throw new Error(`npm pack produced no tarball for ${workspaceName}`);
		manifest.packages.push({
			workspace: workspaceName,
			public: staged.name,
			file,
		});
	}
	writeFileSync(
		join(outDir, "MANIFEST.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return manifest;
}

function main(): void {
	const outDir = process.argv[2];
	if (!outDir) {
		console.error("usage: node scripts/ci/stage-sdk-artifacts.mts <out-dir>");
		process.exit(2);
	}
	stageSdkArtifactsDir(outDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
