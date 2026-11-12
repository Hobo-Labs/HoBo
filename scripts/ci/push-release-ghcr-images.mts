#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	FULL_RELEASE_IMAGE_IDS,
	ghcrImageTags,
	parseReleaseRef,
	releaseImageIdsForTrain,
} from "../lib/release-version.mts";
import { runDockerPushWithRetry } from "../lib/docker-registry-push.mts";

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

/** One `docker push` attempt may run this long before it is stopped and retried. */
export const RELEASE_PUSH_ATTEMPT_TIMEOUT_MS = 4 * 60_000;
/**
 * No push attempt runs past this. The hobo-mcp leg spends up to about 10
 * minutes before its push (setup, up to 5 for the worker image, three builds),
 * so 8 keeps it inside the job's 20 with room to report the failure.
 */
export const RELEASE_PUSH_BUDGET_MS = 8 * 60_000;

function envMs(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`${name} must be a positive number of seconds, got ${raw}`);
	}
	return seconds * 1000;
}

/**
 * The images this run publishes: the release train's images, or only `imageId`
 * when one is named (the publish job runs one image per matrix leg). An image
 * the train does not ship yields none.
 */
export function releaseImagesToPublish(
	releaseRef: string,
	imageId?: string,
): readonly string[] {
	const images = releaseImageIdsForTrain(parseReleaseRef(releaseRef).train);
	if (imageId === undefined) return images;
	// A misspelt id must not read as "not in this train" and publish nothing.
	if (!FULL_RELEASE_IMAGE_IDS.some((id) => id === imageId)) {
		throw new Error(`unknown release image id: ${imageId}`);
	}
	return images.includes(imageId) ? [imageId] : [];
}

/**
 * `<registry repo>@sha256:...` for the tag just pushed. The digest comes from
 * `docker push`'s own `digest:` line; failing that, from the `RepoDigests`
 * entry for that repository. Never `RepoDigests[0]`: with the containerd image
 * store (ARC pods) the first entry is the local name, `hobo-sdk@sha256:...`,
 * which attest cannot find (finding 141).
 */
export function pushedDigestRef(
	tag: string,
	pushOutput: string,
	repoDigestLines: string,
): string {
	const repository = tag.slice(0, tag.lastIndexOf(":"));
	const pushed = /\bdigest: (sha256:[0-9a-f]{64})\b/u.exec(pushOutput)?.[1];
	if (pushed) return `${repository}@${pushed}`;
	const entries = repoDigestLines
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const prefix = `${repository}@`;
	const match = entries.find(
		(entry) =>
			entry.startsWith(prefix) &&
			/^sha256:[0-9a-f]{64}$/u.test(entry.slice(prefix.length)),
	);
	if (match) return match;
	throw new Error(
		`no digest for ${tag}: docker push printed none and RepoDigests has no ${prefix} entry (${entries.join(", ") || "none"})`,
	);
}

export function pushReleaseGhcrImages(options: {
	releaseRef: string;
	repository: string;
	digestListPath: string;
	imageId?: string | undefined;
}): string[] {
	const parsed = parseReleaseRef(options.releaseRef);
	const repo = options.repository;
	const digests: string[] = [];
	const images = releaseImagesToPublish(options.releaseRef, options.imageId);
	const attemptTimeoutMs = envMs(
		"HOBO_RELEASE_PUSH_ATTEMPT_TIMEOUT_SEC",
		RELEASE_PUSH_ATTEMPT_TIMEOUT_MS,
	);
	const budgetMs = envMs(
		"HOBO_RELEASE_PUSH_BUDGET_SEC",
		RELEASE_PUSH_BUDGET_MS,
	);
	if (images.length === 0) {
		console.log(
			`${options.imageId} is not part of the ${parsed.train} release train; nothing to publish`,
		);
	}
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
		const pushStarted = Date.now();
		console.log(`pushing ${tag}`);
		const pushOutput = runDockerPushWithRetry({
			tag,
			attemptTimeoutMs,
			budgetMs,
		});
		console.log(
			`pushed ${tag} in ${Math.round((Date.now() - pushStarted) / 1000)}s`,
		);
		const inspect = spawnSync(
			"docker",
			["inspect", "--format={{range .RepoDigests}}{{println .}}{{end}}", tag],
			{ encoding: "utf8" },
		);
		digests.push(
			pushedDigestRef(
				tag,
				pushOutput,
				inspect.status === 0 ? inspect.stdout : "",
			),
		);
		run("docker", ["rmi", "-f", tag]);
		run("node", [
			"--no-warnings",
			"scripts/ci/build-release-oci-image.mts",
			id,
			"--cleanup-only",
		]);
	}
	// An empty list means "this train ships no such image"; attest skips it.
	writeFileSync(
		options.digestListPath,
		digests.length === 0 ? "" : `${digests.join("\n")}\n`,
		"utf8",
	);
	return digests;
}

function main(): void {
	const releaseRef = process.env.HOBO_RELEASE_VERSION ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const args = process.argv.slice(2);
	const imageFlag = args.indexOf("--image");
	const imageId = imageFlag === -1 ? undefined : args[imageFlag + 1];
	if (imageFlag !== -1) args.splice(imageFlag, 2);
	const digestListPath = args[0] ?? "/tmp/hobo-release-digests.txt";
	if (!releaseRef || !repository || (imageFlag !== -1 && !imageId)) {
		console.error(
			"usage: HOBO_RELEASE_VERSION=... GITHUB_REPOSITORY=... push-release-ghcr-images.mts [--image <id>] [digest-list-path]",
		);
		process.exit(2);
	}
	const digests = pushReleaseGhcrImages({
		releaseRef,
		repository,
		digestListPath,
		imageId,
	});
	for (const line of digests) console.log(line);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
