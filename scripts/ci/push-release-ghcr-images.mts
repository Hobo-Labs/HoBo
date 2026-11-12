#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerPushWithRetry } from "../lib/docker-registry-push.mts";
import {
	assertReleaseImageMatchesBuild,
	dockerConfigLabelsForDigestRef,
	ghcrDigestRef,
	normalizeRepoDigestLine,
	registryInspectTag,
	resolveRegistryDigestForTag,
	resolveRegistryDigestForTagWithRetry,
} from "../lib/release-ghcr-digest.mts";
import {
	FULL_RELEASE_IMAGE_IDS,
	ghcrImageTags,
	parseReleaseRef,
	releaseImageIdsForTrain,
} from "../lib/release-version.mts";
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
		const match =
			/^(?<repo>[^\s@]+\/(?<id>[^\s/@:]+))@(?<digest>sha256:[0-9a-f]{64})$/u.exec(
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

/**
 * The release tag the realizer owns on each digest: the one GHCR tag of this
 * release ref (the tag `docker push` wrote, or the published tag reused).
 */
export function releaseTagsOf(
	releaseRef: string,
	repository: string,
	digestLines: readonly string[],
): string {
	const parsed = parseReleaseRef(releaseRef);
	const tags = new Set<string>();
	for (const artifact of ociReleaseArtifacts(digestLines))
		for (const ref of ghcrImageTags(repository, artifact.name, parsed))
			tags.add(ref.slice(ref.lastIndexOf(":") + 1));
	return [...tags].sort().join(",");
}

/** One `docker push` attempt may run this long before it is stopped and retried. */
export const RELEASE_PUSH_ATTEMPT_TIMEOUT_MS = 4 * 60_000;
/**
 * No push attempt runs past this. The hobo-mcp leg spends up to about 10
 * minutes before its push (setup, up to 5 for the worker image, three builds),
 * so 8 keeps it inside 20 with room to report the failure; the job's 30 adds
 * the hobo CLI build that records the image as release Freight.
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

function releaseRevisionFromEnv(): string {
	const revision =
		process.env.HOBO_RELEASE_REVISION?.trim() ??
		process.env.GITHUB_SHA?.trim() ??
		"";
	if (!revision) {
		throw new Error("HOBO_RELEASE_REVISION or GITHUB_SHA required to publish");
	}
	return revision;
}

function tryReusePublishedTag(options: {
	imageId: string;
	tag: string;
	revision: string;
	releaseVersion: string;
}): string | undefined {
	const inspected = registryInspectTag(options.tag);
	const digestRef =
		inspected?.digest !== undefined
			? normalizeRepoDigestLine(
					options.tag,
					ghcrDigestRef(
						options.tag.split(":")[0] ?? options.tag,
						inspected.digest,
					),
					options.imageId,
				)
			: resolveRegistryDigestForTag(options.tag);
	if (!digestRef) return undefined;
	const labels = dockerConfigLabelsForDigestRef(digestRef);
	assertReleaseImageMatchesBuild({
		imageId: options.imageId,
		tag: options.tag,
		digestRef,
		revision: options.revision,
		releaseVersion: options.releaseVersion,
		labels,
	});
	const line = normalizeRepoDigestLine(options.tag, digestRef, options.imageId);
	console.log(
		`reusing registry ${options.tag} as ${line} (revision ${options.revision})`,
	);
	return line;
}

function recordDigestAfterPush(
	imageId: string,
	tag: string,
	pushOutput: string,
): string {
	const inspect = spawnSync(
		"docker",
		["inspect", "--format={{range .RepoDigests}}{{println .}}{{end}}", tag],
		{ encoding: "utf8" },
	);
	let raw: string;
	try {
		raw = pushedDigestRef(
			tag,
			pushOutput,
			inspect.status === 0 ? inspect.stdout : "",
		);
	} catch (error) {
		const remote = resolveRegistryDigestForTagWithRetry(tag);
		if (!remote) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`${detail}; registry lookup also failed for ${tag}`);
		}
		raw = remote;
	}
	return normalizeRepoDigestLine(tag, raw, imageId);
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
	const revision = releaseRevisionFromEnv();
	const releaseVersion = parsed.semver;
	if (images.length === 0) {
		console.log(
			`${options.imageId} is not part of the ${parsed.train} release train; nothing to publish`,
		);
	}
	for (const id of images) {
		const tags = ghcrImageTags(repo, id, parsed);
		if (tags.length !== 1) {
			throw new Error(`expected one GHCR tag for ${id}, got ${tags.length}`);
		}
		const tag = tags[0]!;
		const reused = tryReusePublishedTag({
			imageId: id,
			tag,
			revision,
			releaseVersion,
		});
		if (reused) {
			digests.push(reused);
			continue;
		}
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
		digests.push(recordDigestAfterPush(id, tag, pushOutput));
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

async function main(): Promise<void> {
	const releaseRef = process.env.HOBO_RELEASE_VERSION ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const freightHome = process.env.HOBO_RELEASE_CD_HOME ?? "";
	const args = process.argv.slice(2);
	const imageFlag = args.indexOf("--image");
	const imageId = imageFlag === -1 ? undefined : args[imageFlag + 1];
	if (imageFlag !== -1) args.splice(imageFlag, 2);
	const digestListPath = args[0] ?? "/tmp/hobo-release-digests.txt";
	if (
		!releaseRef ||
		!repository ||
		!freightHome ||
		(imageFlag !== -1 && !imageId)
	) {
		console.error(
			"usage: HOBO_RELEASE_VERSION=... GITHUB_REPOSITORY=... HOBO_RELEASE_CD_HOME=<release Freight journal> push-release-ghcr-images.mts [--image <id>] [digest-list-path]",
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
	// An image this train does not ship pushed nothing: no Freight to record.
	if (digests.length === 0) return;
	// The digests above (pushed, or the already-published tag GHCR itself
	// reports) become release Freight, verified at the registry, and are
	// promoted into hobo-release/oci-candidate: its realizer
	// (@hobo/provider-oci-registry) asserts the release tag on that digest and
	// observes digest and tag before the Camp qualifies. Anything but qualified
	// fails this leg, so attestation, the signed tag and the GitHub Release
	// never run.
	const labels = {
		"hobo.release/ref": releaseRef,
		"hobo.cd/oci.tags": releaseTagsOf(releaseRef, repository, digests),
		...(imageId === undefined ? undefined : { "hobo.release/image": imageId }),
	};
	await qualifyReleaseCandidate({
		home: freightHome,
		family: "oci",
		registry: ociReleaseArtifacts(digests),
		labels,
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
