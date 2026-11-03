#!/usr/bin/env node
/**
 * Build one release OCI app image (toolchain layer + app Dockerfile).
 * PR/CI: build + load locally. Release: push to GHCR with semver tag (digest recorded separately).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ciRunnerImageVersion } from "../lib/ci-runner-contract.mts";
import {
	ghcrRepository,
	loadReleaseOciManifest,
	type ReleaseOciImage,
} from "../lib/release-oci-contract.mts";

const root = join(import.meta.dirname, "..", "..");

function run(
	cmd: string,
	args: string[],
	env: Record<string, string> = {},
): void {
	const result = spawnSync(cmd, args, {
		cwd: root,
		env: { ...process.env, ...env },
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
	}
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
		image.dockerfile,
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
	args.push("-t", `${image.name}:candidate`, root);
	return args;
}

export type BuiltReleaseImage = { localTag: string; ghcrRepo: string };

export function buildReleaseImage(options: {
	imageId: string;
	version?: string;
	revision?: string;
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
	run("docker", buildArgs(image, toolchain, version, revision));
	return {
		localTag: `${image.name}:candidate`,
		ghcrRepo: ghcrRepository(manifest, image),
	};
}

function main(): void {
	const imageId = process.argv[2];
	if (!imageId) {
		console.error(
			"usage: node scripts/ci/build-release-oci-image.mts <image-id>",
		);
		process.exit(2);
	}
	const { localTag, ghcrRepo } = buildReleaseImage({ imageId });
	console.log(`built ${localTag} (${ghcrRepo})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
