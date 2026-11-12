// Git wire formats for host-neutral discovery over smart HTTP protocol v2:
// pkt-lines, side-band demultiplexing, and a packfile reader for the objects
// a `deepen 1` fetch returns (commits and trees; blobs are filtered out).
// No git binary and no host API: the bytes are parsed here.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export type ObjectFormat = "sha1" | "sha256";
export type GitObjectType = "commit" | "tree" | "blob" | "tag";
export type GitObject = Readonly<{ oid: string; type: GitObjectType; data: Uint8Array }>;

export class GitFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitFormatError";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── pkt-line ────────────────────────────────────────────────────────────────

export const FLUSH = "0000";
export const DELIM = "0001";

export function pktLine(payload: string): string {
	const length = encoder.encode(payload).byteLength + 4;
	if (length > 65_520) throw new GitFormatError("pkt-line too long");
	return `${length.toString(16).padStart(4, "0")}${payload}`;
}

export type Packet =
	| Readonly<{ kind: "data"; bytes: Uint8Array }>
	| Readonly<{ kind: "flush" }>
	| Readonly<{ kind: "delim" }>
	| Readonly<{ kind: "end" }>;

export function readPackets(bytes: Uint8Array): readonly Packet[] {
	const packets: Packet[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		if (offset + 4 > bytes.length) throw new GitFormatError("truncated pkt-line length");
		const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
		if (Number.isNaN(length)) throw new GitFormatError("invalid pkt-line length");
		if (length === 0) packets.push({ kind: "flush" });
		else if (length === 1) packets.push({ kind: "delim" });
		else if (length === 2) packets.push({ kind: "end" });
		else if (length < 4 || offset + length > bytes.length) throw new GitFormatError("pkt-line length out of range");
		else packets.push({ kind: "data", bytes: bytes.subarray(offset + 4, offset + length) });
		offset += length < 4 ? 4 : length;
	}
	return packets;
}

export function packetText(packet: Packet): string | undefined {
	return packet.kind === "data" ? decoder.decode(packet.bytes).replace(/\n$/, "") : undefined;
}

/**
 * The v2 capability advertisement (`info/refs?service=git-upload-pack`),
 * tolerating the `# service=` preamble smart-HTTP servers send first.
 */
export function parseCapabilities(bytes: Uint8Array): Readonly<{ version: number; capabilities: ReadonlyMap<string, string> }> {
	const lines = readPackets(bytes)
		.map(packetText)
		.filter((line): line is string => line !== undefined && !line.startsWith("# service="));
	const capabilities = new Map<string, string>();
	let version = 0;
	for (const line of lines) {
		if (line.startsWith("version ")) version = Number(line.slice(8));
		else {
			const eq = line.indexOf("=");
			capabilities.set(eq < 0 ? line : line.slice(0, eq), eq < 0 ? "" : line.slice(eq + 1));
		}
	}
	return { version, capabilities };
}

export type RemoteRef = Readonly<{ oid: string; name: string; peeled?: string }>;

export function parseLsRefs(bytes: Uint8Array): readonly RemoteRef[] {
	const refs: RemoteRef[] = [];
	for (const packet of readPackets(bytes)) {
		const line = packetText(packet);
		if (line === undefined) continue;
		const [oid, name, ...attributes] = line.split(" ");
		if (!oid || !name || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) throw new GitFormatError(`invalid ls-refs line: ${line}`);
		const peeled = attributes.find((item) => item.startsWith("peeled:"))?.slice(7);
		refs.push(peeled ? { oid, name, peeled } : { oid, name });
	}
	return refs;
}

/** Concatenate side-band channel 1 of the `packfile` section of a v2 fetch response. */
export function fetchPackfile(bytes: Uint8Array): Uint8Array {
	const packets = readPackets(bytes);
	let inPack = false;
	const chunks: Uint8Array[] = [];
	for (const packet of packets) {
		if (packet.kind !== "data") continue;
		if (!inPack) {
			const line = packetText(packet);
			if (line === "packfile") inPack = true;
			if (line?.startsWith("ERR ")) throw new GitFormatError(`server error: ${line.slice(4)}`);
			continue;
		}
		const band = packet.bytes[0];
		if (band === 1) chunks.push(packet.bytes.subarray(1));
		else if (band === 3) throw new GitFormatError(`server error: ${decoder.decode(packet.bytes.subarray(1))}`);
	}
	if (!inPack) throw new GitFormatError("fetch response has no packfile section");
	return Buffer.concat(chunks);
}

// ── packfile ────────────────────────────────────────────────────────────────

const TYPES: Readonly<Record<number, GitObjectType>> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const MAX_OBJECTS = 1_000_000;

function hashObject(format: ObjectFormat, type: GitObjectType, data: Uint8Array): string {
	return createHash(format).update(`${type} ${data.byteLength}\0`).update(data).digest("hex");
}

// With `info: true` node:zlib returns `{ buffer, engine }` (documented); the
// typing below narrows the declared Buffer return to carry `engine`, and the
// code reads `buffer` only through `new Uint8Array(...)`, which copies the
// bytes whether `buffer` is the inflated Buffer or an ArrayBuffer.
type InflateWithInfo = (
	buffer: Uint8Array,
	options: Readonly<{ info: true }>,
) => ReturnType<typeof inflateSync> & Readonly<{ engine: Readonly<{ bytesWritten: number }> }>;
// SAFETY: @types/node does not model the documented `info: true` overload.
const inflateWithInfo = inflateSync as InflateWithInfo;

function inflate(bytes: Uint8Array, offset: number, size: number): Readonly<{ data: Uint8Array; consumed: number }> {
	try {
		const result = inflateWithInfo(bytes.subarray(offset), { info: true });
		const data = new Uint8Array(result.buffer);
		if (data.byteLength !== size) throw new GitFormatError("inflated size does not match the object header");
		// `bytesWritten` is the compressed input zlib consumed for this stream.
		return { data, consumed: result.engine.bytesWritten };
	} catch (error) {
		if (error instanceof GitFormatError) throw error;
		throw new GitFormatError("corrupt zlib stream in packfile");
	}
}

function readVarint(bytes: Uint8Array, start: number): Readonly<{ value: number; next: number }> {
	let value = 0;
	let shift = 0;
	let offset = start;
	for (;;) {
		const byte = bytes[offset];
		if (byte === undefined) throw new GitFormatError("truncated delta header");
		value += (byte & 0x7f) * 2 ** shift;
		offset += 1;
		shift += 7;
		if ((byte & 0x80) === 0) return { value, next: offset };
	}
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
	const source = readVarint(delta, 0);
	if (source.value !== base.byteLength) throw new GitFormatError("delta base size mismatch");
	const target = readVarint(delta, source.next);
	const out = new Uint8Array(target.value);
	let offset = target.next;
	let written = 0;
	while (offset < delta.length) {
		const op = delta[offset] ?? 0;
		offset += 1;
		if (op & 0x80) {
			let copyOffset = 0;
			let copySize = 0;
			for (let bit = 0; bit < 4; bit += 1) {
				if (op & (1 << bit)) {
					copyOffset += (delta[offset] ?? 0) * 2 ** (8 * bit);
					offset += 1;
				}
			}
			for (let bit = 0; bit < 3; bit += 1) {
				if (op & (0x10 << bit)) {
					copySize += (delta[offset] ?? 0) * 2 ** (8 * bit);
					offset += 1;
				}
			}
			if (copySize === 0) copySize = 0x10000;
			if (copyOffset + copySize > base.byteLength || written + copySize > out.byteLength)
				throw new GitFormatError("delta copy out of range");
			out.set(base.subarray(copyOffset, copyOffset + copySize), written);
			written += copySize;
		} else if (op > 0) {
			if (offset + op > delta.length || written + op > out.byteLength) throw new GitFormatError("delta insert out of range");
			out.set(delta.subarray(offset, offset + op), written);
			offset += op;
			written += op;
		} else {
			throw new GitFormatError("reserved delta opcode");
		}
	}
	if (written !== out.byteLength) throw new GitFormatError("delta result size mismatch");
	return out;
}

type Pending = Readonly<{ offset: number; base: { offset: number } | { oid: string }; delta: Uint8Array }>;

/** Read every object in a version-2 packfile, resolving OFS/REF deltas. */
export function readPack(pack: Uint8Array, format: ObjectFormat): ReadonlyMap<string, GitObject> {
	const hashLength = format === "sha1" ? 20 : 32;
	if (pack.length < 12 + hashLength || decoder.decode(pack.subarray(0, 4)) !== "PACK")
		throw new GitFormatError("not a packfile");
	const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
	const version = view.getUint32(4);
	if (version !== 2 && version !== 3) throw new GitFormatError(`unsupported pack version ${version}`);
	const count = view.getUint32(8);
	if (count > MAX_OBJECTS) throw new GitFormatError("packfile has too many objects");
	const trailer = Buffer.from(pack.subarray(pack.length - hashLength)).toString("hex");
	if (createHash(format).update(pack.subarray(0, pack.length - hashLength)).digest("hex") !== trailer)
		throw new GitFormatError("packfile checksum mismatch");
	const byOid = new Map<string, GitObject>();
	const byOffset = new Map<number, GitObject>();
	const pending: Pending[] = [];
	let offset = 12;
	for (let index = 0; index < count; index += 1) {
		const start = offset;
		let byte = pack[offset] ?? 0;
		offset += 1;
		const typeCode = (byte >> 4) & 0x07;
		let size = byte & 0x0f;
		let shift = 4;
		while (byte & 0x80) {
			byte = pack[offset] ?? 0;
			offset += 1;
			size += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		}
		if (typeCode === 6) {
			byte = pack[offset] ?? 0;
			offset += 1;
			let relative = byte & 0x7f;
			while (byte & 0x80) {
				byte = pack[offset] ?? 0;
				offset += 1;
				relative = (relative + 1) * 128 + (byte & 0x7f);
			}
			const inflated = inflate(pack, offset, size);
			offset += inflated.consumed;
			pending.push({ offset: start, base: { offset: start - relative }, delta: inflated.data });
		} else if (typeCode === 7) {
			const base = Buffer.from(pack.subarray(offset, offset + hashLength)).toString("hex");
			offset += hashLength;
			const inflated = inflate(pack, offset, size);
			offset += inflated.consumed;
			pending.push({ offset: start, base: { oid: base }, delta: inflated.data });
		} else {
			const type = TYPES[typeCode];
			if (!type) throw new GitFormatError(`unknown object type ${typeCode}`);
			const inflated = inflate(pack, offset, size);
			offset += inflated.consumed;
			const object: GitObject = { oid: hashObject(format, type, inflated.data), type, data: inflated.data };
			byOid.set(object.oid, object);
			byOffset.set(start, object);
		}
		if (offset > pack.length - hashLength) throw new GitFormatError("packfile object overruns the trailer");
	}
	// Resolve deltas until no progress: bases may themselves be deltas.
	let remaining = pending;
	while (remaining.length > 0) {
		const next: Pending[] = [];
		for (const item of remaining) {
			const base = "oid" in item.base ? byOid.get(item.base.oid) : byOffset.get(item.base.offset);
			if (!base) {
				next.push(item);
				continue;
			}
			const data = applyDelta(base.data, item.delta);
			const object: GitObject = { oid: hashObject(format, base.type, data), type: base.type, data };
			byOid.set(object.oid, object);
			byOffset.set(item.offset, object);
		}
		if (next.length === remaining.length) throw new GitFormatError("packfile delta base is missing (thin pack?)");
		remaining = next;
	}
	return byOid;
}

// ── objects ─────────────────────────────────────────────────────────────────

export type Commit = Readonly<{ tree: string; parents: readonly string[]; committedAtMs: number }>;

export function parseCommit(data: Uint8Array): Commit {
	const headerEnd = decoder.decode(data).split("\n\n")[0] ?? "";
	let tree = "";
	const parents: string[] = [];
	let committedAtMs = 0;
	for (const line of headerEnd.split("\n")) {
		if (line.startsWith("tree ")) tree = line.slice(5);
		else if (line.startsWith("parent ")) parents.push(line.slice(7));
		else if (line.startsWith("committer ")) {
			const match = / (\d+) [+-]\d{4}$/.exec(line);
			if (match?.[1]) committedAtMs = Number(match[1]) * 1000;
		}
	}
	if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) throw new GitFormatError("commit has no tree");
	return { tree, parents, committedAtMs };
}

export type TreeEntry = Readonly<{ mode: string; name: string; oid: string }>;

export function parseTree(data: Uint8Array, format: ObjectFormat): readonly TreeEntry[] {
	const hashLength = format === "sha1" ? 20 : 32;
	const entries: TreeEntry[] = [];
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		const nul = data.indexOf(0x00, space + 1);
		if (space < 0 || nul < 0 || nul + 1 + hashLength > data.length) throw new GitFormatError("corrupt tree object");
		entries.push({
			mode: decoder.decode(data.subarray(offset, space)),
			name: decoder.decode(data.subarray(space + 1, nul)),
			oid: Buffer.from(data.subarray(nul + 1, nul + 1 + hashLength)).toString("hex"),
		});
		offset = nul + 1 + hashLength;
	}
	return entries;
}

export type TreeFile = Readonly<{ path: string; mode: string; oid: string }>;

/** Every non-tree entry under `treeOid`, with full paths. Missing subtrees are an error. */
export function walkTree(
	objects: ReadonlyMap<string, GitObject>,
	treeOid: string,
	format: ObjectFormat,
	prefix = "",
): readonly TreeFile[] {
	const tree = objects.get(treeOid);
	if (!tree || tree.type !== "tree") throw new GitFormatError(`tree ${treeOid} is missing from the pack`);
	const files: TreeFile[] = [];
	for (const entry of parseTree(tree.data, format)) {
		const path = `${prefix}${entry.name}`;
		if (entry.mode === "40000") files.push(...walkTree(objects, entry.oid, format, `${path}/`));
		else files.push({ path, mode: entry.mode, oid: entry.oid });
	}
	return files;
}

export function bytesOf(text: string): Uint8Array {
	return encoder.encode(text);
}
