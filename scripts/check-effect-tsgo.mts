#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export type PackageManifestSummary = Readonly<{
	name?: string;
	dependencies?: Readonly<Record<string, string>>;
	devDependencies?: Readonly<Record<string, string>>;
	peerDependencies?: Readonly<Record<string, string>>;
}>;

export type EffectTsgoTarget = Readonly<{
	packageDir: string;
	tsconfigPath: string;
}>;

const EFFECT_DEPENDENCY_PREFIXES = ["effect", "@effect/", "@alchemy.run/"];

function toPosix(pathValue: string): string {
	return pathValue.replaceAll("\\", "/");
}

function isEffectDependency(name: string): boolean {
	if (name === "effect" || name === "alchemy") return true;
	return EFFECT_DEPENDENCY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function packageUsesEffect(packageJsonPath: string): boolean {
	if (!existsSync(packageJsonPath)) return false;
	const parsed: PackageManifestSummary = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	);
	const depNames = [
		...Object.keys(parsed.dependencies ?? {}),
		...Object.keys(parsed.devDependencies ?? {}),
		...Object.keys(parsed.peerDependencies ?? {}),
	];
	return depNames.some(isEffectDependency);
}

export function workspaceDirForPath(filePath: string): string | undefined {
	const normalized = toPosix(filePath);
	const nested = normalized.match(
		/^(packages|examples)\/(runtimes|providers|iac|build)\/([^/]+)(?:\/|$)/u,
	);
	if (nested?.[1] && nested[2] && nested[3]) {
		return `${nested[1]}/${nested[2]}/${nested[3]}`;
	}
	const direct = normalized.match(/^(packages|examples)\/([^/]+)(?:\/|$)/u);
	if (direct?.[1] && direct[2]) {
		return `${direct[1]}/${direct[2]}`;
	}
	return undefined;
}

export function selectEffectTsgoTargets(
	rootDir: string,
	changedFiles: readonly string[],
): readonly EffectTsgoTarget[] {
	const packageDirs = new Set<string>();
	for (const file of changedFiles) {
		const pkgDir = workspaceDirForPath(file);
		if (pkgDir !== undefined) {
			packageDirs.add(pkgDir);
		}
	}
	const targets: EffectTsgoTarget[] = [];
	for (const packageDir of [...packageDirs].sort()) {
		const absPkgDir = join(rootDir, packageDir);
		const pkgJson = join(absPkgDir, "package.json");
		const tsconfig = join(absPkgDir, "tsconfig.json");
		if (!existsSync(tsconfig)) continue;
		if (!packageUsesEffect(pkgJson)) continue;
		targets.push({
			packageDir,
			tsconfigPath: toPosix(join(packageDir, "tsconfig.json")),
		});
	}
	return targets;
}

function listChangedFiles(
	rootDir: string,
	mode: { readonly staged: boolean; readonly base: string | undefined },
): readonly string[] {
	const gitArgs = mode.staged
		? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
		: mode.base !== undefined
			? ["diff", "--name-only", "--diff-filter=ACMR", `${mode.base}...HEAD`]
			: ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"];
	const result = spawnSync("git", gitArgs, {
		cwd: rootDir,
		encoding: "utf8",
		shell: false,
	});
	if (result.status !== 0) {
		return [];
	}
	return result.stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function effectTsgoBin(rootDir: string): string {
	const binName =
		process.platform === "win32" ? "effect-tsgo.cmd" : "effect-tsgo";
	return join(rootDir, "node_modules", ".bin", binName);
}

function runEffectTsgoForTarget(
	rootDir: string,
	bin: string,
	target: EffectTsgoTarget,
): number {
	const result = spawnSync(
		bin,
		["tsc", "-p", target.tsconfigPath, "--noEmit"],
		{
			cwd: rootDir,
			stdio: "inherit",
			shell: false,
		},
	);
	return result.status ?? 1;
}

function parseExplicitPackages(argv: readonly string[]): readonly string[] {
	const explicit: string[] = [];
	for (const arg of argv) {
		if (!arg.startsWith("--packages=")) continue;
		const raw = arg.slice("--packages=".length);
		for (const item of raw.split(",")) {
			const trimmed = item.trim();
			if (trimmed.length > 0) explicit.push(trimmed);
		}
	}
	return explicit;
}

export function resolveExplicitPackagePaths(
	rootDir: string,
	rawNames: readonly string[],
): readonly string[] {
	return rawNames.map((entry) => {
		const normalized = toPosix(entry).replace(/^\.\//u, "");
		if (workspaceDirForPath(normalized) !== undefined) return normalized;
		for (const candidate of [
			`packages/${normalized}`,
			`packages/iac/${normalized}`,
			`packages/providers/${normalized}`,
			`packages/runtimes/${normalized}`,
			`packages/build/${normalized}`,
		]) {
			if (existsSync(join(rootDir, candidate, "package.json"))) {
				return candidate;
			}
		}
		return normalized;
	});
}

function main(argv: readonly string[]): number {
	const rootArg = argv
		.find((arg) => arg.startsWith("--root="))
		?.slice("--root=".length);
	const rootDir =
		rootArg === undefined || rootArg === ""
			? join(dirname(fileURLToPath(import.meta.url)), "..")
			: resolve(rootArg);
	const staged = argv.includes("--staged");
	const base = argv
		.find((arg) => arg.startsWith("--base="))
		?.slice("--base=".length);
	const explicitPackages = parseExplicitPackages(argv);
	const files =
		explicitPackages.length > 0
			? resolveExplicitPackagePaths(rootDir, explicitPackages)
			: listChangedFiles(rootDir, { staged, base });
	const targets = selectEffectTsgoTargets(rootDir, files);

	if (targets.length === 0) {
		if (explicitPackages.length > 0) {
			console.error(
				`effect-tsgo: explicit --packages matched no Effect/Alchemy package(s): ${explicitPackages.join(", ")}`,
			);
			return 1;
		}
		console.log("effect-tsgo: ok (no impacted Effect/Alchemy packages)");
		return 0;
	}

	const bin = effectTsgoBin(rootDir);
	if (!existsSync(bin)) {
		console.error(
			`effect-tsgo: binary not found at ${bin}; run pnpm install first`,
		);
		return 1;
	}

	let failed = 0;
	for (const target of targets) {
		console.log(`effect-tsgo: checking ${target.tsconfigPath}`);
		const status = runEffectTsgoForTarget(rootDir, bin, target);
		if (status !== 0) {
			failed += 1;
		}
	}
	if (failed > 0) {
		console.error(`effect-tsgo: ${failed}/${targets.length} package(s) failed`);
		return 1;
	}
	console.log(`effect-tsgo: ok (${targets.length} package(s) clean)`);
	return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	process.exit(main(process.argv.slice(2)));
}
