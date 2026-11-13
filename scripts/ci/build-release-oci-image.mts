#!/usr/bin/env node
/**
 * Build one release OCI app image from artifacts staged on the host runner.
 * PR/CI: build + load locally. Release: export the image as an OCI image layout
 * (exportReleaseOciLayout) that the hobo-release/oci-candidate realizer pushes
 * to GHCR by digest; nothing here pushes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
	isArray,
	isCount,
	isObject,
	isString,
	type Json,
	type JsonObject,
	parseUnknownJson,
} from "../lib/pins-json.ts";
import {
	ghcrRepository,
	loadReleaseOciManifest,
	type ReleaseOciImage,
} from "../lib/release-oci-contract.mts";
import {
	releaseSemverFromEnv,
	tryParseReleaseRef,
} from "../lib/release-version.mts";
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
	if (process.env.HOBO_CI_DEPS_LAYER) {
		const check = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"scripts/ci/deps-layer.mts",
				"check",
				"--require",
			],
			{ cwd: root, stdio: "inherit" },
		);
		if (check.status === 0) return;
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
	if (dockerImageExists(releaseImageCandidateRef("hobo-cli"))) return;
	throw new Error("hobo-mcp requires hobo-cli:candidate; build hobo-cli first");
}

function releaseImageCandidateRef(imageId: string): string {
	const manifest = loadReleaseOciManifest(root);
	const dep = manifest.images.find((entry) => entry.id === imageId);
	if (!dep) throw new Error(`unknown release image id: ${imageId}`);
	return `${dep.name}:candidate`;
}

function ensureReleaseImageCandidate(
	dependencyId: string,
	options: {
		imageId: string;
		version?: string;
		revision?: string;
		skipBuild?: boolean;
		keepCandidate?: boolean;
	},
): void {
	const ref = releaseImageCandidateRef(dependencyId);
	if (dockerImageExists(ref)) return;
	buildReleaseImage({
		...options,
		imageId: dependencyId,
		keepCandidate: true,
	});
}

export function cleanupReleaseOciBuild(
	imageId: string,
	localTag: string,
	options: {
		keepCandidate?: boolean;
		/** When true, skip builder prune (chain runs one prune after all tags). */
		deferBuilderPrune?: boolean;
	} = {},
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
	if (!options.keepCandidate && !options.deferBuilderPrune) {
		const cap =
			process.env.HOBO_RELEASE_BUILDER_CACHE_CAP ??
			process.env.HOBO_CI_WORKER_BUILDER_CACHE_CAP ??
			"2GB";
		spawnSync("docker", ["builder", "prune", "-f", "--keep-storage", cap], {
			cwd: root,
			stdio: "inherit",
		});
	}
}

function cleanupReleaseOciBuildChain(
	imageId: string,
	options: { keepCandidate?: boolean } = {},
): void {
	const deferBuilderPrune = true;
	cleanupReleaseOciBuild(imageId, `${imageId}:candidate`, {
		...options,
		deferBuilderPrune,
	});
	if (imageId === "hobo-mcp") {
		cleanupReleaseOciBuild("hobo-cli", "hobo-cli:candidate", {
			...options,
			deferBuilderPrune,
		});
	}
	if (!options.keepCandidate) {
		const cap =
			process.env.HOBO_RELEASE_BUILDER_CACHE_CAP ??
			process.env.HOBO_CI_WORKER_BUILDER_CACHE_CAP ??
			"2GB";
		spawnSync("docker", ["builder", "prune", "-f", "--keep-storage", cap], {
			cwd: root,
			stdio: "inherit",
		});
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
	if (image.id === "hobo-cli") {
		ensureReleaseImageCandidate("hobo-sdk", options);
		sdkArtifactsDir = extractSdkArtifactsFromImage(
			releaseImageCandidateRef("hobo-sdk"),
		);
	}
	if (image.id === "hobo-mcp") {
		ensureReleaseImageCandidate("hobo-sdk", options);
		ensureReleaseImageCandidate("hobo-cli", options);
	}
	try {
		const stageOptions: Parameters<typeof stageReleaseOciApp>[2] = {
			skipBuild: options.skipBuild === true,
			hardlink: staging.hardlink,
		};
		if (sdkArtifactsDir !== undefined)
			stageOptions.sdkArtifactsDir = sdkArtifactsDir;
		stageReleaseOciApp(image.id, staging.stagingRoot, stageOptions);
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
		keepCandidate: options.keepCandidate === true,
	});
	return {
		localTag,
		ghcrRepo: ghcrRepository(manifest, image),
	};
}

// ── OCI image layout export (what the oci-candidate realizer pushes) ────────

const OCI_INDEX_MEDIA_TYPES = new Set([
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
]);
const OCI_MANIFEST_MEDIA_TYPES = new Set([
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
]);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

type LayoutDescriptor = {
	mediaType?: string;
	digest?: string;
	size?: number;
	annotations?: Record<string, string>;
};

/**
 * One release image as an OCI image layout on disk, read by digest: the root
 * (an image manifest, or an index whose every child is in the layout), and
 * every blob it names. Paths, not bytes: a layer is read only when it is
 * stored, so the job never holds the whole image in memory.
 */
export type ReleaseOciLayout = Readonly<{
	/** The digest the registry will serve once the realizer pushes the root. */
	digest: string;
	mediaType: string;
	/** Size of the root manifest bytes. */
	size: number;
	/** Every blob of the image (manifests, configs, layers), root first. */
	blobs: readonly Readonly<{ digest: string; path: string; size: number }>[];
}>;

function layoutJson(path: string, what: string): JsonObject {
	let value: Json | undefined;
	try {
		value = parseUnknownJson(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		value = undefined;
	}
	if (!isObject(value))
		throw new Error(`OCI layout ${what} is not a JSON object (${path})`);
	return value;
}

/** The descriptors of a JSON value: objects only, each field parsed. */
function descriptors(value: Json | undefined): LayoutDescriptor[] {
	if (!isArray(value)) return [];
	const out: LayoutDescriptor[] = [];
	for (const entry of value) {
		if (!isObject(entry)) continue;
		const annotations: Record<string, string> = {};
		if (isObject(entry.annotations))
			for (const [key, note] of Object.entries(entry.annotations))
				if (isString(note)) annotations[key] = note;
		const descriptor: LayoutDescriptor = { annotations };
		if (isString(entry.mediaType)) descriptor.mediaType = entry.mediaType;
		if (isString(entry.digest)) descriptor.digest = entry.digest;
		if (isCount(entry.size)) descriptor.size = entry.size;
		out.push(descriptor);
	}
	return out;
}

/**
 * Read an OCI image layout directory (`oci-layout`, `index.json`,
 * `blobs/sha256/*`) into the root the release publishes. Every blob is
 * re-hashed and must match its descriptor's digest and size. An index whose
 * children are not all in the layout (a multi-platform index saved from one
 * platform) publishes its one complete, non-attestation child instead; any
 * other gap is refused, never filled.
 */
export function readOciLayout(dir: string): ReleaseOciLayout {
	if (!existsSync(join(dir, "oci-layout")))
		throw new Error(
			`${dir} is not an OCI image layout (no oci-layout); export with Docker 25+ (docker save writes OCI layouts)`,
		);
	const pathOf = (digest: string) =>
		join(dir, "blobs", "sha256", digest.slice("sha256:".length));
	const verified = new Map<string, number>();
	const blob = (descriptor: LayoutDescriptor): string | undefined => {
		const digest = descriptor.digest ?? "";
		if (!SHA256_DIGEST.test(digest))
			throw new Error(`OCI layout names a non-sha256 digest ${digest}`);
		const path = pathOf(digest);
		if (!existsSync(path)) return undefined;
		if (!verified.has(digest)) {
			const bytes = readFileSync(path);
			const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
			if (actual !== digest)
				throw new Error(`OCI layout blob ${digest} hashes to ${actual}`);
			verified.set(digest, bytes.byteLength);
		}
		const size = verified.get(digest) ?? -1;
		if (descriptor.size !== undefined && descriptor.size !== size)
			throw new Error(
				`OCI layout blob ${digest} is ${size} bytes, its descriptor says ${descriptor.size}`,
			);
		return path;
	};
	/** The closure of a manifest or index, or undefined when a blob is absent. */
	const closure = (descriptor: LayoutDescriptor): string[] | undefined => {
		if (blob(descriptor) === undefined) return undefined;
		const digest = descriptor.digest ?? "";
		const doc = layoutJson(pathOf(digest), `manifest ${digest}`);
		const mediaType = isString(doc.mediaType)
			? doc.mediaType
			: (descriptor.mediaType ?? "");
		if (OCI_INDEX_MEDIA_TYPES.has(mediaType)) {
			const out = [digest];
			for (const child of descriptors(doc.manifests)) {
				const sub = closure(child);
				if (sub === undefined) return undefined;
				out.push(...sub);
			}
			return out;
		}
		if (!OCI_MANIFEST_MEDIA_TYPES.has(mediaType))
			throw new Error(
				`OCI layout manifest ${digest} has media type ${mediaType || "(none)"}, not an image manifest or index`,
			);
		const out = [digest];
		for (const part of [
			...descriptors(doc.config === undefined ? [] : [doc.config]),
			...descriptors(doc.layers),
		]) {
			if (blob(part) === undefined) return undefined;
			out.push(part.digest ?? "");
		}
		return out;
	};
	const roots = descriptors(
		layoutJson(join(dir, "index.json"), "index.json").manifests,
	);
	if (roots.length !== 1)
		throw new Error(
			`OCI layout index.json names ${roots.length} images; export exactly one`,
		);
	let root = roots[0] ?? {};
	let digests = closure(root);
	if (digests === undefined && root.digest && blob(root)) {
		const doc = layoutJson(pathOf(root.digest), `index ${root.digest}`);
		const complete = descriptors(doc.manifests).filter(
			(child) =>
				child.annotations?.["vnd.docker.reference.type"] !==
					"attestation-manifest" && closure(child) !== undefined,
		);
		if (complete.length === 1 && complete[0]) {
			root = complete[0];
			digests = closure(root);
		}
	}
	if (digests === undefined || !root.digest)
		throw new Error(
			"OCI layout is missing blobs of the image it names; nothing is substituted. Remediation: re-export the image (docker save) after the build",
		);
	const rootDoc = layoutJson(pathOf(root.digest), `manifest ${root.digest}`);
	const unique = [...new Set(digests)];
	return {
		digest: root.digest,
		mediaType: isString(rootDoc.mediaType)
			? rootDoc.mediaType
			: (root.mediaType ?? ""),
		size: verified.get(root.digest) ?? 0,
		blobs: unique.map((digest) => ({
			digest,
			path: pathOf(digest),
			size: verified.get(digest) ?? 0,
		})),
	};
}

/**
 * Whether this host's `docker save` writes what the realizer pushes. Docker
 * 25 is the first release whose `docker save` writes an OCI image layout;
 * an older daemon is refused before anything is exported. The containerd
 * image store saves the compressed layers a registry push would send (and
 * the toolchain repository's layers match, so cross-repository mounts work);
 * the classic store saves them uncompressed: the digest is still the one
 * GHCR serves, but the upload is larger and no mount matches.
 */
export type DockerOciSaveSupport = Readonly<{
	serverVersion: string;
	compressedLayers: boolean;
}>;

export function dockerOciSaveSupport(
	serverVersion: string,
	driverStatusJson: string,
): DockerOciSaveSupport {
	const version = serverVersion.trim();
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	if (!Number.isInteger(major) || major < 25) {
		throw new Error(
			`release OCI export needs Docker 25 or later (docker save writes an OCI layout from 25); the daemon reports ${JSON.stringify(version)}. Remediation: upgrade Docker on this runner`,
		);
	}
	return {
		serverVersion: version,
		compressedLayers: driverStatusJson.includes("io.containerd.snapshotter"),
	};
}

function dockerFormat(args: string[]): string {
	const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
	return result.status === 0 ? result.stdout : "";
}

/**
 * Export a built release image from the local image store as an OCI image
 * layout under `dir` (`docker save`; see dockerOciSaveSupport for the host
 * it needs) and read it by digest.
 */
export function exportReleaseOciLayout(
	localTag: string,
	dir: string,
): ReleaseOciLayout {
	const support = dockerOciSaveSupport(
		dockerFormat(["version", "--format", "{{.Server.Version}}"]),
		dockerFormat(["info", "--format", "{{json .DriverStatus}}"]),
	);
	if (!support.compressedLayers) {
		console.warn(
			`docker ${support.serverVersion} uses the classic image store: ${localTag} is saved with uncompressed layers, so the GHCR upload is larger and no cross-repository mount matches. Enable the containerd image store on this runner to push compressed layers`,
		);
	}
	mkdirSync(dir, { recursive: true });
	const archive = join(dir, "image.tar");
	run("docker", ["save", "--output", archive, localTag]);
	run("tar", ["-xf", archive, "-C", dir]);
	rmSync(archive, { force: true });
	return readOciLayout(dir);
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
