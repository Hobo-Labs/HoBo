/**
 * The static-site tree Freight, parsed once and hashed as git would.
 *
 * A Pages Freight is two kinds of blob in the artifact store: one **tree
 * index** (the Freight's `artifactDigest`) and one blob per file it lists.
 * The index is a small JSON document:
 *
 * ```json
 * { "contract": "hobo.static-site-tree/v1",
 *   "files": [ { "path": "index.html", "digest": "sha256:…", "size": 512 } ] }
 * ```
 *
 * Parse, don't validate: `parseStaticSiteTree` checks the index against its
 * own digest, refuses any path that could escape the tree or touch `.git`, and
 * hands back a `StaticSiteTree`. `loadSiteContent` then reads every file blob,
 * checks it against its digest and size, and computes the git object ids —
 * blob ids and the tree id — locally. That local tree id is what makes the
 * realizer idempotent by digest: the desired state is known *before* anything
 * is uploaded, and convergence is the observed published tree id being equal
 * to it, byte for byte, with no clock and no guesswork.
 */
import { createHash } from "node:crypto";
import { reject } from "./errors.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

// public-contract: the tree-index document contract a Pages Freight carries.
export const STATIC_SITE_TREE_CONTRACT = "hobo.static-site-tree/v1";
// public-contract: Pages refuses sites over 1 GB; the tree is bounded below it.
export const STATIC_SITE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
// public-contract: the Git Data API blob endpoint accepts at most 100 MB.
export const STATIC_SITE_MAX_FILE_BYTES = 100 * 1024 * 1024;
// public-contract: more files than this is not a static site a reconcile should push.
export const STATIC_SITE_MAX_FILES = 20_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
// A path segment: no separators, no control characters, not `.`/`..`.
const SEGMENT = /^[^\p{Cc}/\\]{1,255}$/u;

// domain-view: parse-time derived file entry; `executable` is resolved (never absent) and the path is checked.
export interface StaticSiteFile {
	readonly path: string;
	readonly digest: string;
	readonly size: number;
	readonly executable: boolean;
}

// domain-view: parse-time derived type of the Freight tree index.
export interface StaticSiteTree {
	readonly digest: string;
	/** Sorted by path (code unit order), unique. */
	readonly files: readonly StaticSiteFile[];
	readonly totalBytes: number;
}

export interface SiteBlob {
	readonly path: string;
	readonly mode: "100644" | "100755";
	/** Git blob object id (sha1 hex). */
	readonly sha: string;
	readonly bytes: Uint8Array;
}

// domain-view: the Freight content with its git object ids computed locally.
export interface SiteContent {
	readonly tree: StaticSiteTree;
	readonly blobs: readonly SiteBlob[];
	/** Git tree object id of the whole site, computed locally. */
	readonly treeSha: string;
}

export function sha256Of(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Git object id of `bytes` as a blob: sha1("blob <size>\0" + bytes). */
export function gitBlobSha(bytes: Uint8Array): string {
	return createHash("sha1")
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");
}

export function parseSha256Digest(
	value: JsonValue | undefined,
	what: string,
): string {
	if (!isJsonString(value) || !SHA256.test(value))
		reject(`GitHub Pages desired.${what} must be a sha256:<64 hex> digest`);
	return value;
}

/** Parse the tree index; `digest` is the Freight digest it was fetched under. */
export function parseStaticSiteTree(
	bytes: Uint8Array,
	digest: string,
): StaticSiteTree {
	if (bytes.byteLength > MAX_INDEX_BYTES)
		reject(`static-site tree index ${digest} exceeds ${MAX_INDEX_BYTES} bytes`);
	if (sha256Of(bytes) !== digest)
		reject(
			`artifact store returned a tree index that does not hash to ${digest}`,
			"re-put the build output into the artifact store and re-record the Freight",
		);
	let doc: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this artifact boundary.
		doc = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as JsonValue;
	} catch {
		return reject(`static-site tree index ${digest} is not UTF-8 JSON`);
	}
	if (!isJsonObject(doc) || doc.contract !== STATIC_SITE_TREE_CONTRACT)
		reject(
			`static-site tree index ${digest} is not a ${STATIC_SITE_TREE_CONTRACT} document`,
		);
	const raw = doc.files;
	if (
		!isJsonArray(raw) ||
		raw.length === 0 ||
		raw.length > STATIC_SITE_MAX_FILES
	)
		reject(`static-site tree index must list 1-${STATIC_SITE_MAX_FILES} files`);
	const files: StaticSiteFile[] = raw.map((entry, index) =>
		parseFile(entry, index),
	);
	files.sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	const seen = new Set<string>();
	for (const file of files) {
		if (seen.has(file.path))
			reject(`static-site tree lists ${JSON.stringify(file.path)} twice`);
		seen.add(file.path);
	}
	// A path that is both a file and a directory cannot be a git tree.
	for (const file of files) {
		const segments = file.path.split("/");
		for (let depth = 1; depth < segments.length; depth += 1) {
			const parent = segments.slice(0, depth).join("/");
			if (seen.has(parent))
				reject(
					`static-site tree lists ${JSON.stringify(parent)} as both a file and a directory`,
				);
		}
	}
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	if (totalBytes > STATIC_SITE_MAX_TOTAL_BYTES)
		reject(
			`static-site tree is ${totalBytes} bytes; GitHub Pages publishes at most ${STATIC_SITE_MAX_TOTAL_BYTES}`,
		);
	return Object.freeze({ digest, files: Object.freeze(files), totalBytes });
}

function parseFile(entry: JsonValue, index: number): StaticSiteFile {
	if (!isJsonObject(entry))
		return reject(`static-site tree files[${index}] is not an object`);
	const path = entry.path;
	if (!isJsonString(path) || path.length > 1024)
		reject(
			`static-site tree files[${index}].path must be a string of at most 1024 characters`,
		);
	for (const segment of path.split("/"))
		if (
			!SEGMENT.test(segment) ||
			segment === "." ||
			segment === ".." ||
			segment.toLowerCase() === ".git"
		)
			reject(
				`static-site tree path ${JSON.stringify(path)} must be relative, with no empty, ".", "..", ".git" or control-character segment`,
			);
	const digest = entry.digest;
	if (!isJsonString(digest) || !SHA256.test(digest))
		reject(
			`static-site tree files[${index}].digest must be a sha256:<64 hex> digest`,
		);
	const size = entry.size;
	if (
		!isJsonNumber(size) ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		size > STATIC_SITE_MAX_FILE_BYTES
	)
		reject(
			`static-site tree files[${index}].size must be an integer 0-${STATIC_SITE_MAX_FILE_BYTES}`,
		);
	const executable = entry.executable ?? false;
	if (!isJsonBoolean(executable))
		reject(`static-site tree files[${index}].executable must be a boolean`);
	return Object.freeze({ path, digest, size, executable });
}

/** Read every file blob, check it, and compute the git object ids. */
export async function loadSiteContent(
	tree: StaticSiteTree,
	read: (digest: string) => Promise<Uint8Array | undefined>,
): Promise<SiteContent> {
	const blobs: SiteBlob[] = [];
	for (const file of tree.files) {
		const bytes = await read(file.digest);
		if (bytes === undefined)
			reject(
				`site file ${JSON.stringify(file.path)} (${file.digest}) is not in the artifact store`,
				"re-put the build output into the artifact store and re-record the Freight",
			);
		if (bytes.byteLength !== file.size || sha256Of(bytes) !== file.digest)
			reject(
				`artifact store returned bytes for ${JSON.stringify(file.path)} that do not match ${file.digest}`,
				"re-put the build output into the artifact store and re-record the Freight",
			);
		blobs.push(
			Object.freeze({
				path: file.path,
				mode: file.executable ? "100755" : "100644",
				sha: gitBlobSha(bytes),
				bytes,
			}),
		);
	}
	return Object.freeze({
		tree,
		blobs: Object.freeze(blobs),
		treeSha: gitTreeSha(blobs),
	});
}

interface Directory {
	readonly files: Map<string, { mode: string; sha: string }>;
	readonly dirs: Map<string, Directory>;
}

/** Git tree object id of a set of blobs, built bottom-up exactly as git does. */
export function gitTreeSha(
	blobs: readonly {
		readonly path: string;
		readonly mode: string;
		readonly sha: string;
	}[],
): string {
	const root: Directory = { files: new Map(), dirs: new Map() };
	for (const blob of blobs) {
		const segments = blob.path.split("/");
		let node = root;
		for (const segment of segments.slice(0, -1)) {
			let next = node.dirs.get(segment);
			if (next === undefined) {
				next = { files: new Map(), dirs: new Map() };
				node.dirs.set(segment, next);
			}
			node = next;
		}
		node.files.set(segments[segments.length - 1] ?? "", {
			mode: blob.mode,
			sha: blob.sha,
		});
	}
	return hashDirectory(root);
}

function hashDirectory(directory: Directory): string {
	const entries: { key: Buffer; mode: string; name: string; sha: string }[] =
		[];
	for (const [name, file] of directory.files)
		entries.push({
			key: Buffer.from(name),
			mode: file.mode,
			name,
			sha: file.sha,
		});
	// git sorts a tree entry as if its name ended in "/".
	for (const [name, child] of directory.dirs)
		entries.push({
			key: Buffer.from(`${name}/`),
			mode: "40000",
			name,
			sha: hashDirectory(child),
		});
	entries.sort((left, right) => Buffer.compare(left.key, right.key));
	const body = Buffer.concat(
		entries.map((entry) =>
			Buffer.concat([
				Buffer.from(`${entry.mode} ${entry.name}\0`),
				Buffer.from(entry.sha, "hex"),
			]),
		),
	);
	return createHash("sha1")
		.update(`tree ${body.byteLength}\0`)
		.update(body)
		.digest("hex");
}
