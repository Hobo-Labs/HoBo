#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	isArray,
	isObject,
	isString,
	parseUnknownJson,
} from "../lib/pins-json.ts";
import { releaseSemverFromEnv } from "../lib/release-version.mts";
import { turboConcurrencyArg } from "../lib/turbo-concurrency.ts";
import { prepareCliSdkManifest } from "./bundle-cli-sdk.mts";
import {
	bundleSqliteSdk,
	prepareSqliteSdkManifest,
} from "./bundle-sqlite-sdk.mts";
import { applyScopeToManifest, loadNpmScopeMap } from "./npm-publish-scope.mts";
import { SDK_PACKAGES } from "./sdk-package-list.mts";
import {
	prepareRuntimeGroundingManifest,
	vendorRuntimeGrounding,
} from "./vendor-runtime-grounding.mts";

const root = join(import.meta.dirname, "..", "..");

export { SDK_PACKAGES };

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

type WorkspaceManifest = {
	name: string;
	dependencies?: Record<string, string>;
	scripts?: Record<string, string>;
};

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
		} catch {}
	}
	throw new Error(`package dir not found for ${name}`);
}

export function prepareSdkPackageManifest(
	manifest: WorkspaceManifest,
	map: ReturnType<typeof loadNpmScopeMap>,
	version: string,
) {
	const prepared =
		manifest.name === "@hobo/runtime"
			? prepareRuntimeGroundingManifest(
					manifest,
					JSON.parse(
						readFileSync(
							join(
								root,
								"external/ts-autocode/packages/grounding/package.json",
							),
							"utf8",
						),
					),
				)
			: manifest.name === "@hobo/cli"
				? prepareCliSdkManifest(manifest, root)
				: prepareSqliteSdkManifest(manifest, root);
	return applyScopeToManifest({ ...prepared, name: manifest.name }, map, {
		version,
	});
}

export function runCliSdkBundleSync(root: string, staging: string): void {
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			join(root, "scripts/ci/run-cli-sdk-bundle.mts"),
			root,
			staging,
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.error || result.status !== 0)
		throw new Error(
			`CLI SDK bundle failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`,
		);
}

export function verifyStagedSdkArtifacts(outDir: string): void {
	outDir = resolve(outDir);
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			join(root, "scripts/ci/verify-cli-sdk-artifacts.mts"),
			outDir,
			root,
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.error || result.status !== 0) {
		rmSync(join(outDir, "MANIFEST.json"), { force: true });
		throw new Error(
			`SDK artifact verification failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`,
		);
	}
}

type StagedPackage = {
	workspaceName: string;
	pkgDir: string;
	staged: ReturnType<typeof prepareSdkPackageManifest>;
};

function stageOnePackage(
	packDir: string,
	staging: string,
	pkg: StagedPackage,
): SdkArtifactManifest["packages"][number] {
	const { workspaceName, pkgDir, staged } = pkg;
	const pkgStaging = join(staging, workspaceName.replace("/", "_"));
	rmSync(pkgStaging, { recursive: true, force: true });
	cpSync(pkgDir, pkgStaging, { recursive: true });
	if (workspaceName === "@hobo/cli") {
		runCliSdkBundleSync(root, pkgStaging);
	}
	if (workspaceName === "@hobo/storage-sqlite") {
		bundleSqliteSdk(pkgStaging, pkgDir, root);
	}
	if (workspaceName === "@hobo/runtime") {
		vendorRuntimeGrounding({
			runtimeDir: pkgStaging,
			groundingDir: join(root, "external/ts-autocode/packages/grounding"),
			licenseFile: join(root, "external/ts-autocode/LICENSE"),
		});
	}
	writeFileSync(
		join(pkgStaging, "package.json"),
		`${JSON.stringify(staged, null, "\t")}\n`,
	);
	const pack = spawnSync(
		"npm",
		["pack", "--pack-destination", packDir, "--json"],
		{
			cwd: pkgStaging,
			encoding: "utf8",
		},
	);
	if (pack.status !== 0) {
		throw new Error(
			`npm pack failed for ${workspaceName}: ${pack.stderr || pack.stdout || pack.error?.message}`,
		);
	}
	const parsed = parseUnknownJson(JSON.parse(pack.stdout));
	const entry = isArray(parsed) ? parsed[0] : undefined;
	if (!isObject(entry) || !isString(entry.filename) || !entry.filename)
		throw new Error(`npm pack produced no tarball for ${workspaceName}`);
	const file = entry.filename;
	return {
		workspace: workspaceName,
		public: staged.name,
		file,
	};
}

export function sdkPackageWorkerLimit(
	manifests: readonly { scripts?: Record<string, string> | undefined }[],
): number {
	const lifecycle = [
		"prepack",
		"prepare",
		"postpack",
		"preprepare",
		"postprepare",
	];
	for (const { scripts } of manifests) {
		if (scripts && lifecycle.some((key) => Object.hasOwn(scripts, key)))
			return 1;
	}
	return 4;
}

export async function runBoundedSdkTasks<T>(
	count: number,
	limit: number,
	task: (index: number) => Promise<T>,
): Promise<T[]> {
	if (!Number.isInteger(limit) || limit < 1)
		throw new Error("invalid SDK worker limit");
	let next = 0;
	let failure: unknown;
	const results: T[] = [];
	const worker = async (): Promise<void> => {
		while (failure === undefined) {
			const index = next++;
			if (index >= count) return;
			try {
				results[index] = await task(index);
			} catch (error) {
				failure = error ?? new Error("SDK worker failed");
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
	if (failure !== undefined) throw failure;
	return results;
}

async function runPackWorkers(
	outDir: string,
	packages: StagedPackage[],
	limit: number,
): Promise<void> {
	const staging = join(outDir, ".staging");
	const workDir = mkdtempSync(join(staging, ".pack-workers-"));
	try {
		const results = await runBoundedSdkTasks(
			packages.length,
			limit,
			async (index) => {
				const packDir = join(workDir, String(index));
				mkdirSync(packDir);
				const resultPath = join(packDir, "result.json");
				const status = await new Promise<number>((done) => {
					const child = spawn(
						process.execPath,
						[
							"--experimental-strip-types",
							"--no-warnings",
							import.meta.filename,
							"--pack-one",
							outDir,
							JSON.stringify(packages[index]),
							resultPath,
							packDir,
						],
						{ cwd: root, stdio: "inherit" },
					);
					child.on("error", () => done(1));
					child.on("close", (code) => done(code ?? 1));
				});
				if (status !== 0)
					throw new Error(
						`SDK package staging failed for ${packages[index]?.workspaceName}`,
					);
				const result: SdkArtifactManifest["packages"][number] = JSON.parse(
					readFileSync(resultPath, "utf8"),
				);
				if (
					!result.file?.endsWith(".tgz") ||
					basename(result.file) !== result.file
				)
					throw new Error("invalid SDK tarball filename");
				return result;
			},
		);
		if (new Set(results.map((result) => result.file)).size !== results.length)
			throw new Error("SDK packages produced duplicate tarball names");
		for (const [index, result] of results.entries())
			renameSync(
				join(workDir, String(index), result.file),
				join(outDir, result.file),
			);
		writeFileSync(join(staging, "results.json"), JSON.stringify(results));
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

export function stageSdkArtifactsDir(outDir: string): SdkArtifactManifest {
	outDir = resolve(outDir);
	rmSync(join(outDir, "MANIFEST.json"), { force: true });
	const scopeMap = loadNpmScopeMap();
	const map = {
		...scopeMap,
		packages: Object.fromEntries(
			SDK_PACKAGES.map((name) => {
				const published = scopeMap.packages[name];
				if (!published)
					throw new Error(`npm-scope-map: no public name for ${name}`);
				return [name, published];
			}),
		),
	};
	const semver = releaseSemverFromEnv();
	const packages = SDK_PACKAGES.map((workspaceName) => {
		const pkgDir = findPackageDir(workspaceName);
		const rawPkg: WorkspaceManifest = JSON.parse(
			readFileSync(join(pkgDir, "package.json"), "utf8"),
		);
		if (rawPkg.name !== workspaceName) {
			throw new Error(`SDK package mismatch for ${workspaceName}`);
		}
		const staged = prepareSdkPackageManifest(rawPkg, map, semver);
		return { workspaceName, pkgDir, staged, scripts: rawPkg.scripts };
	});
	buildReleaseSdkPackages();
	mkdirSync(outDir, { recursive: true });
	const manifest: SdkArtifactManifest = {
		version: semver,
		packages: [],
	};
	const staging = join(outDir, ".staging");
	mkdirSync(staging, { recursive: true });
	const resultsPath = join(staging, "results.json");
	rmSync(resultsPath, { force: true });
	const workers = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			import.meta.filename,
			"--pack-all",
			outDir,
			JSON.stringify(packages),
			String(
				sdkPackageWorkerLimit(
					packages.map((pkg) => ({ scripts: pkg.scripts })),
				),
			),
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (workers.status !== 0) throw new Error("SDK package staging failed");
	try {
		manifest.packages = JSON.parse(readFileSync(resultsPath, "utf8"));
	} finally {
		rmSync(resultsPath, { force: true });
	}
	writeFileSync(
		join(outDir, "MANIFEST.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	verifyStagedSdkArtifacts(outDir);
	return manifest;
}

function main(): void {
	const outDir = process.argv[2];
	if (outDir === "--pack-one") {
		const [dir, serialized, resultPath, packDir] = process.argv.slice(3);
		if (!dir || !serialized || !resultPath || !packDir)
			throw new Error("missing SDK package worker arguments");
		const pkg: StagedPackage = JSON.parse(serialized);
		const result = stageOnePackage(packDir, join(dir, ".staging"), pkg);
		writeFileSync(resultPath, JSON.stringify(result));
		return;
	}
	if (outDir === "--pack-all") {
		const [dir, serialized, limit] = process.argv.slice(3);
		if (!dir || !serialized)
			throw new Error("missing SDK worker group arguments");
		runPackWorkers(dir, JSON.parse(serialized), Number(limit ?? 4)).catch(
			(error) => {
				console.error(error);
				process.exitCode = 1;
			},
		);
		return;
	}
	if (!outDir) {
		console.error("usage: node scripts/ci/stage-sdk-artifacts.mts <out-dir>");
		process.exit(2);
	}
	stageSdkArtifactsDir(outDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
