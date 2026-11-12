import { spawnSync } from "node:child_process";
import {
	isObject,
	isString,
	type Json,
	type JsonObject,
	parseUnknownJson,
} from "./pins-json.ts";

/** OCI image digest: lowercase `sha256:` + 64 hex (fail closed on anything else). */
export const SHA256_IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function assertSha256ImageDigest(
	digest: string,
	context: string,
): string {
	const trimmed = digest.trim();
	if (!SHA256_IMAGE_DIGEST.test(trimmed)) {
		throw new Error(
			`${context}: digest must match sha256:[a-f0-9]{64}, got ${JSON.stringify(trimmed)}`,
		);
	}
	return trimmed;
}

/** `ghcr.io/owner/hobo/image-id@sha256:…` line attest grep expects. */
export function ghcrDigestRef(
	imageNameWithoutTag: string,
	digest: string,
): string {
	return `${imageNameWithoutTag}@${assertSha256ImageDigest(digest, "ghcrDigestRef")}`;
}

export function normalizeRepoDigestLine(
	tag: string,
	repoDigest: string,
	imageId: string,
): string {
	const trimmed = repoDigest.trim();
	if (!trimmed) {
		throw new Error(`empty repo digest for ${tag}`);
	}
	const needle = `/${imageId}@`;
	if (trimmed.includes(needle)) return trimmed;
	const imageName = tag.split(":")[0] ?? tag;
	if (trimmed.startsWith("sha256:")) {
		return ghcrDigestRef(imageName, assertSha256ImageDigest(trimmed, tag));
	}
	const at = trimmed.lastIndexOf("@");
	if (at === -1) {
		throw new Error(`repo digest missing @ for ${tag}: ${trimmed}`);
	}
	const digest = trimmed.slice(at + 1);
	return ghcrDigestRef(
		imageName,
		assertSha256ImageDigest(digest, `${tag} repo digest`),
	);
}

export type ImagetoolsInspect = (
	tag: string,
) => { digest?: string; labels?: Record<string, string> } | undefined;

function readStringField(root: JsonObject, key: string): string | undefined {
	const value = root[key];
	return isString(value) ? value : undefined;
}

function readDigestField(root: JsonObject): string | undefined {
	const raw =
		readStringField(root, "digest") ?? readStringField(root, "Digest");
	if (raw === undefined) return undefined;
	try {
		return assertSha256ImageDigest(raw, "imagetools digest");
	} catch {
		return undefined;
	}
}

function stringLabelsFromJson(
	labels: Json | undefined,
): Record<string, string> | undefined {
	if (!isObject(labels)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(labels)) {
		if (isString(value)) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function labelsFromImagetoolsJson(
	parsed: Json,
): Record<string, string> | undefined {
	if (!isObject(parsed)) return undefined;
	const manifest = parsed.Manifest;
	const manifestObj = isObject(manifest) ? manifest : undefined;
	const config =
		parsed.config ??
		parsed.Config ??
		manifestObj?.config ??
		manifestObj?.Config;
	if (!isObject(config)) return undefined;
	return stringLabelsFromJson(config.labels ?? config.Labels);
}

function digestFromImagetoolsJson(parsed: Json): string | undefined {
	if (!isObject(parsed)) return undefined;
	const manifest = parsed.manifest ?? parsed.Manifest;
	const manifestObj = isObject(manifest) ? manifest : undefined;
	return (
		(manifestObj && readDigestField(manifestObj)) ??
		readStringField(parsed, "digest") ??
		readStringField(parsed, "Digest") ??
		undefined
	);
}

/** Test and production parser for `docker buildx imagetools inspect --format '{{json .}}'`. */
export function parseImagetoolsInspectStdout(
	stdout: string,
): { digest?: string; labels?: Record<string, string> } | undefined {
	let parsed: Json | undefined;
	try {
		parsed = parseUnknownJson(JSON.parse(stdout.trim()));
	} catch {
		return undefined;
	}
	if (parsed === undefined) return undefined;
	const digest = digestFromImagetoolsJson(parsed);
	const labels = labelsFromImagetoolsJson(parsed);
	if (digest === undefined && labels === undefined) return undefined;
	if (digest !== undefined && labels !== undefined) {
		return { digest, labels };
	}
	if (digest !== undefined) return { digest };
	if (labels !== undefined) return { labels };
	return undefined;
}

/** Registry lookup via buildx (requires `docker login ghcr.io`). */
export function imagetoolsInspectTag(
	tag: string,
	run = spawnSync,
): { digest?: string; labels?: Record<string, string> } | undefined {
	const result = run(
		"docker",
		["buildx", "imagetools", "inspect", tag, "--format", "{{json .}}"],
		{
			encoding: "utf8",
		},
	);
	if (result.status !== 0 || !result.stdout?.trim()) return undefined;
	return parseImagetoolsInspectStdout(result.stdout);
}

export function assertReleaseImageMatchesBuild(options: {
	imageId: string;
	tag: string;
	digestRef: string;
	revision: string;
	releaseVersion: string;
	labels?: Record<string, string> | undefined;
	localInspect?: (ref: string) => Record<string, string> | undefined;
}): void {
	let labels = options.labels;
	if (!labels && options.localInspect) {
		labels = options.localInspect(options.tag);
	}
	if (!labels || Object.keys(labels).length === 0) {
		throw new Error(
			`${options.imageId}: registry tag ${options.tag} has no OCI labels; cannot verify revision ${options.revision}`,
		);
	}
	const revision = labels["org.opencontainers.image.revision"]?.trim();
	if (!revision) {
		throw new Error(
			`${options.imageId}: ${options.digestRef} missing org.opencontainers.image.revision`,
		);
	}
	if (revision !== options.revision) {
		throw new Error(
			`${options.imageId}: ${options.digestRef} revision ${revision} != expected ${options.revision}`,
		);
	}
	const version = labels["org.opencontainers.image.version"]?.trim();
	if (version && version !== options.releaseVersion) {
		throw new Error(
			`${options.imageId}: ${options.digestRef} version ${version} != expected ${options.releaseVersion}`,
		);
	}
}

/** Pull and read labels for an immutable `name@sha256:…` ref (not a mutable tag). */
export function dockerConfigLabelsForDigestRef(
	ref: string,
	run = spawnSync,
): Record<string, string> | undefined {
	const pull = run("docker", ["pull", "--quiet", ref], {
		encoding: "utf8",
		stdio: "inherit",
	});
	if (pull.status !== 0) {
		throw new Error(`docker pull ${ref} failed (${pull.status})`);
	}
	const labels = dockerConfigLabelsForRef(ref, run);
	run("docker", ["rmi", "-f", ref], { encoding: "utf8", stdio: "inherit" });
	return labels;
}

export function dockerConfigLabelsForRef(
	ref: string,
	run = spawnSync,
): Record<string, string> | undefined {
	const result = run(
		"docker",
		["inspect", "--format", "{{json .Config.Labels}}", ref],
		{ encoding: "utf8" },
	);
	if (result.status !== 0 || !result.stdout?.trim()) return undefined;
	let parsed: Json | undefined;
	try {
		parsed = parseUnknownJson(JSON.parse(result.stdout.trim()));
	} catch {
		return undefined;
	}
	return parsed === undefined ? undefined : stringLabelsFromJson(parsed);
}

export function resolveRegistryDigestForTag(
	tag: string,
	inspect: ImagetoolsInspect = imagetoolsInspectTag,
): string | undefined {
	const info = inspect(tag);
	if (!info?.digest) return undefined;
	const imageName = tag.split(":")[0] ?? tag;
	return ghcrDigestRef(imageName, info.digest);
}
