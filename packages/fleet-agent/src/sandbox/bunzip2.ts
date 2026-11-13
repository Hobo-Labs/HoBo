/**
 * A bzip2 decoder, so the agent unpacks the pinned gVisor release
 * (`runtime-provision.ts`, D58) without a host `bzip2` (which `tar -j` runs,
 * and which a minimal image does not carry). It decodes one or more
 * concatenated streams, checks every block's CRC and each stream's combined
 * CRC, and yields one chunk per block. Randomised blocks (written only by
 * bzip2 before 0.9.5) are refused.
 *
 * The format: a `BZh1`..`BZh9` header, blocks of Huffman-coded MTF/RLE
 * symbols over a Burrows-Wheeler transform, an end-of-stream marker. The
 * input is already SHA-512 verified when this runs; the checks here guard
 * against a decoder bug, not an attacker.
 */

const BLOCK_MAGIC_HI = 0x314159;
const BLOCK_MAGIC_LO = 0x265359;
const END_MAGIC_HI = 0x177245;
const END_MAGIC_LO = 0x385090;
const GROUP_SIZE = 50;
const MAX_CODE_LENGTH = 20;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i << 24;
		for (let k = 0; k < 8; k += 1)
			c = c & 0x8000_0000 ? (c << 1) ^ 0x04c1_1db7 : c << 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function fail(message: string): never {
	throw new Error(`bzip2: ${message}`);
}

/** MSB-first bit reader; at most 24 bits per read keeps the buffer under 2^31. */
class Bits {
	private buffer = 0;
	private count = 0;
	private index = 0;
	constructor(private readonly data: Uint8Array) {}

	read(n: number): number {
		while (this.count < n) {
			if (this.index >= this.data.length) fail("the data ends early");
			this.buffer = (this.buffer << 8) | (this.data[this.index] ?? 0);
			this.index += 1;
			this.count += 8;
		}
		this.count -= n;
		const value = (this.buffer >>> this.count) & ((1 << n) - 1);
		this.buffer &= (1 << this.count) - 1;
		return value;
	}

	bit(): number {
		return this.read(1);
	}

	read32(): number {
		return ((this.read(16) << 16) | this.read(16)) >>> 0;
	}

	/** Drops the bits left in the current byte (streams end on a byte boundary). */
	align(): void {
		this.count -= this.count % 8;
		this.buffer &= (1 << this.count) - 1;
	}

	atEnd(): boolean {
		return this.index >= this.data.length && this.count < 8;
	}
}

/** Canonical Huffman decoding table of one coding group. */
type Table = Readonly<{
	minLength: number;
	maxLength: number;
	limit: Int32Array;
	base: Int32Array;
	symbols: Uint16Array;
}>;

function huffmanTable(lengths: Uint8Array): Table {
	let minLength = MAX_CODE_LENGTH;
	let maxLength = 0;
	for (const length of lengths) {
		if (length < minLength) minLength = length;
		if (length > maxLength) maxLength = length;
	}
	const symbols = new Uint16Array(lengths.length);
	const limit = new Int32Array(MAX_CODE_LENGTH + 2).fill(-1);
	const base = new Int32Array(MAX_CODE_LENGTH + 2);
	let next = 0;
	let code = 0;
	for (let length = minLength; length <= maxLength; length += 1) {
		const first = next;
		for (let symbol = 0; symbol < lengths.length; symbol += 1)
			if (lengths[symbol] === length) {
				symbols[next] = symbol;
				next += 1;
			}
		// symbols[first + (c - code)] is the symbol of code c at this length.
		base[length] = first - code;
		code += next - first;
		limit[length] = code - 1;
		code <<= 1;
	}
	return { minLength, maxLength, limit, base, symbols };
}

function decodeSymbol(bits: Bits, table: Table): number {
	let length = table.minLength;
	let code = bits.read(length);
	for (;;) {
		if (code <= (table.limit[length] ?? -1))
			return (
				table.symbols[code + (table.base[length] ?? 0)] ?? fail("bad code")
			);
		length += 1;
		if (length > table.maxLength) fail("a Huffman code is not in its table");
		code = (code << 1) | bits.bit();
	}
}

function blockCrc(bytes: Uint8Array, length: number): number {
	let crc = 0xffff_ffff;
	for (let i = 0; i < length; i += 1)
		crc =
			(crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ (bytes[i] ?? 0)) & 0xff] ?? 0);
	return ~crc >>> 0;
}

/** Decodes one block's symbols into `tt` (the BWT output) and answers its byte count and origin pointer. */
/** One decoded block: `tt` holds its BWT links, `length` bytes from `origin`. */
type DecodedBlock = Readonly<{ length: number; origin: number }>;

function readBlock(bits: Bits, tt: Uint32Array): DecodedBlock {
	if (bits.bit() === 1) fail("randomised blocks are not supported");
	const origin = bits.read(24);
	const used: number[] = [];
	const ranges = bits.read(16);
	for (let i = 0; i < 16; i += 1)
		if (ranges & (0x8000 >> i)) {
			const bytes = bits.read(16);
			for (let j = 0; j < 16; j += 1)
				if (bytes & (0x8000 >> j)) used.push(i * 16 + j);
		}
	if (used.length === 0) fail("a block uses no byte values");
	const alphabet = used.length + 2;
	const groups = bits.read(3);
	if (groups < 2 || groups > 6) fail("bad Huffman group count");
	const selectorCount = bits.read(15);
	if (selectorCount === 0) fail("no selectors");
	const order = Array.from({ length: groups }, (_, i) => i);
	const selectors = new Uint8Array(selectorCount);
	for (let i = 0; i < selectorCount; i += 1) {
		let j = 0;
		while (bits.bit() === 1) {
			j += 1;
			if (j >= groups) fail("bad selector");
		}
		const group = order[j] ?? 0;
		order.splice(j, 1);
		order.unshift(group);
		selectors[i] = group;
	}
	const tables: Table[] = [];
	for (let t = 0; t < groups; t += 1) {
		const lengths = new Uint8Array(alphabet);
		let length = bits.read(5);
		for (let s = 0; s < alphabet; s += 1) {
			for (;;) {
				if (length < 1 || length > MAX_CODE_LENGTH)
					fail("bad Huffman code length");
				if (bits.bit() === 0) break;
				length += bits.bit() === 0 ? 1 : -1;
			}
			lengths[s] = length;
		}
		tables.push(huffmanTable(lengths));
	}

	const endOfBlock = alphabet - 1;
	const mtf = new Uint8Array(256).map((_, i) => i);
	const counts = new Uint32Array(256);
	let length = 0;
	let selector = 0;
	let left = 0;
	let table: Table | undefined;
	let run = 0;
	let runWeight = 0;
	for (;;) {
		if (left === 0) {
			if (selector >= selectorCount) fail("more groups than selectors");
			table = tables[selectors[selector] ?? 0];
			selector += 1;
			left = GROUP_SIZE;
		}
		left -= 1;
		const symbol = decodeSymbol(bits, table ?? fail("no table"));
		if (symbol <= 1) {
			if (runWeight === 0) {
				runWeight = 1;
				run = 0;
			}
			run += runWeight << symbol;
			runWeight <<= 1;
			if (run > tt.length) fail("a run overflows the block");
			continue;
		}
		if (runWeight !== 0) {
			runWeight = 0;
			if (length + run > tt.length) fail("a run overflows the block");
			const byte = used[mtf[0] ?? 0] ?? 0;
			tt.fill(byte, length, length + run);
			counts[byte] = (counts[byte] ?? 0) + run;
			length += run;
		}
		if (symbol === endOfBlock) break;
		const index = symbol - 1;
		const value = mtf[index] ?? 0;
		mtf.copyWithin(1, 0, index);
		mtf[0] = value;
		const byte = used[value] ?? 0;
		if (length >= tt.length) fail("the block overflows");
		tt[length] = byte;
		counts[byte] = (counts[byte] ?? 0) + 1;
		length += 1;
	}
	if (origin >= length && length > 0) fail("bad origin pointer");
	// Inverse BWT: link each position to the next one in the original order.
	let sum = 0;
	for (let b = 0; b < 256; b += 1) {
		const count = counts[b] ?? 0;
		counts[b] = sum;
		sum += count;
	}
	for (let i = 0; i < length; i += 1) {
		const byte = (tt[i] ?? 0) & 0xff;
		const at = counts[byte] ?? 0;
		tt[at] = (tt[at] ?? 0) | (i << 8);
		counts[byte] = at + 1;
	}
	return { length, origin };
}

/** Undoes the BWT and the initial run-length coding (four equal bytes, then a repeat count). */
function writeBlock(
	tt: Uint32Array,
	length: number,
	origin: number,
): Uint8Array {
	let out = new Uint8Array(Math.max(1024, length + (length >> 2)));
	let size = 0;
	const push = (byte: number) => {
		if (size === out.length) {
			const grown = new Uint8Array(out.length * 2);
			grown.set(out);
			out = grown;
		}
		out[size] = byte;
		size += 1;
	};
	// tt[p] >>> 8 is the position of the byte after the one at p; tt[p] & 0xff is that byte.
	let position = length === 0 ? 0 : (tt[origin] ?? 0) >>> 8;
	let last = -1;
	let same = 0;
	for (let k = 0; k < length; k += 1) {
		const entry = tt[position] ?? 0;
		const byte = entry & 0xff;
		position = entry >>> 8;
		if (same === 4) {
			for (let n = 0; n < byte; n += 1) push(last);
			same = 0;
			continue;
		}
		push(byte);
		if (byte === last) same += 1;
		else {
			last = byte;
			same = 1;
		}
	}
	return out.subarray(0, size);
}

/** Decodes the bzip2 data in `input`, one chunk per block. */
export function* bunzip2(input: Uint8Array): Generator<Uint8Array> {
	const bits = new Bits(input);
	let streams = 0;
	while (streams === 0 || !bits.atEnd()) {
		if (bits.read(8) !== 0x42 || bits.read(8) !== 0x5a || bits.read(8) !== 0x68)
			fail("not bzip2 data");
		const level = bits.read(8) - 0x30;
		if (level < 1 || level > 9) fail("bad block size");
		const tt = new Uint32Array(level * 100_000);
		let combined = 0;
		for (;;) {
			const hi = bits.read(24);
			const lo = bits.read(24);
			const stored = bits.read32();
			if (hi === END_MAGIC_HI && lo === END_MAGIC_LO) {
				if (stored !== combined) fail("the stream CRC does not match");
				bits.align();
				break;
			}
			if (hi !== BLOCK_MAGIC_HI || lo !== BLOCK_MAGIC_LO)
				fail("bad block magic");
			const { length, origin } = readBlock(bits, tt);
			const block = writeBlock(tt, length, origin);
			if (blockCrc(block, block.length) !== stored)
				fail("a block CRC does not match");
			combined = (((combined << 1) | (combined >>> 31)) ^ stored) >>> 0;
			yield block;
		}
		streams += 1;
	}
}
