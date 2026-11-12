#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ghcrImageTags,
	parseReleaseRef,
	releaseImageIdsForTrain,
} from "../lib/release-version.mts";
import { runDockerPushWithRetry } from "../lib/docker-registry-push.mts";
import {
	qualifyReleaseCandidate,
	type ReleaseArtifact,
} from "./create-github-release.mts";

const root = join(import.meta.dirname, "..", "..");

function run(cmd: string, args: string[]): void {
	const result = spawnSync(cmd, args, {
		cwd: root,
		env: {
			...process.env,
			HOBO_RELEASE_SEMVER: parseReleaseRef(
				process.env.HOBO_RELEASE_VERSION ?? "",
			).semver,
		},
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
	}
}

/**
 * Each pushed image as a release Freight artifact: `@hobo/cd` verifies the
 * digest at the GHCR coordinate (registry lookup), never a claimed one.
 */
export function ociReleaseArtifacts(
	digestLines: readonly string[],
): ReleaseArtifact[] {
	return digestLines.map((line) => {
		const match = /^(?<repo>[^\s@]+\/(?<id>[^\s/@:]+))@(?<digest>sha256:[0-9a-f]{64})$/u.exec(
			line.trim(),
		);
		if (!match?.groups)
			throw new Error(`${line} is not a pushed digest (<repo>@sha256:<hex>)`);
		return {
			name: match.groups.id ?? "",
			kind: "ARTIFACT_KIND_OCI_IMAGE",
			digest: match.groups.digest ?? "",
			coordinate: line.trim(),
			ecosystem: "oci",
			// The registry decides index vs manifest; @hobo/cd verifies the digest.
			mediaType: "",
		};
	});
}

export function pushReleaseGhcrImages(options: {
	releaseRef: string;
	repository: string;
	digestListPath: string;
}): string[] {
	const parsed = parseReleaseRef(options.releaseRef);
	const repo = options.repository;
	const digests: string[] = [];
	const images = releaseImageIdsForTrain(parsed.train);
	for (const id of images) {
		if (id === "hobo-mcp") {
			run("node", [
				"--no-warnings",
				"scripts/ci/build-release-oci-image.mts",
				"hobo-cli",
				"--keep-candidate",
			]);
		}
		if (id === "hobo-cli" || id === "hobo-mcp") {
			run("node", [
				"--no-warnings",
				"scripts/ci/build-release-oci-image.mts",
				"hobo-sdk",
				"--keep-candidate",
			]);
		}
		run("node", [
			"--no-warnings",
			"scripts/ci/build-release-oci-image.mts",
			id,
			"--keep-candidate",
		]);
		const tags = ghcrImageTags(repo, id, parsed);
		if (tags.length !== 1) {
			throw new Error(`expected one GHCR tag for ${id}, got ${tags.length}`);
		}
		const tag = tags[0]!;
		run("docker", ["tag", `${id}:candidate`, tag]);
		runDockerPushWithRetry({ tag });
		const inspect = spawnSync(
			"docker",
			["inspect", "--format={{index .RepoDigests 0}}", tag],
			{ encoding: "utf8" },
		);
		if (inspect.status !== 0 || !inspect.stdout.trim()) {
			throw new Error(`docker inspect digest failed for ${tag}`);
		}
		digests.push(inspect.stdout.trim());
		run("docker", ["rmi", "-f", tag]);
		run("node", [
			"--no-warnings",
			"scripts/ci/build-release-oci-image.mts",
			id,
			"--cleanup-only",
		]);
	}
	writeFileSync(options.digestListPath, `${digests.join("\n")}\n`, "utf8");
	return digests;
}

async function main(): Promise<void> {
	const releaseRef = process.env.HOBO_RELEASE_VERSION ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const freightHome = process.env.HOBO_RELEASE_CD_HOME ?? "";
	const digestListPath = process.argv[2] ?? "/tmp/hobo-release-digests.txt";
	if (!releaseRef || !repository || !freightHome) {
		console.error(
			"HOBO_RELEASE_VERSION, GITHUB_REPOSITORY and HOBO_RELEASE_CD_HOME (release Freight journal) required",
		);
		process.exit(2);
	}
	const digests = pushReleaseGhcrImages({
		releaseRef,
		repository,
		digestListPath,
	});
	for (const line of digests) console.log(line);
	// GHCR has no @hobo/cd realizer: the push above is the existing publish
	// step. The images become Freight now, and attestation, the signed tag and
	// the GitHub Release run only when hobo-release/candidate does not block it.
	await qualifyReleaseCandidate({
		home: freightHome,
		family: "oci",
		registry: ociReleaseArtifacts(digests),
		labels: { "hobo.release/ref": releaseRef },
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(
			`::error::${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
