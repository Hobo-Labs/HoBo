/**
 * One member out of a release archive (a gzip-compressed ustar file).
 *
 * What a pin of an archive trusts is the archive's sha256; the executable is
 * the one member the pin names. The archive is read once: every compressed
 * byte is hashed as it streams, and the member it yields is kept only if those
 * bytes hash to the pin. So the bytes used are the bytes verified, not a file
 * that was verified earlier under the same name.
 *
 * Nothing else in the archive is written anywhere, and no name in the archive
 * ever becomes a path: the member's bytes go to the cache path the pin's
 * `entry` names. A name such as `../../.bashrc` or `/etc/passwd` is refused
 * outright. What the reader accepts and refuses, and why, is `pins-tar.ts`;
 * here:
 *
 * - the whole gzip stream is inflated and checked, every member's CRC and
 *   length included, as `gzip -d` checks it under `tar -xzf`: a bad CRC, a
 *   missing trailer, or any byte after the last gzip member (trailing zeros,
 *   which gzip ignores, among them) is ARCHIVE_MALFORMED, however far past
 *   the tar end blocks it is;
 * - the data inflated only to be skipped (other entries' data and padding,
 *   and whatever follows the end blocks) may be at most `INFLATE_RATIO`
 *   times the archive's size plus `INFLATE_SLACK`; past that the archive is
 *   ARCHIVE_UNSUPPORTED, so a small archive cannot make the reader inflate
 *   gigabytes it then throws away. Headers are bounded apart, by the entry
 *   count (`pins-tar.ts`), and the member by its size cap;
 * - a file that cannot be read (absent, a directory, unreadable) is
 *   ARCHIVE_UNREADABLE;
 * - the extracted file is written to a private partial file, made 0755
 *   through its own descriptor and renamed into place only when the archive's
 *   digest matched. The mode is always 0755, whatever the member's header
 *   says: setuid, setgid and sticky bits are dropped, and a 0644 member is
 *   made executable. What the reader is held to against `tar` is the name and
 *   the bytes, not the mode;
 * - on any failure the partial file is removed if it can be, and the
 *   message ends with "nothing was kept", or with where the partial file was
 *   kept when removing it failed;
 * - a failure to create, write, sync or rename that file (no space, an I/O
 *   error, no permission, a write that makes no progress) is
 *   ARCHIVE_WRITE_FAILED, naming the errno and keeping the error as its
 *   `cause`: it says nothing about the archive, so it is never reported as
 *   ARCHIVE_MALFORMED.
 *
 * Erasable TypeScript with node builtins only.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	fchmodSync,
	fsyncSync,
	openSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";

import { PinsError } from "./pins.ts";
import { armGuard, partialPath } from "./pins-partial.ts";
import { TarScan } from "./pins-tar.ts";

export { MAX_MEMBER_BYTES } from "./pins-tar.ts";

/** What may be inflated only to be skipped: this many times the archive's size… */
export const INFLATE_RATIO = 32;
/** …plus this many bytes, for the headers and end blocks of a small archive. */
export const INFLATE_SLACK = 1024 ** 2;

/** What one read of an archive established. */
export interface MemberRead {
	/** The member's size in bytes. */
	readonly size: number;
	/** The sha256 of every compressed byte read. */
	readonly archive: string;
}

function unreadable(archive: string, error: Error): PinsError {
	// A file system error's message names its code: "ENOENT: no such file …".
	return new PinsError(
		"ARCHIVE_UNREADABLE",
		`${archive} could not be read: ${error.message}`,
	);
}

/** Resolves on the first of `events`; never rejects (the inflater's errors are recorded apart). */
function first(
	stream: NodeJS.EventEmitter,
	events: readonly string[],
): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			for (const name of events) stream.off(name, done);
			resolve();
		};
		for (const name of events) stream.once(name, done);
	});
}

/** The archive's size, for the inflate budget; a file that is not there is unreadable. */
async function archiveBytes(archive: string): Promise<number> {
	try {
		return (await stat(archive)).size;
	} catch (error) {
		throw unreadable(
			archive,
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

/**
 * Read `archive` to its end, hashing every byte and inflating all of it, and
 * hand the bytes of `member` to `sink`. Every refusal is a PinsError.
 */
async function readMember(
	archive: string,
	member: string,
	sink: (chunk: Buffer) => void,
): Promise<MemberRead> {
	const budget = INFLATE_RATIO * (await archiveBytes(archive)) + INFLATE_SLACK;
	const hash = createHash("sha256");
	const scan = new TarScan(archive, member, sink);
	const gunzip = createGunzip();
	let refusal: PinsError | undefined;
	let inflateError: Error | undefined;
	let inflated = 0;
	let read = 0;
	gunzip.on("data", (chunk: Buffer) => {
		if (refusal !== undefined) return;
		inflated += chunk.length;
		try {
			// Past the end blocks the scan reads nothing; the stream is still checked.
			scan.push(chunk);
			if (scan.skipped + (inflated - scan.consumed) > budget) {
				throw new PinsError(
					"ARCHIVE_UNSUPPORTED",
					`${archive} inflates more than ${budget} bytes that are not ${member} or a header (${INFLATE_RATIO} times its size, plus ${INFLATE_SLACK}); refusing to inflate the rest`,
				);
			}
		} catch (error) {
			refusal =
				error instanceof PinsError
					? error
					: new PinsError("ARCHIVE_MALFORMED", `${archive}: ${String(error)}`);
			gunzip.destroy();
		}
	});
	gunzip.on("error", (error) => {
		inflateError = error;
	});
	const closed = first(gunzip, ["close"]);
	try {
		for await (const chunk of createReadStream(archive)) {
			hash.update(chunk);
			read += chunk.length;
			if (gunzip.destroyed) continue;
			if (!gunzip.write(chunk)) {
				await first(gunzip, ["drain", "close"]);
			}
		}
	} catch (error) {
		gunzip.destroy();
		throw error instanceof PinsError
			? error
			: unreadable(
					archive,
					error instanceof Error ? error : new Error(String(error)),
				);
	}
	if (!gunzip.destroyed) gunzip.end();
	await closed;
	if (refusal !== undefined) throw refusal;
	if (inflateError !== undefined) {
		throw new PinsError(
			"ARCHIVE_MALFORMED",
			`${archive} could not be read as gzip: ${inflateError.message}`,
		);
	}
	if (gunzip.bytesWritten !== read) {
		throw new PinsError(
			"ARCHIVE_MALFORMED",
			`${archive} has ${read - gunzip.bytesWritten} bytes after the end of its gzip stream, which gzip either ignores (zeros) or fails on; refusing it`,
		);
	}
	return { size: scan.finish(), archive: hash.digest("hex") };
}

/** How `writeAll` writes: `writeSync`'s shape, returning the bytes it wrote. */
export type WriteSome = (
	fd: number,
	buffer: Uint8Array,
	offset: number,
	length: number,
) => number;

/**
 * Write every byte of `chunk` to `fd`. One `writeSync` may write fewer bytes
 * than it was given; the rest are written until none is left, and a write
 * that makes no progress is an error rather than a loop.
 */
export function writeAll(
	fd: number,
	chunk: Uint8Array,
	write: WriteSome = writeSync,
): void {
	let offset = 0;
	while (offset < chunk.length) {
		const written = write(fd, chunk, offset, chunk.length - offset);
		if (written <= 0) {
			throw new PinsError(
				"ARCHIVE_WRITE_FAILED",
				`a write to the partial file wrote ${written} of ${chunk.length - offset} bytes`,
			);
		}
		offset += written;
	}
}

/**
 * Run `act`, the step named `step`: a file system error becomes
 * ARCHIVE_WRITE_FAILED, its message node's own (the errno first, then the
 * path for a call that takes one), and a PinsError passes through. `step`
 * names a path only where node's message does not.
 */
function writing<T>(step: string, act: () => T): T {
	try {
		return act();
	} catch (error) {
		if (error instanceof PinsError) throw error;
		const errno =
			error instanceof Error && "code" in error ? String(error.code) : "";
		const detail = error instanceof Error ? error.message : String(error);
		throw new PinsError(
			"ARCHIVE_WRITE_FAILED",
			`${step} failed: ${errno === "" || detail.startsWith(`${errno}:`) ? detail : `${errno}: ${detail}`}`,
			{ cause: error },
		);
	}
}

/** The sha256 of `archive` and of `member` inside it, from one read, writing nothing. */
export async function memberDigest(
	archive: string,
	member: string,
): Promise<{ readonly archive: string; readonly member: string }> {
	const hash = createHash("sha256");
	const read = await readMember(archive, member, (chunk) => hash.update(chunk));
	return { archive: read.archive, member: hash.digest("hex") };
}

/**
 * Write `member` of `archive` to `dest`, mode 0755, if the archive's bytes
 * hash to `sha256`. The bytes go to a private partial file first and are
 * renamed into place only once all of them are there and the digest matched;
 * any failure leaves nothing at `dest`.
 */
export async function extractMember(
	archive: string,
	member: string,
	dest: string,
	sha256: string,
): Promise<void> {
	const partial = partialPath(dest);
	const guard = armGuard(partial, () => undefined);
	let fd: number | undefined;
	try {
		// O_CREAT | O_EXCL: never an existing file, never through a link.
		fd = writing("creating the partial file", () =>
			openSync(partial, "wx", 0o600),
		);
		const out = fd;
		const read = await readMember(archive, member, (chunk) => {
			writing(`writing ${member} to ${partial}`, () => writeAll(out, chunk));
		});
		if (read.archive !== sha256) {
			throw new PinsError(
				"DIGEST_MISMATCH",
				`${archive} hashed to ${read.archive} while ${member} was read from it, but the pin says ${sha256}`,
			);
		}
		writing(`syncing ${partial}`, () => {
			fsyncSync(out);
			fchmodSync(out, 0o755);
		});
		fd = undefined;
		writing(`closing ${partial}`, () => closeSync(out));
		// A signal is handled only between turns of the event loop, and nothing
		// from the last await to the rename yields, so a signal seen by now is
		// the last one that can stop this unpack: after it, nothing is renamed
		// into place, even when the guard could not remove the partial file.
		const signal = guard.interrupted();
		if (signal !== null) {
			throw new PinsError(
				"INTERRUPTED",
				`unpacking ${member} was interrupted by ${signal}`,
			);
		}
		writing("renaming the partial file into place", () =>
			renameSync(partial, dest),
		);
	} catch (error) {
		// Every error thrown above is a PinsError; a failure while cleaning up
		// is recorded beside it, never in its place, and the partial file is
		// removed whether or not closing it worked. The message ends by saying
		// whether anything was left behind, and where.
		let failure = error;
		let kept = false;
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (closeError) {
				if (failure instanceof PinsError && closeError instanceof Error) {
					failure = failure.withSuppressed(`closing ${partial}`, closeError);
				}
			}
		}
		try {
			rmSync(partial, { force: true });
		} catch (rmError) {
			kept = true;
			if (failure instanceof PinsError && rmError instanceof Error) {
				failure = failure.withSuppressed(`removing ${partial}`, rmError);
			}
		}
		const outcome = kept
			? `the partial file was kept at ${partial}`
			: "nothing was kept";
		const signal = guard.interrupted();
		const interrupted =
			failure instanceof PinsError && failure.code === "INTERRUPTED";
		if (signal !== null && !interrupted) {
			throw new PinsError(
				"INTERRUPTED",
				`unpacking ${member} was interrupted by ${signal}; ${outcome}`,
				{
					cause: failure,
					suppressed: failure instanceof PinsError ? failure.suppressed : [],
				},
			);
		}
		throw failure instanceof PinsError ? failure.withNote(outcome) : failure;
	} finally {
		guard.release();
	}
}
