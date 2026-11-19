import { gzipSync } from "node:zlib";

export interface TarEntry {
	readonly name: string;
	readonly body?: Uint8Array | string;
	readonly type?: string;
	readonly linkname?: string;
	readonly badChecksum?: boolean;
	readonly claimedSize?: number;
	readonly magic?: string;
	readonly prefix?: string;
	readonly raw?: readonly (readonly [number, string])[];
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

export function tarGz(
	entries: readonly TarEntry[],
	after: readonly TarEntry[] = [],
): Buffer {
	const parts: Buffer[] = [tarStream(entries)];
	parts.push(Buffer.alloc(1024));
	if (after.length > 0) parts.push(tarStream(after));
	return gzipSync(Buffer.concat(parts));
}

export function paxPath(path: string): string {
	const record = ` path=${path}\n`;
	let length = record.length + 2;
	while (`${length}${record}`.length !== length) length += 1;
	return `${length}${record}`;
}
