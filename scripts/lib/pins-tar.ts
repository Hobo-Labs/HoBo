import { PinsError } from "./pins.ts";
import {
	firstIgnorable,
	foldName,
	shownName,
	upcaseName,
} from "./pins-tar-names.ts";

export { foldName, shownName, upcaseName } from "./pins-tar-names.ts";

export const BLOCK = 512;
export const MAX_MEMBER_BYTES = 2 * 1024 ** 3;
export const MAX_ENTRIES = 10_000;

const DATALESS = new Map([
	["1", "hard link"],
	["2", "symbolic link"],
	["3", "character device"],
	["4", "block device"],
	["5", "directory"],
	["6", "FIFO"],
]);

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

const NUMERIC = /^(?: *[0-7]+[ \0]*|\0+)$/u;

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

export class TarScan {
	readonly #archive: string;
	readonly #member: string;
	readonly #memberKeys: readonly [string, string];
	readonly #sink: (chunk: Buffer) => void;
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

	get ended(): boolean {
		return this.#ended;
	}

	get consumed(): number {
		return this.#consumed;
	}

	get skipped(): number {
		return this.#skipped;
	}

	push(chunk: Buffer): void {
		if (this.#ended) return;
		this.#pending =
			this.#pending.length === 0
				? chunk
				: Buffer.concat([this.#pending, chunk]);
		let more = true;
		while (more && !this.#ended) more = this.#step();
	}

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
