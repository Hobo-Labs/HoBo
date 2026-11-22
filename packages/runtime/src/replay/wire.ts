import { ReplayParseError } from "./parse.js";

type MessageKind = "report" | "divergence" | "entry";
interface Varint {
	value: bigint;
	next: number;
}

/** Check fields whose truncation would change the meaning of replay evidence. */
export function checkReplayWire(bytes: Uint8Array, kind: MessageKind): void {
	let offset = 0;
	while (offset < bytes.length) {
		const tag = readVarint(bytes, offset);
		offset = tag.next;
		if (tag.value === 0n || tag.value > 0xffffffffn)
			throw new ReplayParseError("invalid protobuf field tag");
		const field = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 7n);
		if (field === 0) throw new ReplayParseError("invalid protobuf field tag");
		if (kind === "report" && field === 2 && wireType !== 2)
			throw new ReplayParseError("invalid protobuf sequence vector");
		if (kind === "entry" && field === 2 && wireType !== 0)
			throw new ReplayParseError("invalid protobuf sequence");

		if (wireType === 0) {
			const value = readVarint(bytes, offset);
			offset = value.next;
			if (
				kind === "entry" &&
				field === 2 &&
				value.value > BigInt(Number.MAX_SAFE_INTEGER)
			)
				throw new ReplayParseError("seq must be a safe integer");
		} else if (wireType === 1 || wireType === 5) {
			offset += wireType === 1 ? 8 : 4;
			if (offset > bytes.length)
				throw new ReplayParseError("truncated protobuf field");
		} else if (wireType === 2) {
			const length = readVarint(bytes, offset);
			offset = length.next;
			if (length.value > BigInt(bytes.length - offset))
				throw new ReplayParseError("truncated protobuf field");
			const end = offset + Number(length.value);
			if (kind === "report" && field === 2)
				checkReplayWire(bytes.subarray(offset, end), "entry");
			offset = end;
		} else {
			// Deprecated groups are refused rather than interpreted recursively.
			throw new ReplayParseError("unsupported protobuf wire type");
		}
	}
}

function readVarint(bytes: Uint8Array, start: number): Varint {
	let value = 0n;
	for (let index = 0; index < 10; index += 1) {
		const byte = bytes[start + index];
		if (byte === undefined)
			throw new ReplayParseError("truncated protobuf varint");
		if (index === 9 && byte > 1)
			throw new ReplayParseError("protobuf varint exceeds uint64");
		value |= BigInt(byte & 127) << BigInt(index * 7);
		if ((byte & 128) === 0) return { value, next: start + index + 1 };
	}
	throw new ReplayParseError("protobuf varint exceeds uint64");
}
