/**
 * The Freight tarball, parsed: bytes proven to hash to the Freight digest, the
 * npm integrity values the registry will be compared against, and the
 * `package.json` read out of the tarball itself.
 *
 * The manifest comes from the tarball, never from desired state, so the
 * published version document cannot disagree with the bytes it ships: a plan
 * that names `1.2.3` for a tarball whose `package.json` says `1.2.4` is
 * refused before any request leaves the process.
 *
 * Only what npm needs is implemented: gzip, ustar headers, the PAX `path`
 * extension `node-tar` writes for long names, and the top-level
 * `package.json`. Everything is bounded.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { reject } from "./errors.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

/** Largest tarball the realizer will publish; it travels base64 in a string body. */
export const NPM_MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

// domain-view: parse-time derived tarball; only built by parseNpmTarball.
export interface NpmTarball {
	readonly bytes: Uint8Array;
	/** The Freight digest the bytes were proven to match. */
	readonly digest: string;
	/** `sha512-<base64>`, what npm writes as `dist.integrity`. */
	readonly integrity: string;
	readonly sha512Hex: string;
	/** Hex sha1, what npm writes as `dist.shasum`. */
	readonly shasum: string;
	readonly manifest: JsonObject;
}

export function parseSha256Digest(
	value: JsonValue | undefined,
	field: string,
): string {
	if (!isJsonString(value) || !SHA256_DIGEST.test(value))
		reject(`npm desired.${field} must be sha256:<64 lowercase hex>`);
	return value;
}

export function sha256Of(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Prove `bytes` are the Freight artifact, then read what npm needs out of them. */
export function parseNpmTarball(bytes: Uint8Array, digest: string): NpmTarball {
	if (bytes.byteLength > NPM_MAX_TARBALL_BYTES)
		reject(
			`npm tarball is ${bytes.byteLength} bytes, past the ${NPM_MAX_TARBALL_BYTES}-byte publish bound`,
		);
	if (sha256Of(bytes) !== digest)
		reject(
			"artifact store returned bytes that do not hash to the Freight digest",
			"repair the blob in the artifact store (re-put the build output); nothing was published",
		);
	const sha512 = createHash("sha512").update(bytes);
	const sha512Bytes = sha512.digest();
	return Object.freeze({
		bytes,
		digest,
		integrity: `sha512-${sha512Bytes.toString("base64")}`,
		sha512Hex: sha512Bytes.toString("hex"),
		shasum: createHash("sha1").update(bytes).digest("hex"),
		manifest: readManifest(bytes),
	});
}

function readManifest(gzipped: Uint8Array): JsonObject {
	let tar: Buffer;
	try {
		tar = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES });
	} catch {
		return reject(
			"npm tarball is not a gzip stream",
			"publish the output of `npm pack`",
		);
	}
	let offset = 0;
	let paxPath: string | undefined;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const sizeField = header.subarray(124, 136);
		if (((sizeField[0] ?? 0) & 0x80) !== 0)
			reject("npm tarball uses a base-256 size field, which npm never writes");
		const size = Number.parseInt(text(sizeField).trim() || "0", 8);
		if (!Number.isSafeInteger(size) || size < 0)
			reject("npm tarball has a malformed entry size");
		const type = String.fromCharCode(header[156] ?? 0);
		const name = text(header.subarray(0, 100));
		const prefix = text(header.subarray(257, 263)).startsWith("ustar")
			? text(header.subarray(345, 500))
			: "";
		const path = paxPath ?? (prefix ? `${prefix}/${name}` : name);
		paxPath = undefined;
		const start = offset + 512;
		if (start + size > tar.length) reject("npm tarball is truncated");
		const data = tar.subarray(start, start + size);
		if (type === "x") paxPath = paxRecord(data, "path");
		else if (
			(type === "0" || type === "\0") &&
			/^[^/]+\/package\.json$/u.test(path)
		)
			return parseManifest(data);
		offset = start + Math.ceil(size / 512) * 512;
	}
	return reject(
		"npm tarball has no top-level package.json",
		"publish the output of `npm pack`",
	);
}

function parseManifest(data: Uint8Array): JsonObject {
	if (data.byteLength > MAX_MANIFEST_BYTES)
		reject("npm tarball package.json exceeds 1 MiB");
	let value: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this tarball boundary.
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(data),
		) as JsonValue;
	} catch {
		return reject("npm tarball package.json is not UTF-8 JSON");
	}
	if (
		!isJsonObject(value) ||
		!isJsonString(value.name) ||
		!isJsonString(value.version)
	)
		reject("npm tarball package.json has no name and version");
	return value;
}

function text(field: Uint8Array): string {
	const end = field.indexOf(0);
	return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString(
		"utf8",
	);
}

/** PAX records are `<len> <key>=<value>\n`; only `path` is consulted. */
function paxRecord(data: Uint8Array, key: string): string | undefined {
	let found: string | undefined;
	for (const line of Buffer.from(data).toString("utf8").split("\n")) {
		const match = /^\d+ ([^=]+)=(.*)$/u.exec(line);
		if (match?.[1] === key) found = match[2];
	}
	return found;
}

const SRI_ALGORITHMS = new Map([
	["sha512", "sha512"],
	["sha384", "sha384"],
	["sha256", "sha256"],
]);

/**
 * Compare a registry `dist.integrity` (Subresource Integrity, possibly several
 * space-separated hashes) with the bytes. `incomparable` means the registry
 * named no sha256/384/512 hash, so nothing strong can be concluded.
 */
export function compareIntegrity(
	integrity: string,
	bytes: Uint8Array,
): "match" | "mismatch" | "incomparable" {
	let compared = false;
	for (const token of integrity.trim().split(/\s+/u)) {
		const dash = token.indexOf("-");
		const algorithm = SRI_ALGORITHMS.get(token.slice(0, dash));
		if (dash <= 0 || algorithm === undefined) continue;
		const expected = token.slice(dash + 1).split("?")[0];
		const actual = createHash(algorithm).update(bytes).digest("base64");
		if (expected !== actual) return "mismatch";
		compared = true;
	}
	return compared ? "match" : "incomparable";
}
