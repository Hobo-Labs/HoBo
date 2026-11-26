/**
 * The ustar reading behind `pins-archive.ts`: one header at a time, and the
 * scan that finds the one member a pin names. Pure: no file, no stream, no
 * gzip. Every refusal is a PinsError, thrown as soon as it is known.
 *
 * What it reads, and only that: POSIX ustar headers (magic `ustar\0`), whose
 * type is a regular file (`0`, or the old `\0`) or one of the data-less types
 * `3`–`6` (character device, block device, directory, FIFO). Any other type is
 * refused, because its data is that entry's own contents to `tar` (a `7`
 * contiguous file, a GNU `D` dumpdir or `S` sparse file), or it renames the
 * entry after it (pax `x`/`g`, GNU `L`/`K`): a reader that skipped such data,
 * or parsed it as headers, would find members `tar` never extracts. A
 * data-less type that claims data is refused for the same reason.
 *
 * A link (`1` hard, `2` symbolic) is refused wherever it is. `d -> .` makes
 * `d/mirror` overwrite `mirror`, `bin -> real` makes `real/mirror` overwrite
 * `bin/mirror`, and a hard link gives the member a second name; refusing
 * every link closes all of them, and mirror's archives hold none.
 *
 * The member's path must be a file in a tree of directories: an entry under
 * the member (`mirror/x`, a directory `mirror/sub/`) makes `tar` turn the
 * member into a directory, and anything but a directory at one of its parents
 * (a file or FIFO `bin` beside `bin/mirror`) cannot be extracted with it:
 * `tar` fails on one of the two. Both are refused. Directories elsewhere, and
 * above the member, are read.
 *
 * No two entries may be one name to a case-insensitive, normalisation-
 * insensitive file system, the default on macOS and Windows: `mirror` and
 * `MIRROR`, `bin/mirror` and `BIN/mirror`, `café` spelled in NFC and in NFD,
 * or one name twice. There `tar` writes both to one file and the second
 * wins. Each name has two keys, and two names that share either are one
 * file: `foldName` (NFD and full case folding, as Linux casefold directories
 * compare) and `upcaseName` (simple uppercase of each code point, with no
 * normalisation, as NTFS compares). The two rules above compare both keys
 * too, so `MIRROR/x` beside `mirror` is refused. Every name is kept for the
 * comparison, so an archive of more than `MAX_ENTRIES` entries is refused.
 *
 * A GNU header (`ustar  \0`) is refused, and so is any other magic. Where
 * POSIX keeps a name prefix (bytes 345 to 500), a GNU header keeps times and
 * sparse-file data, and `tar` never reads a name there; mirror's archives are
 * made with `tar --format=ustar`, so they never carry one.
 *
 * A name is read in the one spelling `tar` extracts as written and also finds
 * when asked for it by name (`tar -xzf A mirror`), and compared byte for byte
 * with the member. So an entry is refused when its name, prefix included:
 *
 * - starts with `/`: `tar` strips the `/` and extracts it beside the rest,
 *   where `/mirror` overwrites `mirror`;
 * - has a `..` segment: `tar` will not extract it;
 * - has a `.` or empty segment (`./mirror`, `bin//mirror`, `bin/./mirror`):
 *   `tar` extracts it where the plain name goes, yet `tar -xzf A mirror`
 *   does not find it;
 * - ends in `/` and is a regular file: `tar` extracts it as a directory (the
 *   old convention for type `\0`, which GNU tar applies to type `0` too);
 * - has a backslash: `tar` on Windows reads it as `/`, so `bin\mirror` is
 *   `bin/mirror` there.
 *
 * A directory's one trailing `/` is dropped before it is compared.
 *
 * Every numeric field (mode, uid, gid, size, mtime, checksum, devmajor,
 * devminor) is read in one form only, which GNU tar reads to the same number
 * (`NUMERIC`); a field in any other form is refused. The checksum must be the
 * unsigned sum; tar also takes the signed one, and that is refused too.
 *
 * Some of these refuse what `tar` reads alike, rather than model it: the
 * signed checksum, a numeric field with one leading NUL, another `isspace`
 * byte before its digits, bytes after its terminator or base-256 digits, a
 * GNU header, `./` and `//` in names, every link, a backslash, case
 * variants. mirror's archives use none of them.
 *
 * The scan ends at the two zero blocks that end the archive; what follows them
 * is not read, as `tar` does not read it. A single zero block followed by an
 * entry is refused.
 *
 * Erasable TypeScript with node builtins only.
 */
import { PinsError } from "./pins.ts";
import {
	firstIgnorable,
	foldName,
	shownName,
	upcaseName,
} from "./pins-tar-names.ts";

export { foldName, shownName, upcaseName } from "./pins-tar-names.ts";

export const BLOCK = 512;
/** The largest member read: the manifest's largest asset. */
export const MAX_MEMBER_BYTES = 2 * 1024 ** 3;
/** The most entries read: each name is kept to compare with the others. */
export const MAX_ENTRIES = 10_000;

/** The data-less entry types, by what they are. */
const DATALESS = new Map([
	["1", "hard link"],
	["2", "symbolic link"],
	["3", "character device"],
	["4", "block device"],
	["5", "directory"],
	["6", "FIFO"],
]);

/** Types the reader refuses, named where the name says why. */
const REFUSED_KIND = new Map([
	["7", "contiguous file"],
	["D", "GNU dumpdir"],
	["S", "GNU sparse file"],
	["M", "GNU multi-volume continuation"],
	["N", "GNU old long name"],
	["V", "GNU volume label"],
]);

interface TarHeader {
	readonly name: string;
	readonly size: number;
	readonly type: string;
}

function field(block: Buffer, start: number, length: number): string {
	const raw = block.subarray(start, start + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? length : end).toString("latin1");
}

/**
 * The one form of a numeric field read: spaces, octal digits, then only NULs
 * and spaces to the end of the field; or NULs only, which tar reads as 0.
 * GNU tar's `from_header` reads each such field to the same number. It reads
 * more than this (any C `isspace` byte before the digits, one NUL before
 * them, anything after the byte that ends them, base-256), and all of that
 * is refused here rather than modelled: a byte such as NBSP (0xA0), which a
 * JavaScript `trim` would take for a space, is no space to tar, and a field
 * tar cannot read makes it skip the header and read the next block as one.
 */
const NUMERIC = /^(?: *[0-7]+[ \0]*|\0+)$/u;

/** The numeric fields of a ustar header, by offset and length. */
const NUMERIC_FIELDS = [
	["mode", 100, 8],
	["uid", 108, 8],
	["gid", 116, 8],
	["size", 124, 12],
	["mtime", 136, 12],
	["checksum", 148, 8],
	["devmajor", 329, 8],
	["devminor", 337, 8],
] as const;

/** Bytes for a message: printable ASCII as it is, anything else as `\xNN`. */
function shownBytes(text: string): string {
	let shown = "";
	for (const char of text) {
		const code = char.charCodeAt(0);
		shown +=
			code > 0x20 && code < 0x7f && char !== "\\" && char !== '"'
				? char
				: `\\x${code.toString(16).padStart(2, "0")}`;
	}
	return `"${shown}"`;
}

function octal(
	block: Buffer,
	start: number,
	length: number,
	what: string,
	archive: string,
): number {
	const text = block.subarray(start, start + length).toString("latin1");
	if (!NUMERIC.test(text)) {
		throw new PinsError(
			"ARCHIVE_MALFORMED",
			`${archive} has a tar header whose ${what} field, ${shownBytes(text)}, is not octal digits between spaces and NULs; tar may read it otherwise`,
		);
	}
	const digits = text.replace(/[ \0]/gu, "");
	return digits === "" ? 0 : Number.parseInt(digits, 8);
}

/**
 * The path an entry of `type` stored as `raw` is extracted to, in the one
 * spelling the reader compares; any other spelling is refused.
 */
function entryPath(raw: string, type: string, archive: string): string {
	const shown = shownName(raw);
	if (type === "0" && raw.endsWith("/")) {
		throw new PinsError(
			"ARCHIVE_UNSAFE",
			`${archive} has a regular file named ${shown}, which tar extracts as a directory because the name ends in "/"; refusing to read it as a file`,
		);
	}
	const path = type === "5" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
	if (path.startsWith("/")) {
		throw new PinsError(
			"ARCHIVE_UNSAFE",
			`${archive} has an entry with the absolute name ${shown}, which tar strips of its "/" and extracts beside the others; refusing it`,
		);
	}
	const parts = path.split("/");
	if (parts.includes("..")) {
		throw new PinsError(
			"ARCHIVE_UNSAFE",
			`${archive} has an entry named ${shown}, which climbs with ".."; refusing it`,
		);
	}
	if (parts.some((part) => part === "" || part === ".")) {
		throw new PinsError(
			"ARCHIVE_UNSAFE",
			`${archive} has an entry named ${shown}, with a "." or empty segment: tar extracts it where the plain name goes but does not find it by that name; refusing it`,
		);
	}
	const ignorable = firstIgnorable(path);
	if (ignorable !== undefined) {
		throw new PinsError(
			"ARCHIVE_UNSAFE",
			`${archive} has an entry named ${shown}, holding U+${ignorable.toString(16).toUpperCase().padStart(4, "0")}, a default-ignorable code point, which HFS+ and some Linux casefold kernels drop from names, so it can be another name's file there; refusing it`,
		);
	}
	if (path.includes("\\")) {
		throw new PinsError(
			"ARCHIVE_UNSAFE",
			`${archive} has an entry named ${shown}, with a backslash, which tar on Windows reads as a path separator (\`bin\\mirror\` is \`bin/mirror\` there); refusing it`,
		);
	}
	return path;
}

function parseHeader(block: Buffer, archive: string): TarHeader {
	const stored = octal(block, 148, 8, "checksum", archive);
	let sum = 0;
	for (let i = 0; i < BLOCK; i += 1) {
		sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
	}
	if (sum !== stored) {
		throw new PinsError(
			"ARCHIVE_MALFORMED",
			`${archive} has a tar header whose checksum is wrong`,
		);
	}
	const magic = block.subarray(257, 263).toString("latin1");
	if (magic === "ustar ") {
		throw new PinsError(
			"ARCHIVE_UNSUPPORTED",
			`${archive} has a GNU-format header ("ustar  " magic), whose bytes 345 to 500 tar reads as times, never as a name prefix; only POSIX ustar headers are read`,
		);
	}
	if (magic !== "ustar\0") {
		throw new PinsError(
			"ARCHIVE_UNSUPPORTED",
			`${archive} has a header that is not ustar (no ustar magic: a v7 or unknown format); only POSIX ustar headers are read`,
		);
	}
	const type = field(block, 156, 1) || "0";
	if (type === "x" || type === "g" || type === "L" || type === "K") {
		throw new PinsError(
			"ARCHIVE_UNSUPPORTED",
			`${archive} carries a ${type === "x" || type === "g" ? "pax" : "GNU long-name"} header, which renames the entry after it; only plain ustar archives are read`,
		);
	}
	if (type !== "0" && !DATALESS.has(type)) {
		const kind = REFUSED_KIND.get(type);
		throw new PinsError(
			"ARCHIVE_UNSUPPORTED",
			`${archive} has a type ${shownBytes(type)} entry${kind === undefined ? "" : ` (${kind})`}, whose data tar reads as that entry's own; only regular files, devices, directories and FIFOs are read`,
		);
	}
	for (const [what, start, length] of NUMERIC_FIELDS) {
		octal(block, start, length, what, archive);
	}
	const size = octal(block, 124, 12, "size", archive);
	const dataless = DATALESS.get(type);
	if (dataless !== undefined && size !== 0) {
		throw new PinsError(
			"ARCHIVE_MALFORMED",
			`${archive} has a ${dataless} entry that claims ${size} bytes of data; tar and this reader would disagree about what follows it`,
		);
	}
	const name = field(block, 0, 100);
	const prefix = field(block, 345, 155);
	const raw = prefix === "" ? name : `${prefix}/${name}`;
	return { name: entryPath(raw, type, archive), size, type };
}

/**
 * Feed it the decompressed archive in any chunking; it hands the bytes of
 * `member` to `sink` and stops at the end of the archive.
 */
export class TarScan {
	readonly #archive: string;
	readonly #member: string;
	/** The member's two keys, `foldName` and `upcaseName`. */
	readonly #memberKeys: readonly [string, string];
	readonly #sink: (chunk: Buffer) => void;
	/** Every name read so far, by each of its two keys. */
	readonly #names = [new Map<string, string>(), new Map<string, string>()];
	#pending: Buffer = Buffer.alloc(0);
	#left = 0;
	#pad = 0;
	#taking = false;
	#found = false;
	#size = 0;
	#zeros = 0;
	#ended = false;
	#consumed = 0;
	#skipped = 0;

	constructor(archive: string, member: string, sink: (chunk: Buffer) => void) {
		this.#archive = archive;
		this.#member = member;
		this.#memberKeys = [foldName(member), upcaseName(member)];
		this.#sink = sink;
	}

	/** True once the two end-of-archive blocks have been read. */
	get ended(): boolean {
		return this.#ended;
	}

	/** Every byte read so far: headers, data, padding and zero blocks. */
	get consumed(): number {
		return this.#consumed;
	}

	/** The data and padding read so far that was not the member's: what was skipped. */
	get skipped(): number {
		return this.#skipped;
	}

	push(chunk: Buffer): void {
		if (this.#ended) return;
		this.#pending =
			this.#pending.length === 0
				? chunk
				: Buffer.concat([this.#pending, chunk]);
		// Each step consumes data, padding or one header block.
		let more = true;
		while (more && !this.#ended) more = this.#step();
	}

	/** The member's size, once the whole archive has been read. */
	finish(): number {
		if (!this.#ended || this.#left > 0 || this.#pad > 0) {
			throw new PinsError(
				"ARCHIVE_MALFORMED",
				`${this.#archive} ends before its end-of-archive blocks`,
			);
		}
		if (!this.#found) {
			throw new PinsError(
				"ARCHIVE_MEMBER_MISSING",
				`${this.#archive} holds no regular file named ${this.#member}`,
			);
		}
		return this.#size;
	}

	/** One unit of work; false when it needs more bytes. */
	#step(): boolean {
		if (this.#left > 0 || this.#pad > 0) {
			const want = this.#left > 0 ? this.#left : this.#pad;
			const n = Math.min(want, this.#pending.length);
			if (n === 0) return false;
			if (this.#left > 0 && this.#taking) {
				this.#sink(this.#pending.subarray(0, n));
			} else {
				this.#skipped += n;
			}
			if (this.#left > 0) this.#left -= n;
			else this.#pad -= n;
			this.#consumed += n;
			this.#pending = this.#pending.subarray(n);
			return true;
		}
		if (this.#pending.length < BLOCK) return false;
		const block = this.#pending.subarray(0, BLOCK);
		this.#pending = this.#pending.subarray(BLOCK);
		this.#consumed += BLOCK;
		if (block.every((byte) => byte === 0)) {
			this.#zeros += 1;
			this.#ended = this.#zeros === 2;
			return true;
		}
		if (this.#zeros > 0) {
			throw new PinsError(
				"ARCHIVE_MALFORMED",
				`${this.#archive} has an entry after a lone zero block`,
			);
		}
		this.#header(parseHeader(block, this.#archive));
		return true;
	}

	#header(header: TarHeader): void {
		if ((this.#names[0]?.size ?? 0) >= MAX_ENTRIES) {
			throw new PinsError(
				"ARCHIVE_UNSUPPORTED",
				`${this.#archive} has more than ${MAX_ENTRIES} entries; a release archive of one binary needs far fewer`,
			);
		}
		this.#refuseAliases(header);
		this.#taking = header.name === this.#member;
		if (this.#taking) {
			if (header.type !== "0") {
				throw new PinsError(
					"ARCHIVE_UNSAFE",
					`${this.#member} in ${this.#archive} is a ${DATALESS.get(header.type) ?? "non-regular file"}, not a regular file; refusing to follow or create it`,
				);
			}
			if (header.size > MAX_MEMBER_BYTES) {
				throw new PinsError(
					"SIZE_EXCEEDED",
					`${this.#member} in ${this.#archive} is ${header.size} bytes, more than ${MAX_MEMBER_BYTES}`,
				);
			}
			this.#found = true;
			this.#size = header.size;
		}
		this.#left = header.size;
		this.#pad = (BLOCK - (header.size % BLOCK)) % BLOCK;
	}

	/** Refuse an entry that could make tar put other bytes, or nothing, at the member's path. */
	#refuseAliases({ name, type }: TarHeader): void {
		const kind = type === "0" ? "regular file" : DATALESS.get(type);
		if (type === "1" || type === "2") {
			throw new PinsError(
				"ARCHIVE_UNSAFE",
				`${this.#archive} has a ${kind} named ${shownName(name)}; a link can give ${this.#member} a second name or lead a path somewhere else, so no link is read anywhere in the archive`,
			);
		}
		const keys = [foldName(name), upcaseName(name)] as const;
		keys.forEach((key, which) => {
			const seen = this.#names[which]?.get(key);
			if (seen === undefined) return;
			throw new PinsError(
				"ARCHIVE_UNSAFE",
				seen === name
					? `${this.#archive} holds ${shownName(name)} twice; refusing to choose one`
					: `${this.#archive} holds ${shownName(seen)} and ${shownName(name)}, one file ${which === 0 ? "under Unicode's caseless match (a Linux casefold directory)" : "under NTFS's uppercase"}; refusing to choose one`,
			);
		});
		keys.forEach((key, which) => this.#names[which]?.set(key, name));
		keys.forEach((key, which) => {
			const member = this.#memberKeys[which] ?? "";
			if (key.startsWith(`${member}/`)) {
				throw new PinsError(
					"ARCHIVE_UNSAFE",
					`${this.#archive} has ${shownName(name)}, under ${this.#member}, so tar would make ${this.#member} a directory; refusing it`,
				);
			}
			if (type !== "5" && member.startsWith(`${key}/`)) {
				throw new PinsError(
					"ARCHIVE_UNSAFE",
					`${this.#archive} has a ${kind} at ${shownName(name)}, where ${this.#member} needs a directory, so tar cannot extract both; refusing it`,
				);
			}
		});
	}
}
