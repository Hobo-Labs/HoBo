#!/usr/bin/env node
/**
 * Publish this leg's release image to GHCR through HoBo itself.
 *
 * The image is built, then exported as an OCI image layout
 * (build-release-oci-image.mts `exportReleaseOciLayout`). Every blob of it
 * (manifest or index, config, layers) goes into the HoBo artifact store, and
 * the root digest becomes release Freight at its GHCR coordinate, promoted
 * into hobo-release/oci-candidate through `hobo deploy`. Its realizer
 * (@hobo/provider-oci-registry) uploads the config and layers (cross-repo
 * mounting from the toolchain image's repository when GHCR holds a blob
 * there), PUTs the manifest by digest with its exact bytes, then the release
 * tag, and observes digest and tag before the Camp qualifies. Nothing else
 * pushes: no `docker push`. The digest recorded as Freight is the digest the
 * registry serves, because the registry recomputes it from the bytes the
 * realizer PUT and the realizer refuses anything it does not observe there.
 *
 * A release tag already on GHCR for this build (same revision and version
 * labels, finding 143) is reused: its registry digest is recorded and
 * verified at the registry instead, and nothing is rebuilt.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertReleaseImageMatchesBuild,
	dockerConfigLabelsForDigestRef,
	ghcrDigestRef,
	normalizeRepoDigestLine,
	registryInspectTag,
	resolveRegistryDigestForTag,
} from "../lib/release-ghcr-digest.mts";
import {
	FULL_RELEASE_IMAGE_IDS,
	ghcrImageTags,
	parseReleaseRef,
	releaseImageIdsForTrain,
} from "../lib/release-version.mts";
import {
	exportReleaseOciLayout,
	type ReleaseOciLayout,
} from "./build-release-oci-image.mts";
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

const DIGEST_LINE =
	/^(?<repo>[^\s@]+\/(?<id>[^\s/@:]+))@(?<digest>sha256:[0-9a-f]{64})$/u;

function digestLine(line: string) {
	const match = DIGEST_LINE.exec(line.trim());
	if (!match?.groups)
		throw new Error(`${line} is not a pushed digest (<repo>@sha256:<hex>)`);
	return {
		repo: match.groups.repo ?? "",
		id: match.groups.id ?? "",
		digest: match.groups.digest ?? "",
	};
}

/**
 * Images already on GHCR as release Freight artifacts: `@hobo/cd` verifies
 * the digest at the GHCR coordinate (registry lookup), never a claimed one.
 */
export function ociReleaseArtifacts(
	digestLines: readonly string[],
): ReleaseArtifact[] {
	return digestLines.map((line) => {
		const { id, digest } = digestLine(line);
		return {
			name: id,
			kind: "ARTIFACT_KIND_OCI_IMAGE",
			digest,
			coordinate: line.trim(),
			ecosystem: "oci",
			// The registry decides index vs manifest; @hobo/cd verifies the digest.
			mediaType: "",
		};
	});
}

/**
 * An image built here as release Freight: the root digest at the GHCR
 * coordinate the realizer publishes it to, backed by the HoBo artifact store
 * (`ecosystem: store`; the store's verified copy is what backs the digest
 * until the realizer has pushed it).
 */
export function storedOciReleaseArtifact(
	line: string,
	layout: Pick<ReleaseOciLayout, "digest" | "mediaType" | "size">,
): ReleaseArtifact {
	const { id, digest } = digestLine(line);
	if (digest !== layout.digest)
		throw new Error(`${line} does not name the layout root ${layout.digest}`);
	return {
		name: id,
		kind: "ARTIFACT_KIND_OCI_IMAGE",
		digest,
		coordinate: line.trim(),
		ecosystem: "store",
		mediaType: layout.mediaType,
		sizeBytes: String(layout.size),
	};
}

/**
 * The release tag the realizer owns on each digest: the one GHCR tag of this
 * release ref.
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

/**
 * The GHCR repository whose blobs an upload may mount: the toolchain image
 * every release image is built FROM (ensure-ci-worker-image.mts pulls it
 * from `ghcr.io/<repository>/hobo-ci-worker`).
 */
export function releaseMountFrom(repository: string): string {
	return `${repository.toLowerCase()}/hobo-ci-worker`;
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

/** One image of this leg, ready to record: reused from GHCR, or built here. */
export type ReleaseImage = Readonly<{
	id: string;
	/** `<GHCR repo>@sha256:…`; the attest step selects it by `/<id>@`. */
	line: string;
	/** Built here: the OCI layout the realizer pushes. Reused: absent. */
	layout?: ReleaseOciLayout;
	/** Directory holding the layout, removed once the leg is done. */
	layoutDir?: string;
}>;

/**
 * Build (or reuse) every image of this leg and export each built one as an
 * OCI image layout. Nothing is pushed here.
 */
export function buildReleaseGhcrImages(options: {
	releaseRef: string;
	repository: string;
	imageId?: string | undefined;
	/** Seam: export a built image (default `exportReleaseOciLayout`). */
	exportLayout?: (localTag: string, dir: string) => ReleaseOciLayout;
}): ReleaseImage[] {
	const parsed = parseReleaseRef(options.releaseRef);
	const out: ReleaseImage[] = [];
	const images = releaseImagesToPublish(options.releaseRef, options.imageId);
	const revision = releaseRevisionFromEnv();
	if (images.length === 0) {
		console.log(
			`${options.imageId} is not part of the ${parsed.train} release train; nothing to publish`,
		);
	}
	for (const id of images) {
		const tags = ghcrImageTags(options.repository, id, parsed);
		if (tags.length !== 1) {
			throw new Error(`expected one GHCR tag for ${id}, got ${tags.length}`);
		}
		const tag = tags[0] ?? "";
		const reused = tryReusePublishedTag({
			imageId: id,
			tag,
			revision,
			releaseVersion: parsed.semver,
		});
		if (reused) {
			out.push({ id, line: reused });
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
		const layoutDir = mkdtempSync(
			join(process.env.RUNNER_TEMP?.trim() || tmpdir(), `hobo-oci-${id}-`),
		);
		const layout = (options.exportLayout ?? exportReleaseOciLayout)(
			`${id}:candidate`,
			layoutDir,
		);
		const repository = tag.slice(0, tag.lastIndexOf(":"));
		out.push({
			id,
			line: `${repository}@${layout.digest}`,
			layout,
			layoutDir,
		});
		console.log(`exported ${id} as ${repository}@${layout.digest}`);
		run("node", [
			"--no-warnings",
			"scripts/ci/build-release-oci-image.mts",
			id,
			"--cleanup-only",
		]);
	}
	return out;
}

/** Every layout blob, read one at a time as the artifact store takes it. */
export function* releaseLayoutBlobs(
	images: readonly ReleaseImage[],
): Generator<Uint8Array> {
	for (const image of images)
		for (const blob of image.layout?.blobs ?? [])
			yield new Uint8Array(readFileSync(blob.path));
}

/**
 * Record this leg's images as release Freight and promote them into
 * hobo-release/oci-candidate, whose realizer publishes them; throws unless
 * the Camp qualified (nothing then reaches the digest list or attestation).
 */
export async function publishReleaseGhcrImages(
	options: {
		releaseRef: string;
		repository: string;
		freightHome: string;
		images: readonly ReleaseImage[];
		imageId?: string | undefined;
	},
	qualify: typeof qualifyReleaseCandidate = qualifyReleaseCandidate,
): Promise<void> {
	const lines = options.images.map((image) => image.line);
	const labels = {
		"hobo.release/ref": options.releaseRef,
		"hobo.cd/oci.tags": releaseTagsOf(
			options.releaseRef,
			options.repository,
			lines,
		),
		"hobo.cd/oci.mount-from": releaseMountFrom(options.repository),
		...(options.imageId === undefined
			? undefined
			: { "hobo.release/image": options.imageId }),
	};
	await qualify({
		home: options.freightHome,
		family: "oci",
		registry: options.images.flatMap((image) =>
			image.layout
				? [storedOciReleaseArtifact(image.line, image.layout)]
				: ociReleaseArtifacts([image.line]),
		),
		blobs: releaseLayoutBlobs(options.images),
		labels,
	});
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
	const images = buildReleaseGhcrImages({ releaseRef, repository, imageId });
	try {
		// An image this train does not ship has no Freight to record.
		if (images.length > 0)
			await publishReleaseGhcrImages({
				releaseRef,
				repository,
				freightHome,
				images,
				imageId,
			});
	} finally {
		for (const image of images)
			if (image.layoutDir)
				rmSync(image.layoutDir, { recursive: true, force: true });
	}
	// Written only once the Camp qualified: the digest GHCR serves. An empty
	// list means "this train ships no such image"; attest skips it.
	const lines = images.map((image) => image.line);
	writeFileSync(
		digestListPath,
		lines.length === 0 ? "" : `${lines.join("\n")}\n`,
		"utf8",
	);
	for (const line of lines) console.log(line);
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
