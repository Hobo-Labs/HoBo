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

export const STATIC_SITE_TREE_CONTRACT = "hobo.static-site-tree/v1";
export const STATIC_SITE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const STATIC_SITE_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const STATIC_SITE_MAX_FILES = 20_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
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
	readonly pagesArtifactDigest: string | null;
	readonly files: readonly StaticSiteFile[];
	readonly totalBytes: number;
}

// domain-view: one checked file of the Freight; its bytes stay in the artifact store.
export interface SiteBlob {
	readonly path: string;
	readonly mode: "100644" | "100755";
	readonly sha: string;
	readonly digest: string;
	readonly size: number;
}

// domain-view: the Freight content with its git object ids computed locally.
export interface SiteContent {
	readonly tree: StaticSiteTree;
	readonly blobs: readonly SiteBlob[];
	readonly treeSha: string;
}

export function sha256Of(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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
	const pagesArtifactDigest =
		doc.pagesArtifactDigest === undefined
			? null
			: parseSha256Digest(doc.pagesArtifactDigest, "pagesArtifactDigest");
	return Object.freeze({
		digest,
		pagesArtifactDigest,
		files: Object.freeze(files),
		totalBytes,
	});
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

type BlobReader = (digest: string) => Promise<Uint8Array | undefined>;

async function readChecked(
	file: {
		readonly path: string;
		readonly digest: string;
		readonly size: number;
	},
	read: BlobReader,
): Promise<Uint8Array> {
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
	return bytes;
}

export async function loadSiteContent(
	tree: StaticSiteTree,
	read: BlobReader,
): Promise<SiteContent> {
	const blobs: SiteBlob[] = [];
	for (const file of tree.files) {
		const bytes = await readChecked(file, read);
		blobs.push(
			Object.freeze({
				path: file.path,
				mode: file.executable ? "100755" : "100644",
				sha: gitBlobSha(bytes),
				digest: file.digest,
				size: file.size,
			}),
		);
	}
	return Object.freeze({
		tree,
		blobs: Object.freeze(blobs),
		treeSha: gitTreeSha(blobs),
	});
}

export async function readSiteBlob(
	blob: SiteBlob,
	read: BlobReader,
): Promise<Uint8Array> {
	const bytes = await readChecked(blob, read);
	if (gitBlobSha(bytes) !== blob.sha)
		reject(
			`artifact store bytes for ${JSON.stringify(blob.path)} no longer hash to git blob ${blob.sha}`,
		);
	return bytes;
}

interface Directory {
	readonly files: Map<string, { mode: string; sha: string }>;
	readonly dirs: Map<string, Directory>;
}

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
