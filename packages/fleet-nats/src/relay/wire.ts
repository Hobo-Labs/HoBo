/**
 * The messages the bus-relay transport publishes on
 * `fleet.relay.<toMemberId>.<relaySessionId>` (design §6.12 item 3). A
 * message is one type byte and a body:
 *
 * - `OPEN` 1: a one-byte length and the dialler's member id (where answers
 *   go), then the presented grant envelope in protobuf binary.
 * - `DATA` 2: raw bytes of the session; the AEAD framing (`frameStream`)
 *   above this layer makes them ciphertext.
 * - `CREDIT` 3: a 32-bit big-endian count of bytes the sender may send more.
 * - `END` 4: the sender closed the session.
 * - `RESET` 5: the session is refused or abandoned.
 *
 * Nothing here is secret or authenticated: a forged `DATA` fails the framing's
 * authentication, and a forged `CREDIT`, `END` or `RESET` can only end a
 * session early, as dropping its messages could.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const RELAY_MESSAGE = {
	OPEN: 1,
	DATA: 2,
	CREDIT: 3,
	END: 4,
	RESET: 5,
} as const;

export type RelayMessage =
	| Readonly<{
			type: typeof RELAY_MESSAGE.OPEN;
			from: string;
			grant: Uint8Array;
	  }>
	| Readonly<{ type: typeof RELAY_MESSAGE.DATA; payload: Uint8Array }>
	| Readonly<{ type: typeof RELAY_MESSAGE.CREDIT; bytes: number }>
	| Readonly<{ type: typeof RELAY_MESSAGE.END }>
	| Readonly<{ type: typeof RELAY_MESSAGE.RESET }>;

const MAX_FROM_BYTES = 255;

/** The transport identity a bus-relay transport proves: possession of this SEAL key. */
export function relayIdentity(sealPublicKey: string): string {
	return `relay:${sealPublicKey}`;
}

export function encodeRelayMessage(message: RelayMessage): Uint8Array {
	switch (message.type) {
		case RELAY_MESSAGE.OPEN: {
			const from = encoder.encode(message.from);
			if (from.length === 0 || from.length > MAX_FROM_BYTES)
				throw new Error("the dialler's member id does not fit an OPEN message");
			const out = new Uint8Array(2 + from.length + message.grant.length);
			out[0] = RELAY_MESSAGE.OPEN;
			out[1] = from.length;
			out.set(from, 2);
			out.set(message.grant, 2 + from.length);
			return out;
		}
		case RELAY_MESSAGE.DATA: {
			const out = new Uint8Array(1 + message.payload.length);
			out[0] = RELAY_MESSAGE.DATA;
			out.set(message.payload, 1);
			return out;
		}
		case RELAY_MESSAGE.CREDIT: {
			const out = new Uint8Array(5);
			out[0] = RELAY_MESSAGE.CREDIT;
			new DataView(out.buffer).setUint32(1, message.bytes, false);
			return out;
		}
		case RELAY_MESSAGE.END:
		case RELAY_MESSAGE.RESET:
			return new Uint8Array([message.type]);
	}
}

/** The message `bytes` holds, or undefined when it is malformed. */
export function decodeRelayMessage(
	bytes: Uint8Array,
): RelayMessage | undefined {
	const type = bytes[0];
	switch (type) {
		case RELAY_MESSAGE.OPEN: {
			const length = bytes[1];
			if (length === undefined || length === 0 || bytes.length < 2 + length)
				return undefined;
			let from: string;
			try {
				from = decoder.decode(bytes.subarray(2, 2 + length));
			} catch {
				return undefined;
			}
			return { type, from, grant: bytes.slice(2 + length) };
		}
		case RELAY_MESSAGE.DATA:
			return { type, payload: bytes.subarray(1) };
		case RELAY_MESSAGE.CREDIT:
			if (bytes.length !== 5) return undefined;
			return {
				type,
				bytes: new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength,
				).getUint32(1, false),
			};
		case RELAY_MESSAGE.END:
		case RELAY_MESSAGE.RESET:
			return bytes.length === 1 ? { type } : undefined;
		default:
			return undefined;
	}
}
