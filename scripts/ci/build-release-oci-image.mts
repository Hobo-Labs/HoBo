#!/usr/bin/env node
/**
 * Build one release OCI app image from artifacts staged on the host runner.
 * PR/CI: build + load locally. Release: push to GHCR with semver tag (digest recorded separately).
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ciRunnerImageVersion } from "../lib/ci-runner-contract.mts";
import {
	ghcrRepository,
	loadReleaseOciManifest,
	type ReleaseOciImage,
} from "../lib/release-oci-contract.mts";
import { stageReleaseOciApp } from "./stage-release-oci-app.mts";

const root = join(import.meta.dirname, "..", "..");

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
	rmSync(join(root, "deploy/release-images/.staging", imageId), {
		recursive: true,
		force: true,
	});
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
	const version =
		options.version ??
		process.env.HOBO_RELEASE_VERSION ??
		process.env.GITHUB_REF_NAME ??
		ciRunnerImageVersion(root);
	const revision =
		options.revision ??
		process.env.HOBO_RELEASE_REVISION ??
		process.env.GITHUB_SHA ??
		"local";
	const toolchain = resolveToolchainImage(manifest);
	const stagingDir = join(root, "deploy/release-images/.staging", image.id);
	ensureReleaseBuildHost();
	stageReleaseOciApp(image.id, stagingDir, { skipBuild: options.skipBuild });
	if (image.id === "hobo-mcp") ensureCliCandidate();
	run("docker", buildArgs(image, toolchain, version, revision, stagingDir));
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
