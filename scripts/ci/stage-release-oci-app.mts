#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
	orderedSdkTarballPaths,
	SDK_PACKAGES,
} from "./stage-sdk-artifacts.mts";

const defaultRoot = join(import.meta.dirname, "..", "..");

type DeployStage = {
	readonly kind: "deploy";
	readonly packageName: string;
	readonly buildFilter: string;
	readonly appPath: "app";
	readonly wrappers?: readonly {
		name: string;
		entrypoint: string;
		help?: string;
	}[];
};

type SdkStage = {
	readonly kind: "sdk";
	readonly artifactsPath: "artifacts";
};

type SiteStage = {
	readonly kind: "site";
	readonly distPath: "dist";
	readonly serverPath: "server.mjs";
};

type McpStage = {
	readonly kind: "mcp";
	readonly markerPath: ".hobo-cli-candidate";
};

export type ReleaseOciStageSpec = DeployStage | SdkStage | SiteStage | McpStage;

export const RELEASE_OCI_STAGE_SPECS = {
	"hobo-cli": {
		kind: "deploy",
		packageName: "@hobo/hobo",
		buildFilter: "@hobo/hobo...",
		appPath: "app",
		wrappers: [
			{ name: "hobo", entrypoint: "dist/bin/hobo.js" },
			{ name: "hobo-mcp", entrypoint: "dist/bin/hobo-mcp.js" },
		],
	},
	"hobo-codegen": {
		kind: "deploy",
		packageName: "@hobo/schema-tools",
		buildFilter: "@hobo/schema-tools...",
		appPath: "app",
		wrappers: [
			{
				name: "hobo-codegen",
				entrypoint: "dist/cli.js",
				help: "usage: hobo-codegen [--check] [--json] [--packages-root <path>] [--filter <package>]",
			},
		],
	},
	"hobo-ci-serve": {
		kind: "deploy",
		packageName: "@hobo/ci-gh-actions",
		buildFilter: "@hobo/ci-gh-actions...",
		appPath: "app",
	},
	"hobo-sdk": { kind: "sdk", artifactsPath: "artifacts" },
	"hobo-site": { kind: "site", distPath: "dist", serverPath: "server.mjs" },
	"hobo-mcp": { kind: "mcp", markerPath: ".hobo-cli-candidate" },
} satisfies Record<string, ReleaseOciStageSpec>;

function run(root: string, command: string, args: readonly string[]): void {
	const result = spawnSync(command, args, {
		cwd: root,
		env: {
			...process.env,
			CI: "1",
			TURBO_TELEMETRY_DISABLED: "1",
		},
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`,
		);
	}
}

export function tryShallowFetchOriginMain(root: string): boolean {
	const remote = spawnSync("git", ["remote", "get-url", "origin"], {
		cwd: root,
		encoding: "utf8",
	});
	if (remote.status !== 0 || !remote.stdout.trim()) {
		return false;
	}
	const result = spawnSync(
		"git",
		[
			"-c",
			"http.version=HTTP/1.1",
			"fetch",
			"--depth=1",
			"--filter=blob:none",
			"origin",
			"main:refs/remotes/origin/main",
		],
		{ cwd: root, stdio: "ignore" },
	);
	return result.status === 0;
}

function releaseTagOrDispatchCheckout(): boolean {
	const ref = process.env.GITHUB_REF ?? "";
	if (ref.startsWith("refs/tags/")) return true;
	return process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
}

export function resolveReleaseTurboBase(
	root: string,
	configuredBase = process.env.HOBO_RELEASE_TURBO_BASE,
): string | undefined {
	const base = configuredBase?.trim();
	if (!base) return undefined;
	const refExists = (ref: string): boolean =>
		spawnSync(
			"git",
			[
				"rev-parse",
				"--verify",
				"--quiet",
				"--end-of-options",
				`${ref}^{commit}`,
			],
			{ cwd: root, stdio: "ignore" },
		).status === 0;
	if (refExists(base)) return base;
	if (base === "origin/main") {
		tryShallowFetchOriginMain(root);
		if (refExists("origin/main")) return "origin/main";
		if (refExists("HEAD^1")) return "HEAD^1";
		if (releaseTagOrDispatchCheckout()) return undefined;
	}
	throw new Error(
		`HOBO_RELEASE_TURBO_BASE=${base} does not resolve to a commit; fetch that ref or use HEAD^1 on a sparse pull-request checkout`,
	);
}

export function releaseOciTurboBuildArgs(
	root: string,
	imageFilters: readonly string[],
): string[] {
	const base = resolveReleaseTurboBase(root);
	return [
		"exec",
		"turbo",
		"run",
		"build",
		...(base ? [`--filter=...[${base}...HEAD]`] : []),
		...imageFilters.map((filter) => `--filter=${filter}`),
	];
}

function turboBuild(root: string, filters: readonly string[]): void {
	run(root, "pnpm", releaseOciTurboBuildArgs(root, filters));
}

/** `node_modules` path for a package name (supports scoped packages). */
export function nodeModulesPathForPackageName(
	appDir: string,
	packageName: string,
): string {
	if (packageName.startsWith("@")) {
		const parts = packageName.split("/");
		const scope = parts[0];
		const unscoped = parts[1];
		if (parts.length !== 2 || !scope || !unscoped) {
			throw new Error(`invalid scoped package name: ${packageName}`);
		}
		return join(appDir, "node_modules", scope, unscoped);
	}
	return join(appDir, "node_modules", packageName);
}

type TarballManifest = { readonly name: string };

type MovePackageDirDeps = {
	readonly renameSync: typeof renameSync;
	readonly cpSync: typeof cpSync;
	readonly rmSync: typeof rmSync;
};

/** Move extracted `package/` into `node_modules`; copy+rm when rename crosses devices. */
export function moveExtractedPackageDir(
	pkgDir: string,
	target: string,
	deps: MovePackageDirDeps = { renameSync, cpSync, rmSync },
): void {
	deps.rmSync(target, { recursive: true, force: true });
	mkdirSync(dirname(target), { recursive: true });
	try {
		deps.renameSync(pkgDir, target);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EXDEV"
		) {
			throw error;
		}
		deps.cpSync(pkgDir, target, { recursive: true });
		deps.rmSync(pkgDir, { recursive: true, force: true });
	}
}

/** Temp dir for tarball extract; must sit on the same device as `appDir` (pnpm store staging). */
export function sdkOverlayExtractRoot(appDir: string): string {
	return mkdtempSync(join(appDir, ".sdk-overlay-"));
}

/**
 * Lay staged `@hobo-labs/*` tarballs into a pnpm-deploy app without `npm install`.
 * npm's arborist crashes (Node 24) when reconciling tarballs against pnpm's
 * `file:` workspace layout; direct extract preserves deploy `node_modules`.
 */
export function installSdkTarballsIntoApp(
	appDir: string,
	artifactsDir: string,
): void {
	const tarballs = orderedSdkTarballPaths(artifactsDir);
	const extractRoot = sdkOverlayExtractRoot(appDir);
	try {
		for (const tarball of tarballs) {
			const slot = join(extractRoot, basename(tarball, ".tgz"));
			mkdirSync(slot, { recursive: true });
			run(appDir, "tar", ["-xzf", resolve(tarball), "-C", slot]);
			const pkgDir = join(slot, "package");
			const raw: unknown = JSON.parse(
				readFileSync(join(pkgDir, "package.json"), "utf8"),
			);
			// SAFETY: npm pack always includes `name` in package/package.json.
			const manifest = raw as TarballManifest;
			if (!manifest.name) {
				throw new Error(`SDK tarball missing name: ${tarball}`);
			}
			const target = nodeModulesPathForPackageName(appDir, manifest.name);
			moveExtractedPackageDir(pkgDir, target);
		}
	} finally {
		rmSync(extractRoot, { recursive: true, force: true });
	}
}

export type ReleaseOciStagingLocation =
	| { readonly stagingRoot: string; readonly hardlink: false }
	| {
			readonly stagingRoot: string;
			readonly hardlink: true;
			readonly storeDir: string;
	  };

type ReleaseOciStagingOptions = {
	readonly root?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly stat?: (path: string) => { readonly dev: number };
	readonly mkdir?: (path: string) => void;
	readonly processId?: number;
};

function releaseOciRunId(
	env: Readonly<Record<string, string | undefined>>,
	processId: number,
): string {
	const githubRun =
		env.GITHUB_RUN_ID && env.GITHUB_JOB
			? `${env.GITHUB_RUN_ID}-${env.GITHUB_JOB}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`
			: undefined;
	return (
		env.HOBO_RELEASE_STAGING_ID ||
		githubRun ||
		`pid-${processId}`
	).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function releaseOciStagingLocation(
	imageId: string,
	options: ReleaseOciStagingOptions = {},
): ReleaseOciStagingLocation {
	const root = resolve(options.root ?? defaultRoot);
	const fallback = {
		stagingRoot: join(root, "deploy/release-images/.staging", imageId),
		hardlink: false,
	} as const;
	const env = options.env ?? process.env;
	if (!env.npm_config_store_dir) return fallback;
	const storeDir = resolve(env.npm_config_store_dir);
	const stat = options.stat ?? statSync;
	const mkdir =
		options.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }));
	try {
		const storeDevice = stat(storeDir).dev;
		const storeStaging = join(storeDir, ".hobo-release-staging");
		mkdir(storeStaging);
		if (stat(storeStaging).dev !== storeDevice) return fallback;
		return {
			stagingRoot: join(
				storeStaging,
				imageId,
				releaseOciRunId(env, options.processId ?? process.pid),
			),
			hardlink: true,
			storeDir,
		};
	} catch {
		return fallback;
	}
}

/** Resolve from the workspace: pnpm otherwise chooses a different store for
 * a deployment target on another filesystem, breaking deployment from the workspace store. */
export function releasePnpmStore(
	root: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const which = spawnSync("sh", ["-c", "command -v pnpm || true"], {
		encoding: "utf8",
		env,
	});
	const pnpm = which.stdout?.split("\n")[0]?.trim() || "pnpm";
	const args = ["store", "path", "--silent"] as const;
	const result = spawnSync(pnpm, [...args], {
		cwd: root,
		encoding: "utf8",
		env,
		timeout: 30_000,
		maxBuffer: 4_096,
	});
	const path = result.stdout?.trim() ?? "";
	if (result.status === 0 && isAbsolute(path) && !/[\r\n\0]/u.test(path)) {
		return path;
	}
	const configured = env.npm_config_store_dir?.trim();
	if (configured && isAbsolute(configured) && !/[\r\n\0]/u.test(configured)) {
		return resolve(configured);
	}
	const detail = (result.stderr || result.stdout || "").trim();
	throw new Error(
		`cannot resolve the workspace pnpm store (${pnpm} ${args.join(" ")} exited ${result.status ?? "null"}${detail ? `: ${detail}` : ""})`,
	);
}

/** Deploy is `--prefer-offline`, never `--offline`: deploy re-resolves direct
 * dependencies and a frozen install caches no registry metadata, so a cold
 * ephemeral runner must be allowed to fetch missing metadata/tarballs.
 * Versions and integrity
 * stay pinned by the shared workspace lockfile deploy resolves against. */
export function releaseOciDeployArgs(
	packageName: string,
	appDir: string,
	storeDir: string,
	hardlink = false,
): readonly string[] {
	if (!isAbsolute(storeDir) || /[\r\n\0]/u.test(storeDir))
		throw new Error("invalid workspace pnpm store");
	return [
		"--filter",
		packageName,
		"deploy",
		"--prod",
		"--prefer-offline",
		"--config.inject-workspace-packages=true",
		"--cpu=current",
		"--os=current",
		"--libc=current",
		"--store-dir",
		storeDir,
		...(hardlink ? ["--config.package-import-method=hardlink"] : []),
		appDir,
	];
}

function deployPackage(
	root: string,
	stagingRoot: string,
	spec: DeployStage,
	skipBuild: boolean,
	hardlink: boolean,
	sdkArtifactsDir?: string,
): void {
	if (!skipBuild) turboBuild(root, [spec.buildFilter]);
	const appDir = join(stagingRoot, spec.appPath);
	run(
		root,
		"pnpm",
		releaseOciDeployArgs(
			spec.packageName,
			appDir,
			releasePnpmStore(root),
			hardlink,
		),
	);
	if (sdkArtifactsDir) {
		installSdkTarballsIntoApp(appDir, sdkArtifactsDir);
	}
	if (spec.wrappers?.length) {
		const binDir = join(appDir, "bin");
		mkdirSync(binDir, { recursive: true });
		for (const wrapper of spec.wrappers) {
			const help = wrapper.help
				? `if [ "$#" -eq 1 ] && [ "$1" = "--help" ]; then\n  echo "${wrapper.help}"\n  exit 0\nfi\n`
				: "";
			const executable = join(binDir, wrapper.name);
			writeFileSync(
				executable,
				`#!/bin/sh\n${help}exec node "$(dirname "$0")/../${wrapper.entrypoint}" "$@"\n`,
				{ flag: "wx" },
			);
			chmodSync(executable, 0o755);
		}
	}
}

function stageSdk(
	root: string,
	stagingRoot: string,
	spec: SdkStage,
	skipBuild: boolean,
): void {
	if (!skipBuild) turboBuild(root, SDK_PACKAGES);
	run(root, "node", [
		"--no-warnings",
		join(root, "scripts/ci/stage-sdk-artifacts.mts"),
		join(stagingRoot, spec.artifactsPath),
	]);
}

function stageSite(
	root: string,
	stagingRoot: string,
	spec: SiteStage,
	skipBuild: boolean,
): void {
	if (!skipBuild) turboBuild(root, ["hobo-site..."]);
	const siteDist = join(root, "site/dist");
	if (!existsSync(siteDist)) {
		throw new Error(
			`site build output missing: ${siteDist}; run the full hobo-site Turbo build before staging`,
		);
	}
	cpSync(siteDist, join(stagingRoot, spec.distPath), {
		recursive: true,
	});
	cpSync(
		join(root, "deploy/release-images/hobo-site/server.mjs"),
		join(stagingRoot, spec.serverPath),
	);
}

/**
 * Build noise left out of a deploy image's context. Directory and extension
 * rules only: a rule on a file-name infix (`*.test.*`, `*.spec.*`) also drops
 * data a package ships to be read at run time, such as the `app.test.ts.tpl`
 * starter templates in `@hobo/patterns`.
 */
const DEPLOY_CONTEXT_NOISE = [
	"app/**/*.map",
	"app/**/test/**",
	"app/**/__tests__/**",
	"app/**/*.md",
	"app/**/DESIGN.md",
] as const;

export function releaseOciDockerignore(spec: ReleaseOciStageSpec): string {
	switch (spec.kind) {
		case "deploy":
			return `${[
				"*",
				"!.dockerignore",
				"!app/",
				"!app/**",
				"!app/bin/",
				"!app/bin/**",
				...DEPLOY_CONTEXT_NOISE,
			].join("\n")}\n`;
		case "sdk":
			return "*\n!.dockerignore\n!artifacts/\n!artifacts/**\n";
		case "site":
			return "*\n!.dockerignore\n!dist/\n!dist/**\n!server.mjs\n";
		case "mcp":
			return `*\n!.dockerignore\n!${spec.markerPath}\n`;
	}
}

const REGEXP_SPECIAL = new Set("\\^$.|+()[]{}");

function dockerignoreRuleMatcher(rule: string): RegExp {
	let source = "";
	for (let index = 0; index < rule.length; index++) {
		const char = rule.charAt(index);
		if (char === "*" && rule.charAt(index + 1) === "*") {
			index++;
			if (rule.charAt(index + 1) === "/") {
				index++;
				source += "(?:.*/)?";
			} else source += ".*";
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += REGEXP_SPECIAL.has(char) ? `\\${char}` : char;
	}
	return new RegExp(`^${source}$`, "u");
}

/**
 * Whether Docker leaves `path` out of a build context that has this
 * `.dockerignore`: the last rule matching the path or one of its parent
 * directories decides, and a `!` rule puts the path back.
 */
export function releaseOciDockerignoreExcludes(
	dockerignore: string,
	path: string,
): boolean {
	const segments = path.split("/").filter(Boolean);
	const candidates = segments.map((_, index) =>
		segments.slice(0, index + 1).join("/"),
	);
	let excluded = false;
	for (const line of dockerignore.split("\n")) {
		const rule = line.trim();
		if (rule === "" || rule.startsWith("#")) continue;
		const keep = rule.startsWith("!");
		const matcher = dockerignoreRuleMatcher(
			(keep ? rule.slice(1) : rule).replace(/\/+$/u, ""),
		);
		if (candidates.some((candidate) => matcher.test(candidate)))
			excluded = !keep;
	}
	return excluded;
}

export function releaseOciAffectedImageIds(
	env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] | undefined {
	const value = env.HOBO_RELEASE_OCI_AFFECTED_IMAGE_IDS;
	if (value === undefined) return undefined;
	return value.split(/\s+/).filter(Boolean);
}

export function stageReleaseOciApp(
	imageId: string,
	stagingRoot: string,
	options: {
		root?: string;
		skipBuild?: boolean;
		hardlink?: boolean;
		sdkArtifactsDir?: string;
		env?: Readonly<Record<string, string | undefined>>;
	} = {},
): void {
	const spec = Object.entries(RELEASE_OCI_STAGE_SPECS).find(
		([id]) => id === imageId,
	)?.[1];
	if (!spec) throw new Error(`unknown release image id: ${imageId}`);
	const root = options.root ?? defaultRoot;
	const affectedImageIds = releaseOciAffectedImageIds(options.env);
	if (affectedImageIds && !affectedImageIds.includes(imageId)) {
		throw new Error(
			`release image ${imageId} is not in HOBO_RELEASE_OCI_AFFECTED_IMAGE_IDS; refusing to stage an unaffected image`,
		);
	}
	const output = resolve(stagingRoot);
	if (output === parse(output).root || output === root) {
		throw new Error(`refusing unsafe staging root: ${output}`);
	}
	rmSync(output, { recursive: true, force: true });
	mkdirSync(output, { recursive: true });

	switch (spec.kind) {
		case "deploy":
			deployPackage(
				root,
				output,
				spec,
				options.skipBuild ?? false,
				options.hardlink ?? false,
				options.sdkArtifactsDir ??
					(process.env.HOBO_SDK_ARTIFACTS_DIR?.trim() || undefined),
			);
			break;
		case "sdk":
			stageSdk(root, output, spec, options.skipBuild ?? false);
			break;
		case "site":
			stageSite(root, output, spec, options.skipBuild ?? false);
			break;
		case "mcp":
			writeFileSync(join(output, spec.markerPath), "hobo-cli:candidate\n");
			break;
	}
	writeFileSync(join(output, ".dockerignore"), releaseOciDockerignore(spec));
}

function main(): void {
	const [imageId, stagingRoot] = process.argv.slice(2);
	if (!imageId || !stagingRoot) {
		console.error(
			"usage: node scripts/ci/stage-release-oci-app.mts <image-id> <staging-root>",
		);
		process.exit(2);
	}
	stageReleaseOciApp(imageId, stagingRoot);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
