/**
 * A tar reader for the pinned gVisor release (`runtime-provision.ts`, D58),
 * so unpacking needs no host `tar`. It reads ustar and GNU headers (with GNU
 * long names and PAX `path` records), writes the regular files and
 * directories whose names `allow` accepts, mode 0755, and skips everything
 * else, links included. The input arrives as chunks (from `bunzip2`), so the
 * archive is never held whole in memory.
 */
import {
	chmodSync,
	closeSync,
	fchmodSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const BLOCK = 512;
const NAME = /^[A-Za-z0-9._-]+$/u;

/** The members of a gVisor release the agent keeps: `runsc`, and `gvisor-bin/` with its direct files. */
export function tarEntryAllowed(name: string): boolean {
	const path = name.startsWith("./") ? name.slice(2) : name;
	if (path === "runsc" || path === "gvisor-bin/" || path === "gvisor-bin")
		return true;
	const parts = path.split("/");
	return (
		parts.length === 2 &&
		parts[0] === "gvisor-bin" &&
		NAME.test(parts[1] ?? "") &&
		parts[1] !== "." &&
		parts[1] !== ".."
	);
}

const text = (bytes: Uint8Array, start: number, length: number): string => {
	const field = bytes.subarray(start, start + length);
	const end = field.indexOf(0);
	return Buffer.from(end < 0 ? field : field.subarray(0, end)).toString("utf8");
};

function octal(bytes: Uint8Array, start: number, length: number): number {
	// GNU base-256 for sizes past 8 GiB: high bit set on the first byte.
	if (((bytes[start] ?? 0) & 0x80) !== 0) {
		let value = (bytes[start] ?? 0) & 0x7f;
		for (let i = 1; i < length; i += 1)
			value = value * 256 + (bytes[start + i] ?? 0);
		return value;
	}
	const field = text(bytes, start, length).trim();
	if (!/^[0-7]*$/u.test(field)) throw new Error(`tar: bad number "${field}"`);
	return field === "" ? 0 : Number.parseInt(field, 8);
}

/** The `path` record of a PAX extended header, if any. */
function paxPath(data: Uint8Array): string | undefined {
	const records = Buffer.from(data).toString("utf8");
	let at = 0;
	while (at < records.length) {
		const space = records.indexOf(" ", at);
		const length = Number(records.slice(at, space));
		if (space < 0 || !Number.isInteger(length) || length <= 0) return undefined;
		const record = records.slice(space + 1, at + length - 1);
		if (record.startsWith("path=")) return record.slice("path=".length);
		at += length;
	}
	return undefined;
}

type Member = {
	name: string;
	type: string;
	size: number;
	/** Bytes of data still to read, then padding up to the next block. */
	left: number;
	padding: number;
	/** The open output file, the collected long name or PAX data, or nothing (skipped). */
	fd: number | undefined;
	collect: Uint8Array[] | undefined;
};

/**
 * Writes the accepted members of the tar archive in `chunks` under `into`
 * (which exists) and answers their names, without a leading `./`.
 */
export function extractTarEntries(
	chunks: Iterable<Uint8Array>,
	into: string,
	allow: (name: string) => boolean,
): string[] {
	const written: string[] = [];
	let header = new Uint8Array(BLOCK);
	let headerFill = 0;
	let member: Member | undefined;
	let longName: string | undefined;
	let ended = false;

	const open = (block: Uint8Array) => {
		if (block.every((byte) => byte === 0)) {
			ended = true;
			return;
		}
		let sum = 0;
		for (let i = 0; i < BLOCK; i += 1)
			sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
		if (sum !== octal(block, 148, 8))
			throw new Error("tar: a header checksum does not match");
		const prefix = text(block, 257, 6).startsWith("ustar")
			? text(block, 345, 155)
			: "";
		const base = text(block, 0, 100);
		const name = longName ?? (prefix === "" ? base : `${prefix}/${base}`);
		longName = undefined;
		const type = String.fromCharCode(block[156] ?? 0);
		const size = octal(block, 124, 12);
		const next: Member = {
			name,
			type,
			size,
			left: size,
			padding: (BLOCK - (size % BLOCK)) % BLOCK,
			fd: undefined,
			collect: undefined,
		};
		const path = name.startsWith("./") ? name.slice(2) : name;
		if (type === "L" || type === "x") next.collect = [];
		else if ((type === "0" || type === "\0") && allow(name)) {
			const target = join(into, path);
			mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
			next.fd = openSync(target, "wx", 0o755);
			// The mode is exact, whatever the umask.
			fchmodSync(next.fd, 0o755);
			written.push(path);
		} else if (type === "5" && allow(name)) {
			mkdirSync(join(into, path), { recursive: true, mode: 0o755 });
			chmodSync(join(into, path), 0o755);
		}
		member = next;
		if (next.left === 0 && next.padding === 0) finish();
	};

	const finish = () => {
		const done = member;
		member = undefined;
		if (done === undefined) return;
		if (done.fd !== undefined) closeSync(done.fd);
		if (done.collect !== undefined) {
			const data = Buffer.concat(done.collect);
			if (done.type === "L") longName = text(data, 0, data.length);
			else longName = paxPath(data) ?? longName;
		}
	};

	try {
		for (const chunk of chunks) {
			let at = 0;
			while (at < chunk.length && !ended) {
				if (member === undefined) {
					const take = Math.min(BLOCK - headerFill, chunk.length - at);
					header.set(chunk.subarray(at, at + take), headerFill);
					headerFill += take;
					at += take;
					if (headerFill === BLOCK) {
						headerFill = 0;
						open(header);
						header = new Uint8Array(BLOCK);
					}
					continue;
				}
				if (member.left > 0) {
					const take = Math.min(member.left, chunk.length - at);
					const piece = chunk.subarray(at, at + take);
					if (member.fd !== undefined) writeSync(member.fd, piece);
					else member.collect?.push(piece.slice());
					member.left -= take;
					at += take;
				} else {
					const take = Math.min(member.padding, chunk.length - at);
					member.padding -= take;
					at += take;
				}
				if (member.left === 0 && member.padding === 0) finish();
			}
			if (ended) break;
		}
		if (member !== undefined) throw new Error("tar: the archive ends early");
		if (!ended && headerFill !== 0)
			throw new Error("tar: the archive ends inside a header");
	} finally {
		if (member?.fd !== undefined) closeSync(member.fd);
	}
	return written;
}
