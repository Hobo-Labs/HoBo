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
	const imageName = tag.split(":")[0] ?? tag;
	if (trimmed.includes(needle)) {
		const at = trimmed.lastIndexOf("@");
		if (at === -1) {
			throw new Error(`repo digest missing @ for ${tag}: ${trimmed}`);
		}
		const refPrefix = trimmed.slice(0, at);
		if (refPrefix !== imageName) {
			throw new Error(`repo digest repository mismatch for ${tag}: ${trimmed}`);
		}
		const digest = trimmed.slice(at + 1);
		return ghcrDigestRef(
			imageName,
			assertSha256ImageDigest(digest, `${tag} repo digest`),
		);
	}
	if (trimmed.startsWith("sha256:")) {
		return ghcrDigestRef(imageName, assertSha256ImageDigest(trimmed, tag));
	}
	const at = trimmed.lastIndexOf("@");
	if (at === -1) {
		throw new Error(`repo digest missing @ for ${tag}: ${trimmed}`);
	}
	const refPrefix = trimmed.slice(0, at);
	if (refPrefix !== imageName) {
		throw new Error(`repo digest repository mismatch for ${tag}: ${trimmed}`);
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

export type ImagetoolsCommandRunner = (
	command: string,
	args: readonly string[],
	options: { encoding: "utf8" },
) => { status: number | null; stdout?: string; stderr?: string };

function readStringField(root: JsonObject, key: string): string | undefined {
	const value = root[key];
	return isString(value) ? value : undefined;
}

function readDigestField(root: JsonObject): string | undefined {
	const raw =
		readStringField(root, "digest") ?? readStringField(root, "Digest");
	if (raw === undefined) return undefined;
	return assertSha256ImageDigest(raw, "imagetools digest");
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
	const fromManifest = manifestObj ? readDigestField(manifestObj) : undefined;
	if (fromManifest !== undefined) return fromManifest;
	const top =
		readStringField(parsed, "digest") ?? readStringField(parsed, "Digest");
	if (top === undefined) return undefined;
	return assertSha256ImageDigest(top, "imagetools digest");
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
	if (digest === undefined && labels !== undefined) {
		throw new Error(
			"imagetools inspect returned OCI labels without a digest (fail closed)",
		);
	}
	if (digest !== undefined && labels !== undefined) {
		return { digest, labels };
	}
	if (digest !== undefined) return { digest };
	return undefined;
}

/** Registry lookup via buildx (requires `docker login ghcr.io`). */
export function imagetoolsInspectTag(
	tag: string,
	run: ImagetoolsCommandRunner = (command, args, options) =>
		spawnSync(command, args, options),
): { digest?: string; labels?: Record<string, string> } | undefined {
	const result = run(
		"docker",
		["buildx", "imagetools", "inspect", tag, "--format", "{{json .}}"],
		{
			encoding: "utf8",
		},
	);
	if (result.status !== 0 || !result.stdout?.trim()) {
		const detail = `${result.stderr ?? ""}`.trim();
		if (isImagetoolsTagAbsent(detail, result.status ?? -1, tag))
			return undefined;
		const suffix = detail ? `: ${detail.split("\n").slice(-3).join(" ")}` : "";
		throw new Error(
			`imagetools inspect ${tag} failed (status ${result.status ?? "?"})${suffix}`,
		);
	}
	let parsed: { digest?: string; labels?: Record<string, string> } | undefined;
	try {
		parsed = parseImagetoolsInspectStdout(result.stdout);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`imagetools inspect ${tag}: ${message}`);
	}
	if (!parsed) {
		throw new Error(`imagetools inspect ${tag} returned unparsable JSON`);
	}
	if (!parsed.digest) {
		throw new Error(`imagetools inspect ${tag} returned no digest`);
	}
	return parsed;
}

/** Same bounded retry budget as `.github/actions/release-oci-attest` syft loop. */
export const REGISTRY_DIGEST_RESOLVE_MAX_ATTEMPTS = 12;
export const REGISTRY_DIGEST_RESOLVE_DELAY_MS = 10_000;

function sleepSyncMs(ms: number): void {
	const sec = Math.max(1, Math.ceil(ms / 1000));
	const slept = spawnSync("sleep", [String(sec)]);
	if (slept.error) {
		throw slept.error;
	}
}

/**
 * Match only buildx/registry missing-tag responses (not generic "not found" text).
 * Example: `ERROR: ghcr.io/owner/repo:tag: not found`
 */
export function isImagetoolsRegistryTagNotFound(stderr: string): boolean {
	const trimmed = stderr.trim();
	if (!trimmed) return false;
	return /(?:^|\n)error:\s*.+:\s*not found\s*$/im.test(trimmed);
}

const TAG_REF_SUFFIX = /[a-zA-Z0-9_.-]/;

/** Buildx missing-tag line must name the requested ref exactly (no substring match). */
export function stderrDeclaresRequestedTagNotFound(
	stderr: string,
	tag: string,
): boolean {
	for (const line of stderr.split("\n")) {
		const notFound = line.trim().match(/^error:\s*(.+):\s*not found$/iu);
		if (notFound?.[1]?.trim() === tag) return true;
	}
	return false;
}

/** Substring `tag` in stderr must not be a longer valid tag (`:v1` vs `:v1.1`). */
export function stderrReferencesExactTag(stderr: string, tag: string): boolean {
	let start = 0;
	for (;;) {
		const idx = stderr.indexOf(tag, start);
		if (idx === -1) return false;
		const before = idx > 0 ? stderr[idx - 1] : undefined;
		if (before !== undefined && TAG_REF_SUFFIX.test(before)) {
			start = idx + 1;
			continue;
		}
		const after = stderr[idx + tag.length];
		if (after === "@") {
			start = idx + 1;
			continue;
		}
		if (after === undefined || !TAG_REF_SUFFIX.test(after)) return true;
		start = idx + 1;
	}
}

function isImagetoolsTagAbsent(
	stderr: string,
	status: number,
	tag: string,
): boolean {
	if (status === 0) return false;
	if (isImagetoolsRegistryTagNotFound(stderr)) {
		return stderrDeclaresRequestedTagNotFound(stderr, tag);
	}
	const lower = stderr.toLowerCase();
	return (
		(/\bmanifest unknown\b/u.test(lower) &&
			stderrReferencesExactTag(stderr, tag)) ||
		(/\bname unknown\b/u.test(lower) &&
			stderrReferencesExactTag(stderr, tag)) ||
		(/\bno such manifest\b/u.test(lower) &&
			stderrReferencesExactTag(stderr, tag))
	);
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
	const releaseImage = labels["io.hobo.release.image"]?.trim();
	if (!releaseImage) {
		throw new Error(
			`${options.imageId}: ${options.digestRef} missing io.hobo.release.image`,
		);
	}
	if (releaseImage !== options.imageId) {
		throw new Error(
			`${options.imageId}: ${options.digestRef} io.hobo.release.image ${releaseImage} != expected ${options.imageId}`,
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

export function resolveRegistryDigestForTagWithRetry(
	tag: string,
	inspect: ImagetoolsInspect = imagetoolsInspectTag,
	options: {
		readonly maxAttempts?: number;
		readonly delayMs?: number;
		readonly sleepMs?: (ms: number) => void;
	} = {},
): string | undefined {
	const maxAttempts =
		options.maxAttempts ?? REGISTRY_DIGEST_RESOLVE_MAX_ATTEMPTS;
	const delayMs = options.delayMs ?? REGISTRY_DIGEST_RESOLVE_DELAY_MS;
	const sleepMs = options.sleepMs ?? sleepSyncMs;
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const digest = resolveRegistryDigestForTag(tag, inspect);
			if (digest) return digest;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt >= maxAttempts) break;
			console.error(
				`registry digest for ${tag} inspect failed (attempt ${attempt}/${maxAttempts}): ${lastError.message}; retrying in ${delayMs}ms`,
			);
			sleepMs(delayMs);
			continue;
		}
		if (attempt >= maxAttempts) break;
		console.error(
			`registry digest for ${tag} not visible (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`,
		);
		sleepMs(delayMs);
	}
	if (lastError) throw lastError;
	return undefined;
}
