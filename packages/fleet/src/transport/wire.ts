/**
 * The session protocol spoken over an accepted stream (private to this lane):
 * messages of a 1-byte tag, a 4-byte big-endian length and a payload.
 *
 * - Shell and forward: the initiator sends `INPUT` chunks and `END`; the
 *   acceptor runs the command in the order's sandbox with that input, sends
 *   its output as `OUTPUT` chunks and then `EXIT` (a 4-byte signed exit code),
 *   or `ERROR` (UTF-8 reason).
 * - Blob: the initiator sends one `REQUEST` with the digest (`sha256:<hex>`);
 *   the acceptor answers `OUTPUT` chunks and `END`, or `ERROR`.
 */
import type { FleetStream } from "../ports.js";

export const SESSION_TAG = {
	REQUEST: 1,
	INPUT: 2,
	END: 3,
	OUTPUT: 4,
	EXIT: 5,
	ERROR: 6,
} as const;
export type SessionTag = (typeof SESSION_TAG)[keyof typeof SESSION_TAG];

const TAGS: ReadonlySet<number> = new Set(Object.values(SESSION_TAG));
const HEADER_BYTES = 5;
/** The largest payload of one message; longer `INPUT` and `OUTPUT` are split. */
export const MAX_MESSAGE_PAYLOAD = 1024 * 1024;

export type SessionMessage = Readonly<{ tag: SessionTag; payload: Uint8Array }>;

function isTag(value: number): value is SessionTag {
	return TAGS.has(value);
}

export async function writeMessage(
	stream: FleetStream,
	tag: SessionTag,
	payload: Uint8Array,
): Promise<void> {
	const splittable = tag === SESSION_TAG.INPUT || tag === SESSION_TAG.OUTPUT;
	if (payload.length > MAX_MESSAGE_PAYLOAD && !splittable)
		throw new Error("a session message is too large");
	let offset = 0;
	do {
		const piece = payload.subarray(offset, offset + MAX_MESSAGE_PAYLOAD);
		const header = Buffer.alloc(HEADER_BYTES);
		header.writeUInt8(tag, 0);
		header.writeUInt32BE(piece.length, 1);
		await stream.write(new Uint8Array(Buffer.concat([header, piece])));
		offset += piece.length;
	} while (offset < payload.length);
}

/** Every message on the stream, in order; fails on an unknown tag, an oversized or a truncated message. */
export async function* readMessages(
	stream: FleetStream,
): AsyncGenerator<SessionMessage> {
	let pending: Buffer = Buffer.alloc(0);
	for await (const chunk of stream.read()) {
		pending =
			pending.length === 0
				? Buffer.from(chunk)
				: Buffer.concat([pending, chunk]);
		while (pending.length >= HEADER_BYTES) {
			const tag = pending.readUInt8(0);
			const length = pending.readUInt32BE(1);
			if (!isTag(tag)) throw new Error("an unknown session message");
			if (length > MAX_MESSAGE_PAYLOAD)
				throw new Error("a session message is too large");
			if (pending.length < HEADER_BYTES + length) break;
			const payload = new Uint8Array(
				pending.subarray(HEADER_BYTES, HEADER_BYTES + length),
			);
			pending = pending.subarray(HEADER_BYTES + length);
			yield { tag, payload };
		}
	}
	if (pending.length > 0) throw new Error("a session message was truncated");
}

export function exitPayload(code: number): Uint8Array {
	const payload = Buffer.alloc(4);
	payload.writeInt32BE(code, 0);
	return new Uint8Array(payload);
}
