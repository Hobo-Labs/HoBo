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
import { join } from "node:path";
import { releaseSemverFromEnv } from "../lib/release-version.mts";
import { turboConcurrencyArg } from "../lib/turbo-concurrency.ts";
import { applyScopeToManifest, loadNpmScopeMap } from "./npm-publish-scope.mts";

const root = join(import.meta.dirname, "..", "..");

export const SDK_PACKAGES = [
	"@hobo/core",
	"@hobo/policy",
	"@hobo/bindles",
	"@hobo/contracts",
	"@hobo/contract-harness",
	"@hobo/runtime",
	"@hobo/runtime-local",
	"@hobo/storage-sqlite",
	"@hobo/wit",
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
} satisfies Record<string, string>;

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
	buildReleaseSdkPackages();
	mkdirSync(outDir, { recursive: true });
	const map = loadNpmScopeMap();
	const semver = releaseSemverFromEnv();
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
		});
		const pkgStaging = join(staging, workspaceName.replace("/", "_"));
		rmSync(pkgStaging, { recursive: true, force: true });
		cpSync(pkgDir, pkgStaging, { recursive: true });
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
