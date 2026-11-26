/**
 * What the content-addressed cache holds for a pinned file, re-hashed every
 * time it is asked about: never trusted by its name, and never read unless it
 * is a regular file. For an archive pin, the archive is checked against the
 * pin and the unpacked entry against the member the verified archive holds.
 *
 * Erasable TypeScript with node builtins only.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

import { type AssetFile, PinsError } from "./pins.ts";
import { memberDigest } from "./pins-archive.ts";
import { cachedArchivePath, cachedPath } from "./pins-assets.ts";

export async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export type CacheState =
	| { readonly state: "absent" }
	| { readonly state: "ok" }
	/** `path` is the file that failed: the archive, for an archive pin. */
	| {
			readonly state: "mismatch";
			readonly actual: string;
			readonly path: string;
	  }
	/** Something is there that is not a regular file: a link, a directory, a device. */
	| {
			readonly state: "invalid";
			readonly reason: string;
			readonly path: string;
	  }
	/** An archive pin's entry is not the member of the verified archive it was unpacked from. */
	| { readonly state: "stale"; readonly reason: string }
	/** The archive is the pinned one, but it cannot supply the member (missing, unsafe, unreadable as ustar). */
	| {
			readonly state: "unusable";
			readonly reason: string;
			readonly path: string;
	  };

function describeKind(info: Awaited<ReturnType<typeof lstat>>): string {
	if (info.isSymbolicLink()) return "a symbolic link";
	if (info.isDirectory()) return "a directory";
	return "not a regular file";
}

/** What a pinned archive that reads can still fail with, per asset, not for the whole status. */
const UNUSABLE = new Set([
	"ARCHIVE_MALFORMED",
	"ARCHIVE_UNSUPPORTED",
	"ARCHIVE_MEMBER_MISSING",
	"ARCHIVE_UNSAFE",
	"SIZE_EXCEEDED",
]);

/** `null` for a regular file, else the state that says what is there instead. */
async function regularFile(path: string): Promise<CacheState | null> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { state: "absent" };
		throw error;
	}
	return info.isFile()
		? null
		: { state: "invalid", reason: describeKind(info), path };
}

/** The state of one cached file against the digest it must have. */
export async function verifyFile(
	path: string,
	sha256: string,
): Promise<CacheState> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { state: "absent" };
		throw error;
	}
	if (!info.isFile())
		return { state: "invalid", reason: describeKind(info), path };
	const actual = await sha256OfFile(path);
	return actual === sha256
		? { state: "ok" }
		: { state: "mismatch", actual, path };
}

/**
 * Re-hash what the cache holds for `file`; never trusts a file by its name,
 * and never reads anything but a regular file (a link to a correct file, or to
 * /dev/zero, is not a verified file). For an archive pin, the archive is
 * re-hashed against the pin and the entry against the member it holds.
 */
export async function verifyCached(
	cache: string,
	file: AssetFile,
): Promise<CacheState> {
	const path = cachedPath(cache, file);
	if (file.archive === undefined) return await verifyFile(path, file.sha256);
	const archivePath = cachedArchivePath(cache, file);
	const kind = await regularFile(archivePath);
	if (kind !== null) return kind;
	// One read gives both digests: the archive's, against the pin, and the
	// member's, against the entry.
	let digests: { readonly archive: string; readonly member: string };
	try {
		digests = await memberDigest(archivePath, file.archive.member);
	} catch (error) {
		if (!(error instanceof PinsError) || !UNUSABLE.has(error.code)) throw error;
		const actual = await sha256OfFile(archivePath);
		return actual === file.sha256
			? { state: "unusable", reason: error.message, path: archivePath }
			: { state: "mismatch", actual, path: archivePath };
	}
	if (digests.archive !== file.sha256) {
		return { state: "mismatch", actual: digests.archive, path: archivePath };
	}
	const entry = await verifyFile(path, digests.member);
	if (entry.state === "mismatch") {
		return {
			state: "stale",
			reason: `${path} is not ${file.archive.member} from the verified archive`,
		};
	}
	return entry;
}
