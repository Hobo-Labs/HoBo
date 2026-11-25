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

export const INFLATE_RATIO = 32;
export const INFLATE_SLACK = 1024 ** 2;

export interface MemberRead {
	readonly size: number;
	readonly archive: string;
}

function unreadable(archive: string, error: Error): PinsError {
	return new PinsError(
		"ARCHIVE_UNREADABLE",
		`${archive} could not be read: ${error.message}`,
	);
}

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

export type WriteSome = (
	fd: number,
	buffer: Uint8Array,
	offset: number,
	length: number,
) => number;

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

export async function memberDigest(
	archive: string,
	member: string,
): Promise<{ readonly archive: string; readonly member: string }> {
	const hash = createHash("sha256");
	const read = await readMember(archive, member, (chunk) => hash.update(chunk));
	return { archive: read.archive, member: hash.digest("hex") };
}

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
