/**
 * The protobuf wire form of the two fleet records the overlay transport
 * moves (design §7.1): `SignedEnvelope`, which the dialler presents, and
 * `SessionGrant`, which the acceptor reads from the envelope's payload.
 *
 * `@hobo/connectivity` takes only `@hobo/fleet` and `@hobo/core` (design
 * §11.2 step 6), so the protobuf runtime is not available here. This is the
 * proto3 binary encoding for exactly these messages: varint and
 * length-delimited fields, unknown fields skipped, a malformed message
 * refused. Field numbers follow `packages/fleet/data-models/fleet.proto`.
 */
import type {
	KeyAlgorithm,
	SessionGrant,
	SessionParty,
	SessionPurpose,
	SignedEnvelope,
} from "@hobo/fleet";

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class Writer {
	readonly #parts: number[] = [];

	varint(value: number): void {
		let rest = value >>> 0;
		while (rest > 0x7f) {
			this.#parts.push((rest & 0x7f) | 0x80);
			rest >>>= 7;
		}
		this.#parts.push(rest);
	}

	bytes(field: number, value: Uint8Array): void {
		if (value.length === 0) return;
		this.varint((field << 3) | LENGTH);
		this.varint(value.length);
		for (const byte of value) this.#parts.push(byte);
	}

	/** A length-delimited field written even when empty (a set sub-message, a repeated string). */
	message(field: number, value: Uint8Array): void {
		this.varint((field << 3) | LENGTH);
		this.varint(value.length);
		for (const byte of value) this.#parts.push(byte);
	}

	string(field: number, value: string): void {
		this.bytes(field, encoder.encode(value));
	}

	enumeration(field: number, value: number): void {
		if (value === 0) return;
		this.varint((field << 3) | VARINT);
		this.varint(value);
	}

	finish(): Uint8Array {
		return Uint8Array.from(this.#parts);
	}
}

type Field = Readonly<
	| { number: number; kind: "varint"; value: number }
	| { number: number; kind: "bytes"; value: Uint8Array }
>;

/** Every field of one message, in order; throws on a malformed message. */
function fieldsOf(bytes: Uint8Array): readonly Field[] {
	const fields: Field[] = [];
	let offset = 0;
	const varint = (): number => {
		let value = 0;
		for (let shift = 0; shift < 64; shift += 7) {
			const byte = bytes[offset];
			if (byte === undefined) throw new Error("a varint is truncated");
			offset += 1;
			if (shift < 32) value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) return value;
		}
		throw new Error("a varint is too long");
	};
	while (offset < bytes.length) {
		const key = varint();
		const number = Math.floor(key / 8);
		const wire = key % 8;
		if (number === 0) throw new Error("field number 0");
		if (wire === VARINT) {
			fields.push({ number, kind: "varint", value: varint() });
		} else if (wire === LENGTH) {
			const length = varint();
			if (offset + length > bytes.length)
				throw new Error("a field is truncated");
			fields.push({
				number,
				kind: "bytes",
				value: bytes.subarray(offset, offset + length),
			});
			offset += length;
		} else if (wire === FIXED64 || wire === FIXED32) {
			offset += wire === FIXED64 ? 8 : 4;
			if (offset > bytes.length) throw new Error("a field is truncated");
		} else {
			throw new Error(`unsupported wire type ${wire}`);
		}
	}
	return fields;
}

/** Proto3 semantics: the last occurrence of a singular field wins. */
function last(
	fields: readonly Field[],
	number: number,
	kind: Field["kind"],
): Field | undefined {
	let found: Field | undefined;
	for (const field of fields) {
		if (field.number !== number) continue;
		if (field.kind !== kind)
			throw new Error(`field ${number} has a wrong type`);
		found = field;
	}
	return found;
}

function bytesField(fields: readonly Field[], number: number): Uint8Array {
	const field = last(fields, number, "bytes");
	return field?.kind === "bytes" ? field.value.slice() : new Uint8Array(0);
}

function stringField(fields: readonly Field[], number: number): string {
	const field = last(fields, number, "bytes");
	return field?.kind === "bytes" ? decoder.decode(field.value) : "";
}

function numberField(fields: readonly Field[], number: number): number {
	const field = last(fields, number, "varint");
	return field?.kind === "varint" ? field.value : 0;
}

function messageField<T>(
	fields: readonly Field[],
	number: number,
	decode: (bytes: Uint8Array) => T,
): T | undefined {
	const field = last(fields, number, "bytes");
	return field?.kind === "bytes" ? decode(field.value) : undefined;
}

export function encodeSignedEnvelope(envelope: SignedEnvelope): Uint8Array {
	const writer = new Writer();
	writer.string(1, envelope.context);
	writer.string(2, envelope.keyId);
	writer.enumeration(3, envelope.algorithm);
	writer.bytes(4, envelope.payload);
	writer.bytes(5, envelope.signature);
	return writer.finish();
}

function encodeSessionParty(party: SessionParty): Uint8Array {
	const writer = new Writer();
	writer.string(1, party.memberId);
	writer.string(2, party.principal);
	writer.string(3, party.transportIdentity);
	writer.string(4, party.sealPublicKey);
	return writer.finish();
}

export function encodeSessionGrant(grant: SessionGrant): Uint8Array {
	const writer = new Writer();
	writer.string(1, grant.sessionId);
	writer.string(2, grant.tenant);
	if (grant.initiator !== undefined)
		writer.message(3, encodeSessionParty(grant.initiator));
	if (grant.acceptor !== undefined)
		writer.message(4, encodeSessionParty(grant.acceptor));
	writer.enumeration(5, grant.purpose);
	writer.string(6, grant.orderId);
	writer.enumeration(7, grant.port);
	for (const digest of grant.blobDigests)
		writer.message(8, encoder.encode(digest));
	writer.string(9, grant.issuedAt);
	writer.string(10, grant.expiresAt);
	return writer.finish();
}

export function decodeSignedEnvelope(bytes: Uint8Array): SignedEnvelope {
	const fields = fieldsOf(bytes);
	return {
		// public-contract: the protobuf type name of hobo.fleet.v1.SignedEnvelope.
		$typeName: "hobo.fleet.v1.SignedEnvelope",
		context: stringField(fields, 1),
		keyId: stringField(fields, 2),
		// SAFETY: a proto3 enum field is an open enum; an unknown value stays its number, as the protobuf runtime keeps it.
		algorithm: numberField(fields, 3) as KeyAlgorithm,
		payload: bytesField(fields, 4),
		signature: bytesField(fields, 5),
	};
}

function decodeSessionParty(bytes: Uint8Array): SessionParty {
	const fields = fieldsOf(bytes);
	return {
		// public-contract: the protobuf type name of hobo.fleet.v1.SessionParty.
		$typeName: "hobo.fleet.v1.SessionParty",
		memberId: stringField(fields, 1),
		principal: stringField(fields, 2),
		transportIdentity: stringField(fields, 3),
		sealPublicKey: stringField(fields, 4),
	};
}

export function decodeSessionGrant(bytes: Uint8Array): SessionGrant {
	const fields = fieldsOf(bytes);
	const blobDigests: string[] = [];
	for (const field of fields)
		if (field.number === 8) {
			if (field.kind !== "bytes") throw new Error("field 8 has a wrong type");
			blobDigests.push(decoder.decode(field.value));
		}
	return {
		// public-contract: the protobuf type name of hobo.fleet.v1.SessionGrant.
		$typeName: "hobo.fleet.v1.SessionGrant",
		sessionId: stringField(fields, 1),
		tenant: stringField(fields, 2),
		initiator: messageField(fields, 3, decodeSessionParty),
		acceptor: messageField(fields, 4, decodeSessionParty),
		// SAFETY: a proto3 enum field is an open enum; an unknown value stays its number, as the protobuf runtime keeps it.
		purpose: numberField(fields, 5) as SessionPurpose,
		orderId: stringField(fields, 6),
		port: numberField(fields, 7),
		blobDigests,
		issuedAt: stringField(fields, 9),
		expiresAt: stringField(fields, 10),
	};
}
