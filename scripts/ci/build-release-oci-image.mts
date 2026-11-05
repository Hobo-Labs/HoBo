#!/usr/bin/env node
/**
 * Build one release OCI app image from artifacts staged on the host runner.
 * PR/CI: build + load locally. Release: push to GHCR with semver tag (digest recorded separately).
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ciRunnerImageVersion } from "../lib/ci-runner-contract.mts";
import {
	releaseSemverFromEnv,
	tryParseReleaseRef,
} from "../lib/release-version.mts";
import {
	ghcrRepository,
	loadReleaseOciManifest,
	type ReleaseOciImage,
} from "../lib/release-oci-contract.mts";
import { extractSdkArtifactsFromImage } from "./extract-sdk-artifacts.mts";
import {
	type ReleaseOciStagingLocation,
	releaseOciStagingLocation,
	stageReleaseOciApp,
} from "./stage-release-oci-app.mts";

const root = join(import.meta.dirname, "..", "..");

function inRepoStagingDir(imageId: string): string {
	return join(root, "deploy/release-images/.staging", imageId);
}

function storeStagingRecordPath(imageId: string): string {
	return join(root, "deploy/release-images/.staging", `${imageId}.store-path`);
}

function recordStoreStaging(
	imageId: string,
	location: ReleaseOciStagingLocation,
): void {
	const recordPath = storeStagingRecordPath(imageId);
	rmSync(recordPath, { force: true });
	if (!location.hardlink) return;
	mkdirSync(dirname(recordPath), { recursive: true });
	writeFileSync(recordPath, `${location.storeDir}\n${location.stagingRoot}\n`);
}

function recordedStoreStagingDir(imageId: string): string | undefined {
	const recordPath = storeStagingRecordPath(imageId);
	if (!existsSync(recordPath)) return undefined;
	const [storeDir, stagingRoot] = readFileSync(recordPath, "utf8").split("\n");
	if (
		!storeDir ||
		!stagingRoot ||
		dirname(resolve(stagingRoot)) !==
			join(resolve(storeDir), ".hobo-release-staging", imageId)
	) {
		throw new Error(`invalid store staging record: ${recordPath}`);
	}
	return stagingRoot;
}

function run(
	cmd: string,
	args: string[],
	env: Record<string, string> = {},
): void {
	const result = spawnSync(cmd, args, {
		cwd: root,
		env: { ...process.env, CI: "1", ...env },
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
	}
}

export function ensureReleaseBuildHost(): void {
	if (
		!existsSync(
			join(root, "external/ts-autocode/packages/grounding/package.json"),
		)
	) {
		run("pnpm", ["run", "pins:fetch", "ts-autocode"]);
	}
	run("pnpm", [
		"install",
		"--frozen-lockfile",
		"--ignore-scripts",
		"--config.confirmModulesPurge=false",
	]);
}

function resolveToolchainImage(
	manifest: ReturnType<typeof loadReleaseOciManifest>,
): string {
	return (
		process.env[manifest.toolchainImageEnv] ??
		process.env.HOBO_CI_WORKER_IMAGE ??
		manifest.defaultToolchainTag
	);
}

function buildArgs(
	image: ReleaseOciImage,
	toolchain: string,
	version: string,
	revision: string,
	stagingDir: string,
): string[] {
	const repo = ghcrRepository(loadReleaseOciManifest(root), image);
	const labels = [
		`org.opencontainers.image.source=https://github.com/Hobo-Labs/HoBo`,
		`org.opencontainers.image.version=${version}`,
		`org.opencontainers.image.revision=${revision}`,
		`org.opencontainers.image.licenses=MIT`,
		`org.opencontainers.image.title=${image.title}`,
		`org.opencontainers.image.description=${image.description}`,
		`io.hobo.release.image=${image.id}`,
		`io.hobo.release.repository=${repo}`,
	];
	const args = [
		"build",
		"-f",
		join(root, image.dockerfile),
		"--build-arg",
		`HOBO_TOOLCHAIN_IMAGE=${toolchain}`,
		"--build-arg",
		`HOBO_RELEASE_VERSION=${version}`,
		"--build-arg",
		`HOBO_RELEASE_REVISION=${revision}`,
	];
	for (const label of labels) {
		args.push("--label", label);
	}
	if (image.id === "hobo-mcp") {
		args.push("--build-arg", "HOBO_CLI_CANDIDATE=hobo-cli:candidate");
	}
	args.push("-t", `${image.name}:candidate`, stagingDir);
	return args;
}

function dockerImageExists(ref: string): boolean {
	return (
		spawnSync("docker", ["image", "inspect", ref], {
			cwd: root,
			stdio: "ignore",
		}).status === 0
	);
}

function ensureCliCandidate(): void {
	const result = spawnSync(
		"docker",
		["image", "inspect", "hobo-cli:candidate"],
		{ cwd: root, stdio: "ignore" },
	);
	if (result.status !== 0) {
		throw new Error(
			"hobo-mcp requires hobo-cli:candidate; build hobo-cli first",
		);
	}
}

export function cleanupReleaseOciBuild(
	imageId: string,
	localTag: string,
	options: { keepCandidate?: boolean } = {},
): void {
	const storeStaging = recordedStoreStagingDir(imageId);
	rmSync(inRepoStagingDir(imageId), { recursive: true, force: true });
	if (storeStaging) rmSync(storeStaging, { recursive: true, force: true });
	rmSync(storeStagingRecordPath(imageId), { force: true });
	if (!options.keepCandidate) {
		const image = spawnSync("docker", ["image", "inspect", localTag], {
			cwd: root,
			stdio: "ignore",
		});
		if (image.status === 0) {
			spawnSync("docker", ["rmi", "-f", localTag], {
				cwd: root,
				stdio: "inherit",
			});
		}
	}
	spawnSync("docker", ["builder", "prune", "-f"], {
		cwd: root,
		stdio: "inherit",
	});
}

function cleanupReleaseOciBuildChain(
	imageId: string,
	options: { keepCandidate?: boolean } = {},
): void {
	cleanupReleaseOciBuild(imageId, `${imageId}:candidate`, options);
	if (imageId === "hobo-mcp") {
		cleanupReleaseOciBuild("hobo-cli", "hobo-cli:candidate", options);
	}
}

export type BuiltReleaseImage = { localTag: string; ghcrRepo: string };

function resolveReleaseImageVersion(optionsVersion?: string): string {
	if (optionsVersion) return optionsVersion;
	if (
		process.env.HOBO_RELEASE_SEMVER?.trim() ||
		process.env.HOBO_RELEASE_VERSION?.trim()
	) {
		return releaseSemverFromEnv();
	}
	const parsed = tryParseReleaseRef(process.env.GITHUB_REF_NAME?.trim() ?? "");
	if (parsed) return parsed.semver;
	return process.env.GITHUB_REF_NAME ?? ciRunnerImageVersion(root);
}

export function buildReleaseImage(options: {
	imageId: string;
	version?: string;
	revision?: string;
	skipBuild?: boolean;
	keepCandidate?: boolean;
}): BuiltReleaseImage {
	const manifest = loadReleaseOciManifest(root);
	const image = manifest.images.find((i) => i.id === options.imageId);
	if (!image) {
		throw new Error(`unknown release image id: ${options.imageId}`);
	}
	const version = resolveReleaseImageVersion(options.version);
	const revision =
		options.revision ??
		process.env.HOBO_RELEASE_REVISION ??
		process.env.GITHUB_SHA ??
		"local";
	const toolchain = resolveToolchainImage(manifest);
	ensureReleaseBuildHost();
	const staging = releaseOciStagingLocation(image.id, { root });
	recordStoreStaging(image.id, staging);
	let sdkArtifactsDir: string | undefined;
	if (image.id === "hobo-cli" && dockerImageExists("hobo-sdk:candidate")) {
		sdkArtifactsDir = extractSdkArtifactsFromImage("hobo-sdk:candidate");
	}
	try {
		stageReleaseOciApp(image.id, staging.stagingRoot, {
			skipBuild: options.skipBuild,
			hardlink: staging.hardlink,
			sdkArtifactsDir,
		});
		if (image.id === "hobo-mcp") ensureCliCandidate();
		run(
			"docker",
			buildArgs(image, toolchain, version, revision, staging.stagingRoot),
		);
	} finally {
		if (sdkArtifactsDir)
			rmSync(sdkArtifactsDir, { recursive: true, force: true });
	}
	const localTag = `${image.name}:candidate`;
	cleanupReleaseOciBuildChain(image.id, {
		keepCandidate: options.keepCandidate,
	});
	return {
		localTag,
		ghcrRepo: ghcrRepository(manifest, image),
	};
}

function main(): void {
	const [imageId, ...flags] = process.argv.slice(2);
	const allowedFlags = ["--skip-build", "--keep-candidate", "--cleanup-only"];
	const cleanupOnly = flags.includes("--cleanup-only");
	if (
		!imageId ||
		flags.some((flag) => !allowedFlags.includes(flag)) ||
		(cleanupOnly && flags.length !== 1)
	) {
		console.error(
			"usage: node scripts/ci/build-release-oci-image.mts <image-id> [--skip-build] [--keep-candidate | --cleanup-only]",
		);
		process.exit(2);
	}
	if (cleanupOnly) {
		const manifest = loadReleaseOciManifest(root);
		if (!manifest.images.some((image) => image.id === imageId)) {
			throw new Error(`unknown release image id: ${imageId}`);
		}
		cleanupReleaseOciBuildChain(imageId);
		return;
	}
	const { localTag, ghcrRepo } = buildReleaseImage({
		imageId,
		skipBuild: flags.includes("--skip-build"),
		keepCandidate: flags.includes("--keep-candidate"),
	});
	console.log(`built ${localTag} (${ghcrRepo})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
