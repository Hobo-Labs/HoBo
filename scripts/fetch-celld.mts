#!/usr/bin/env node
/**
 * Install the pinned `celld` binary from its OCI image so the
 * `@hobo/runtime-celld` live lane can run.
 *
 * The pin in `packages/runtimes/runtime-celld/src/upstream-pin.ts` names an
 * image index digest. This script walks index -> per-platform manifest ->
 * layers, and verifies the sha256 of *every* document and blob against the
 * digest its parent declared before anything is decompressed, extracted, or
 * made executable. The test suite executes what this script installs, so the
 * pin is only worth having if it is actually checked.
 *
 * Usage:
 *   NODE_OPTIONS= npx tsx scripts/fetch-celld.mts [--force] [--bin PATH]
 *
 * Environment:
 *   CELLD_BIN            install path (default /tmp/hobo-live/bin/celld,
 *                        matching the live tests' own default)
 *   NODE_EXTRA_CA_CERTS  trust anchor for a proxy-terminated TLS chain
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

import { CELLD_PIN } from "../packages/runtimes/runtime-celld/src/upstream-pin.ts";

export const DEFAULT_CELLD_BIN = "/tmp/hobo-live/bin/celld";

const OCI_INDEX_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
] as const;
const OCI_MANIFEST_TYPES = [
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
] as const;
const GZIP_LAYER_TYPES = new Set([
	"application/vnd.oci.image.layer.v1.tar+gzip",
	"application/vnd.docker.image.rootfs.diff.tar.gzip",
]);
const PLAIN_LAYER_TYPES = new Set(["application/vnd.oci.image.layer.v1.tar"]);

/** Every refusal in this script is named; a bare Error would be untraceable. */
export class CelldFetchError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "CelldFetchError";
		this.code = code;
	}
}

type Descriptor = {
	mediaType: string;
	digest: string;
	size?: number;
	platform?: { os?: string; architecture?: string; variant?: string };
	annotations?: Record<string, string>;
};

type ImageIndex = { manifests?: Descriptor[] };
type ImageManifest = { config?: Descriptor; layers?: Descriptor[] };
type ImageConfig = { config?: { Entrypoint?: string[] } };

export function celldBinPath(): string {
	const fromEnv = process.env.CELLD_BIN;
	return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_CELLD_BIN;
}

/** `ghcr.io/denoland/celld` -> registry host plus repository path. */
type ImageReference = {
	host: string;
	repository: string;
};

export function splitImageReference(image: string): ImageReference {
	const slash = image.indexOf("/");
	if (slash <= 0) {
		throw new CelldFetchError(
			"CELLD_PIN_MALFORMED",
			`image reference ${image} has no registry host`,
		);
	}
	return { host: image.slice(0, slash), repository: image.slice(slash + 1) };
}

/** `process.arch` in OCI's vocabulary. */
type OciPlatform = {
	os: string;
	architecture: string;
};

export function ociPlatform(): OciPlatform {
	const architecture =
		process.arch === "x64"
			? "amd64"
			: process.arch === "arm64"
				? "arm64"
				: undefined;
	if (architecture === undefined || process.platform !== "linux") {
		throw new CelldFetchError(
			"CELLD_PLATFORM_UNSUPPORTED",
			`celld publishes linux/amd64 and linux/arm64 only; this host is ${process.platform}/${process.arch}`,
		);
	}
	return { os: "linux", architecture };
}

export function sha256Digest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Refuse anything whose content does not hash to the digest its parent
 * declared. Called before decompression, extraction, and installation — never
 * after, because by then the untrusted bytes have already been acted on.
 */
export function assertDigest(
	bytes: Uint8Array,
	expected: string,
	what: string,
): void {
	if (!expected.startsWith("sha256:")) {
		throw new CelldFetchError(
			"CELLD_DIGEST_UNSUPPORTED",
			`${what} declares digest algorithm ${expected.split(":")[0]}; only sha256 is verified here`,
		);
	}
	const actual = sha256Digest(bytes);
	if (actual !== expected) {
		throw new CelldFetchError(
			"CELLD_DIGEST_MISMATCH",
			`${what} hashes to ${actual} but the pin/manifest declares ${expected}; refusing to use these bytes`,
		);
	}
}

type NetworkFailure = {
	message?: string;
	cause?: { code?: string; message?: string };
};

function describeNetworkFailure(
	url: string,
	error: NetworkFailure,
): CelldFetchError {
	// SAFETY: assertion to `ror as { cause?: { code?: string; message?: string } }) ` is required at this boundary.
	const cause = (error as { cause?: { code?: string; message?: string } })
		?.cause;
	const code = cause?.code ?? "";
	const tlsChainCodes = new Set([
		"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		"UNABLE_TO_GET_ISSUER_CERT",
		"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
		"SELF_SIGNED_CERT_IN_CHAIN",
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"CERT_UNTRUSTED",
		"CERT_HAS_EXPIRED",
		"ERR_TLS_CERT_ALTNAME_INVALID",
	]);
	if (tlsChainCodes.has(code)) {
		return new CelldFetchError(
			"CELLD_TLS_CHAIN_REJECTED",
			[
				`TLS chain for ${url} was rejected (${code}).`,
				"This environment routes HTTPS through an agent proxy; trust its root by pointing",
				"NODE_EXTRA_CA_CERTS at the proxy CA bundle (see /root/.ccr/README.md) and re-run.",
				"Do not disable TLS verification and do not unset HTTPS_PROXY.",
			].join(" "),
		);
	}
	// SAFETY: assertion to `ror as Error)?` is required at this boundary.
	const detail = cause?.message ?? (error as Error)?.message ?? String(error);
	return new CelldFetchError(
		"CELLD_NETWORK_ERROR",
		`request to ${url} failed${code === "" ? "" : ` (${code})`}: ${detail}`,
	);
}

async function registryGet(
	url: string,
	headers: Record<string, string>,
): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { headers });
	} catch (error) {
		throw describeNetworkFailure(url, {
			message: error instanceof Error ? error.message : String(error),
		});
	}
	if (!response.ok) {
		throw new CelldFetchError(
			"CELLD_REGISTRY_STATUS",
			`${url} returned HTTP ${response.status} ${response.statusText}`,
		);
	}
	return response;
}

async function pullToken(host: string, repository: string): Promise<string> {
	const url = `https://${host}/token?scope=${encodeURIComponent(`repository:${repository}:pull`)}&service=${encodeURIComponent(host)}`;
	const response = await registryGet(url, { accept: "application/json" });
	// SAFETY: assertion to `wait response.json()) as { token?: string }; ` is required at this boundary.
	const body = (await response.json()) as { token?: string };
	if (body.token === undefined || body.token === "") {
		throw new CelldFetchError(
			"CELLD_REGISTRY_TOKEN",
			`${url} returned no pull token for ${repository}`,
		);
	}
	return body.token;
}

/** Fetch a manifest or blob by digest and verify it hashes to that digest. */
async function fetchVerified(
	url: string,
	token: string,
	accept: string,
	digest: string,
	what: string,
): Promise<Uint8Array> {
	const response = await registryGet(url, {
		authorization: `Bearer ${token}`,
		accept,
	});
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await response.arrayBuffer());
	} catch (error) {
		throw describeNetworkFailure(url, {
			message: error instanceof Error ? error.message : String(error),
		});
	}
	assertDigest(bytes, digest, what);
	return bytes;
}

function parseJson<T>(bytes: Uint8Array, what: string): T {
	try {
		// SAFETY: assertion to `ON.parse(Buffer.from(bytes).toString("utf8")) as T; ` is required at this boundary.
		return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
	} catch (error) {
		throw new CelldFetchError(
			"CELLD_MANIFEST_MALFORMED",
			// SAFETY: assertion to `ror as Error).` is required at this boundary.
			`${what} is not JSON: ${(error as Error).message}`,
		);
	}
}

/**
 * Select by platform, never positionally: the index also carries attestation
 * manifests that report platform unknown/unknown and contain no binary.
 */
export function selectPlatformManifest(
	index: ImageIndex,
	target: { os: string; architecture: string },
): Descriptor {
	const manifests = index.manifests ?? [];
	const match = manifests.find(
		(entry) =>
			entry.platform?.os === target.os &&
			entry.platform?.architecture === target.architecture &&
			entry.annotations?.["vnd.docker.reference.type"] === undefined,
	);
	if (match === undefined) {
		const seen = manifests
			.map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`)
			.join(", ");
		throw new CelldFetchError(
			"CELLD_PLATFORM_UNSUPPORTED",
			`image index has no manifest for ${target.os}/${target.architecture}; it lists [${seen}]`,
		);
	}
	return match;
}

function cString(header: Uint8Array, offset: number, length: number): string {
	const slice = header.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString(
		"utf8",
	);
}

function readOctal(header: Uint8Array, offset: number, length: number): number {
	const first = header[offset] ?? 0;
	if ((first & 0x80) !== 0) {
		throw new CelldFetchError(
			"CELLD_TAR_UNSUPPORTED",
			"tar header uses base-256 numeric encoding, which this reader does not handle",
		);
	}
	const text = cString(header, offset, length).trim();
	return text === "" ? 0 : Number.parseInt(text, 8);
}

function paxPath(record: Uint8Array): string | undefined {
	const text = Buffer.from(record).toString("utf8");
	for (const line of text.split("\n")) {
		const space = line.indexOf(" ");
		if (space === -1) continue;
		const [key, ...rest] = line.slice(space + 1).split("=");
		if (key === "path") return rest.join("=");
	}
	return undefined;
}

function normalizeTarPath(name: string): string {
	return name.replace(/^\.?\//, "").replace(/\/+$/, "");
}

/**
 * Read one named regular file out of an uncompressed tar. Nothing is written
 * to disk from here, so a hostile member path cannot escape anywhere — only
 * the exact entry the image config named is ever returned.
 */
export function readTarEntry(
	tar: Uint8Array,
	target: string,
): { found?: Uint8Array; whiteout: boolean } {
	const wanted = normalizeTarPath(target);
	const whiteoutName = `${wanted.split("/").slice(0, -1).join("/")}/.wh.${wanted.split("/").at(-1) ?? ""}`;
	let found: Uint8Array | undefined;
	let whiteout = false;
	let pendingLongName: string | undefined;
	let pendingPaxPath: string | undefined;
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = readOctal(header, 124, 12);
		const typeFlag = String.fromCharCode(header[156] ?? 0);
		const data = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;

		if (typeFlag === "L") {
			pendingLongName = normalizeTarPath(
				Buffer.from(data).toString("utf8").replace(/\0+$/, ""),
			);
			continue;
		}
		if (typeFlag === "x" || typeFlag === "X") {
			pendingPaxPath = paxPath(data);
			continue;
		}
		if (typeFlag === "g") continue;

		const prefix = cString(header, 345, 155);
		const raw = cString(header, 0, 100);
		const name = normalizeTarPath(
			pendingLongName ??
				pendingPaxPath ??
				(prefix === "" ? raw : `${prefix}/${raw}`),
		);
		pendingLongName = undefined;
		pendingPaxPath = undefined;

		if (name === whiteoutName) {
			whiteout = true;
			found = undefined;
			continue;
		}
		if (name !== wanted) continue;
		if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "7") {
			throw new CelldFetchError(
				"CELLD_TAR_UNSUPPORTED",
				`${wanted} is tar type '${typeFlag}' (link or special file), not a regular file`,
			);
		}
		found = data;
		whiteout = false;
	}
	return found === undefined ? { whiteout } : { found, whiteout };
}

function decompressLayer(
	descriptor: Descriptor,
	bytes: Uint8Array,
): Uint8Array {
	if (GZIP_LAYER_TYPES.has(descriptor.mediaType)) return gunzipSync(bytes);
	if (PLAIN_LAYER_TYPES.has(descriptor.mediaType)) return bytes;
	throw new CelldFetchError(
		"CELLD_LAYER_MEDIA_TYPE",
		`layer ${descriptor.digest} has media type ${descriptor.mediaType}, which this script cannot extract`,
	);
}

type Sidecar = {
	indexDigest: string;
	platform: string;
	fileSha256: string;
	pinnedRef: string;
	installedAt: string;
};

function sidecarPath(binPath: string): string {
	return `${binPath}.pin.json`;
}

/** Already installed from this exact pin, and still byte-for-byte intact. */
export function installedMatchesPin(binPath: string): boolean {
	const meta = sidecarPath(binPath);
	if (!existsSync(binPath) || !existsSync(meta)) return false;
	let sidecar: Sidecar;
	try {
		// SAFETY: assertion to `.parse(readFileSync(meta, "utf8")) as Sidecar; }` is required at this boundary.
		sidecar = JSON.parse(readFileSync(meta, "utf8")) as Sidecar;
	} catch {
		return false;
	}
	if (sidecar.indexDigest !== CELLD_PIN.indexDigest) return false;
	return sha256Digest(readFileSync(binPath)) === sidecar.fileSha256;
}

export async function fetchCelld(options: {
	binPath: string;
	force: boolean;
}): Promise<{ installed: boolean; binPath: string; reason: string }> {
	const { binPath, force } = options;
	if (!force && installedMatchesPin(binPath)) {
		return {
			installed: false,
			binPath,
			reason: `already installed from ${CELLD_PIN.indexDigest}`,
		};
	}

	const { host, repository } = splitImageReference(CELLD_PIN.image);
	const platform = ociPlatform();
	const token = await pullToken(host, repository);
	const manifestBase = `https://${host}/v2/${repository}/manifests`;
	const blobBase = `https://${host}/v2/${repository}/blobs`;

	const indexBytes = await fetchVerified(
		`${manifestBase}/${CELLD_PIN.indexDigest}`,
		token,
		[...OCI_INDEX_TYPES, ...OCI_MANIFEST_TYPES].join(","),
		CELLD_PIN.indexDigest,
		"image index",
	);
	const index = parseJson<ImageIndex>(indexBytes, "image index");
	const selected = selectPlatformManifest(index, platform);
	console.log(
		`celld: ${platform.os}/${platform.architecture} manifest ${selected.digest}`,
	);

	const manifestBytes = await fetchVerified(
		`${manifestBase}/${selected.digest}`,
		token,
		OCI_MANIFEST_TYPES.join(","),
		selected.digest,
		`platform manifest ${selected.digest}`,
	);
	const manifest = parseJson<ImageManifest>(
		manifestBytes,
		`platform manifest ${selected.digest}`,
	);

	const configDescriptor = manifest.config;
	if (configDescriptor === undefined) {
		throw new CelldFetchError(
			"CELLD_MANIFEST_MALFORMED",
			`platform manifest ${selected.digest} has no config descriptor`,
		);
	}
	const configBytes = await fetchVerified(
		`${blobBase}/${configDescriptor.digest}`,
		token,
		configDescriptor.mediaType,
		configDescriptor.digest,
		`image config ${configDescriptor.digest}`,
	);
	const config = parseJson<ImageConfig>(configBytes, "image config");
	const entrypoint = config.config?.Entrypoint?.[0];
	if (entrypoint === undefined || !entrypoint.endsWith("/celld")) {
		throw new CelldFetchError(
			"CELLD_ENTRYPOINT_UNEXPECTED",
			`image config entrypoint is ${JSON.stringify(config.config?.Entrypoint)}; expected a path ending in /celld`,
		);
	}

	const layers = manifest.layers ?? [];
	let binary: Uint8Array | undefined;
	for (const layer of layers) {
		const blob = await fetchVerified(
			`${blobBase}/${layer.digest}`,
			token,
			layer.mediaType,
			layer.digest,
			`layer ${layer.digest}`,
		);
		console.log(`celld: layer ${layer.digest} verified (${blob.length} bytes)`);
		const entry = readTarEntry(decompressLayer(layer, blob), entrypoint);
		if (entry.found !== undefined) binary = entry.found;
		else if (entry.whiteout) binary = undefined;
	}
	if (binary === undefined) {
		throw new CelldFetchError(
			"CELLD_BINARY_NOT_FOUND",
			`none of the ${layers.length} verified layers of ${selected.digest} contains ${entrypoint}`,
		);
	}

	mkdirSync(dirname(binPath), { recursive: true });
	const staging = `${binPath}.staging-${process.pid}`;
	try {
		writeFileSync(staging, binary);
		chmodSync(staging, 0o755);
		renameSync(staging, binPath);
	} finally {
		rmSync(staging, { force: true });
	}
	const sidecar: Sidecar = {
		indexDigest: CELLD_PIN.indexDigest,
		platform: `${platform.os}/${platform.architecture}`,
		fileSha256: sha256Digest(binary),
		pinnedRef: CELLD_PIN.pinnedRef,
		installedAt: new Date().toISOString(),
	};
	writeFileSync(sidecarPath(binPath), `${JSON.stringify(sidecar, null, 2)}\n`);
	return {
		installed: true,
		binPath,
		reason: `extracted ${entrypoint} (${binary.length} bytes) from ${selected.digest}`,
	};
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const binFlag = argv.indexOf("--bin");
	const binPath =
		binFlag === -1 ? celldBinPath() : (argv[binFlag + 1] ?? celldBinPath());
	const result = await fetchCelld({
		binPath,
		force: argv.includes("--force"),
	});
	console.log(
		`celld: ${result.installed ? "installed" : "up to date"} at ${result.binPath} — ${result.reason}`,
	);
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
	main().catch((error) => {
		console.error(
			error instanceof CelldFetchError ? error.message : String(error),
		);
		process.exitCode = 1;
	});
}
