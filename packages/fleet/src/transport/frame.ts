/**
 * AEAD framing over a raw `FleetStream` (design §6.12, §7.4): each frame is a
 * 4-byte big-endian length and a ChaCha20-Poly1305 ciphertext with its
 * 16-byte tag. The 12-byte nonce is four zero bytes and a 64-bit big-endian
 * counter, one counter per direction, so every frame's position is
 * authenticated: a reordered, replayed or dropped frame fails. Each direction
 * has its own key (`sessionKeys`), so the two counters never share a key.
 *
 * An empty frame marks the end of the stream; a raw stream that ends without
 * it was truncated, and reading fails. Empty writes are therefore no-ops.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { FleetStream } from "../ports.js";

const ALGORITHM = "chacha20-poly1305";
const TAG_BYTES = 16;
const HEADER_BYTES = 4;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
/** The largest plaintext in one frame; longer writes are split. */
export const MAX_FRAME_PLAINTEXT = 64 * 1024;

function nonceFor(counter: bigint): Buffer {
	const nonce = Buffer.alloc(NONCE_BYTES);
	nonce.writeBigUInt64BE(counter, NONCE_BYTES - 8);
	return nonce;
}

function sealFrame(
	key: Uint8Array,
	counter: bigint,
	plaintext: Uint8Array,
): Buffer {
	const cipher = createCipheriv(ALGORITHM, key, nonceFor(counter), {
		authTagLength: TAG_BYTES,
	});
	const body = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const header = Buffer.alloc(HEADER_BYTES);
	header.writeUInt32BE(body.length, 0);
	return Buffer.concat([header, body]);
}

function openFrame(
	key: Uint8Array,
	counter: bigint,
	body: Uint8Array,
): Uint8Array {
	const decipher = createDecipheriv(ALGORITHM, key, nonceFor(counter), {
		authTagLength: TAG_BYTES,
	});
	decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
	try {
		return new Uint8Array(
			Buffer.concat([
				decipher.update(body.subarray(0, body.length - TAG_BYTES)),
				decipher.final(),
			]),
		);
	} catch {
		throw new Error("a session frame failed authentication");
	}
}

export function framedStream(
	raw: FleetStream,
	keys: Readonly<{ send: Uint8Array; receive: Uint8Array }>,
): FleetStream {
	if (keys.send.length !== KEY_BYTES || keys.receive.length !== KEY_BYTES)
		throw new Error("session keys are 32 bytes each");
	const send = keys.send.slice();
	const receive = keys.receive.slice();
	let sendCounter = 0n;
	let receiveCounter = 0n;
	let bytesSent = 0;
	let bytesReceived = 0;
	let ended = false;
	let closed:
		| Promise<Readonly<{ bytesSent: number; bytesReceived: number }>>
		| undefined;
	let source: AsyncIterator<Uint8Array> | undefined;
	let pending: Buffer = Buffer.alloc(0);

	/** The next complete frame body from the raw stream, or undefined when it ended. */
	const nextBody = async (): Promise<Uint8Array | undefined> => {
		source ??= raw.read()[Symbol.asyncIterator]();
		for (;;) {
			if (pending.length >= HEADER_BYTES) {
				const length = pending.readUInt32BE(0);
				if (length < TAG_BYTES || length > MAX_FRAME_PLAINTEXT + TAG_BYTES)
					throw new Error("a session frame has an invalid length");
				if (pending.length >= HEADER_BYTES + length) {
					const body = pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
					pending = pending.subarray(HEADER_BYTES + length);
					return body;
				}
			}
			const next = await source.next();
			if (next.done === true) return undefined;
			pending =
				pending.length === 0
					? Buffer.from(next.value)
					: Buffer.concat([pending, next.value]);
		}
	};

	return {
		peer: raw.peer,
		async *read() {
			while (!ended) {
				const body = await nextBody();
				if (body === undefined)
					throw new Error("the session stream was truncated");
				const plaintext = openFrame(receive, receiveCounter, body);
				receiveCounter += 1n;
				if (plaintext.length === 0) {
					ended = true;
					return;
				}
				bytesReceived += plaintext.length;
				yield plaintext;
			}
		},
		async write(chunk) {
			if (closed !== undefined) throw new Error("the session stream is closed");
			for (
				let offset = 0;
				offset < chunk.length;
				offset += MAX_FRAME_PLAINTEXT
			) {
				const piece = chunk.subarray(offset, offset + MAX_FRAME_PLAINTEXT);
				const frame = sealFrame(send, sendCounter, piece);
				sendCounter += 1n;
				bytesSent += piece.length;
				await raw.write(frame);
			}
		},
		close() {
			closed ??= (async () => {
				const end = sealFrame(send, sendCounter, new Uint8Array(0));
				sendCounter += 1n;
				await raw.write(end).catch(() => undefined);
				await raw.close().catch(() => undefined);
				return Object.freeze({ bytesSent, bytesReceived });
			})();
			return closed;
		},
	};
}
