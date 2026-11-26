/**
 * Gzip-compressed ustar archives built in memory, so the archive tests can
 * make the hostile ones (a link where the binary should be, a pax header, a
 * member twice, a bad checksum) that no well-behaved `tar` writes.
 */
import { gzipSync } from "node:zlib";

export interface TarEntry {
	readonly name: string;
	readonly body?: Uint8Array | string;
	/** ustar type flag: "0" file (default), "\0" old file, "2" symlink, "5" directory, "x" pax. */
	readonly type?: string;
	readonly linkname?: string;
	/** Corrupt the header checksum. */
	readonly badChecksum?: boolean;
	/** The size the header claims, when it is not the body's length (no data follows then). */
	readonly claimedSize?: number;
	/**
	 * The eight bytes at offset 257, magic then version: POSIX ustar's
	 * `ustar\0` `00` unless given, GNU's `ustar  \0`, or `""` for a v7 header.
	 */
	readonly magic?: string;
	/** The ustar prefix field (offset 345), written as given; `name` is then not split. */
	readonly prefix?: string;
	/** Header bytes written over the usual ones, as `[offset, latin1 text]`, before the checksum is summed. */
	readonly raw?: readonly (readonly [number, string])[];
	/** The checksum field's eight bytes for a header whose sum is `sum` (default: six octal digits, NUL, space). */
	readonly checksum?: (sum: number) => string;
}

function put(block: Buffer, text: string, at: number, length: number): void {
	block.write(text.slice(0, length), at, length, "latin1");
}

function octalField(value: number, length: number): string {
	return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(entry: TarEntry, size: number): Buffer {
	const block = Buffer.alloc(512);
	const name = entry.name;
	if (entry.prefix !== undefined) {
		put(block, name, 0, 100);
		put(block, entry.prefix, 345, 155);
	} else if (name.length > 100) {
		const cut = name.lastIndexOf("/", 155);
		put(block, name.slice(cut + 1), 0, 100);
		put(block, name.slice(0, cut), 345, 155);
	} else {
		put(block, name, 0, 100);
	}
	const type = entry.type ?? "0";
	put(block, octalField(type === "5" ? 0o755 : 0o755, 8), 100, 8);
	put(block, octalField(0, 8), 108, 8);
	put(block, octalField(0, 8), 116, 8);
	put(block, octalField(size, 12), 124, 12);
	put(block, octalField(0, 12), 136, 12);
	put(block, "        ", 148, 8);
	put(block, type, 156, 1);
	put(block, entry.linkname ?? "", 157, 100);
	put(block, entry.magic ?? "ustar\u000000", 257, 8);
	for (const [at, text] of entry.raw ?? []) put(block, text, at, text.length);
	put(block, "        ", 148, 8);
	let sum = 0;
	for (const byte of block) sum += byte;
	if (entry.badChecksum === true) sum += 1;
	const checksum =
		entry.checksum?.(sum) ?? `${sum.toString(8).padStart(6, "0")}\0 `;
	put(block, checksum, 148, 8);
	return block;
}

/** The uncompressed ustar stream of `entries`: each header, then its data, padded. */
export function tarStream(entries: readonly TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const body =
			entry.body === undefined ? Buffer.alloc(0) : Buffer.from(entry.body);
		parts.push(header(entry, entry.claimedSize ?? body.length));
		if (entry.claimedSize === undefined && body.length > 0) {
			parts.push(body);
			parts.push(Buffer.alloc((512 - (body.length % 512)) % 512));
		}
	}
	return Buffer.concat(parts);
}

/**
 * The archive bytes: entries in order (an entry with a body carries that data,
 * whatever its type), two zero blocks, then `after` (entries past the end, which
 * `tar` never reads), gzip with no name or time.
 */
export function tarGz(
	entries: readonly TarEntry[],
	after: readonly TarEntry[] = [],
): Buffer {
	const parts: Buffer[] = [tarStream(entries)];
	parts.push(Buffer.alloc(1024));
	if (after.length > 0) parts.push(tarStream(after));
	return gzipSync(Buffer.concat(parts));
}

/** A pax extended header body that renames the next entry. */
export function paxPath(path: string): string {
	const record = ` path=${path}\n`;
	let length = record.length + 2;
	while (`${length}${record}`.length !== length) length += 1;
	return `${length}${record}`;
}
