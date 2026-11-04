#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import { SDK_PACKAGES } from "./stage-sdk-artifacts.mts";

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
	"hobo-code": {
		kind: "deploy",
		packageName: "@hobo/code",
		buildFilter: "@hobo/code...",
		appPath: "app",
		wrappers: [{ name: "hobo-code", entrypoint: "dist/bin/hobo-code.js" }],
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
		buildFilter: "@hobo/ci-gh-actions",
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

function turboBuild(root: string, filters: readonly string[]): void {
	const base = process.env.HOBO_RELEASE_TURBO_BASE?.trim();
	const turboFilters =
		base && base.length > 0
			? filters.map((filter) => {
					const packageRef = filter.endsWith("...")
						? filter.slice(0, -3)
						: filter;
					return `--filter=${packageRef}[${base}...HEAD]`;
				})
			: filters.map((filter) => `--filter=${filter}`);
	run(root, "pnpm", ["exec", "turbo", "run", "build", ...turboFilters]);
}

function installSdkTarballsIntoApp(appDir: string, artifactsDir: string): void {
	const tarballs = readdirSync(artifactsDir)
		.filter((name) => name.endsWith(".tgz"))
		.map((name) => join(artifactsDir, name));
	if (tarballs.length === 0) {
		throw new Error(`no SDK tarballs under ${artifactsDir}`);
	}
	run(appDir, "npm", ["install", "--ignore-scripts", "--no-save", ...tarballs]);
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

export function releaseOciDeployArgs(
	packageName: string,
	appDir: string,
	hardlink = false,
): readonly string[] {
	return [
		"--filter",
		packageName,
		"deploy",
		"--prod",
		"--offline",
		"--config.inject-workspace-packages=true",
		"--cpu=current",
		"--os=current",
		"--libc=current",
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
	const buildFilter =
		sdkArtifactsDir && spec.packageName === "@hobo/hobo"
			? "@hobo/hobo"
			: spec.buildFilter;
	if (!skipBuild) turboBuild(root, [buildFilter]);
	const appDir = join(stagingRoot, spec.appPath);
	run(root, "pnpm", releaseOciDeployArgs(spec.packageName, appDir, hardlink));
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
	cpSync(join(root, "site/dist"), join(stagingRoot, spec.distPath), {
		recursive: true,
	});
	cpSync(
		join(root, "deploy/release-images/hobo-site/server.mjs"),
		join(stagingRoot, spec.serverPath),
	);
}

export function releaseOciDockerignore(spec: ReleaseOciStageSpec): string {
	switch (spec.kind) {
		case "deploy":
			return "*\n!.dockerignore\n!app/\n!app/**\n!app/bin/\n!app/bin/**\n";
		case "sdk":
			return "*\n!.dockerignore\n!artifacts/\n!artifacts/**\n";
		case "site":
			return "*\n!.dockerignore\n!dist/\n!dist/**\n!server.mjs\n";
		case "mcp":
			return `*\n!.dockerignore\n!${spec.markerPath}\n`;
	}
}

export function stageReleaseOciApp(
	imageId: string,
	stagingRoot: string,
	options: {
		root?: string;
		skipBuild?: boolean;
		hardlink?: boolean;
		sdkArtifactsDir?: string;
	} = {},
): void {
	const spec = Object.entries(RELEASE_OCI_STAGE_SPECS).find(
		([id]) => id === imageId,
	)?.[1];
	if (!spec) throw new Error(`unknown release image id: ${imageId}`);
	const root = options.root ?? defaultRoot;
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
