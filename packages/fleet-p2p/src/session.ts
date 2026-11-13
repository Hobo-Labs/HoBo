/**
 * The bytes of one p2p session on one QUIC stream (L11).
 *
 * The dialler opens one bidirectional stream and writes the grant frame: a
 * 4-byte big-endian length and the `SignedEnvelope` of the `SessionGrant`. The
 * acceptor reads that frame, asks `authorise` with the peer's proven endpoint
 * id, and writes one byte, `ACCEPTED`, only when the session is allowed;
 * anything else ends the connection. Payload flows after that byte, and
 * neither side hands a payload byte on before it.
 *
 * `openSession` wraps the stream as a `FleetStream` that counts payload bytes
 * only. `close` ends the send side, waits briefly for it to be acknowledged,
 * and answers the counts at once; the connection itself is closed once the
 * peer has ended its side too (or after a linger bound), so an answer written
 * just before `close` is not lost with the connection.
 */
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type FleetStream,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "@hobo/fleet";
import type { DuplexStream, EndpointConnection } from "./endpoint.js";

export const ACCEPTED = 0x01;
/** The largest grant frame either side writes or reads. */
export const MAX_GRANT_BYTES = 64 * 1024;
const READ_BYTES = 1024 * 1024;
const FLUSH_MS = 2_000;
const LINGER_MS = 30_000;

/** Encodes `grant` as the session's first frame; undefined when it is too large. */
export function encodeGrantFrame(
	grant: SignedEnvelope,
): Uint8Array | undefined {
	const body = toBinary(SignedEnvelopeSchema, grant);
	if (body.length === 0 || body.length > MAX_GRANT_BYTES) return undefined;
	const frame = new Uint8Array(4 + body.length);
	new DataView(frame.buffer).setUint32(0, body.length);
	frame.set(body, 4);
	return frame;
}

/** Serialised reads over a stream, with exact-length reads for the handshake. A read error is end-of-stream. */
export type Receiver = Readonly<{
	next(): Promise<Uint8Array | undefined>;
	exact(count: number): Promise<Uint8Array | undefined>;
}>;

export function createReceiver(stream: DuplexStream): Receiver {
	let tail: Promise<unknown> = Promise.resolve();
	let leftover = new Uint8Array(0);
	let ended = false;
	const pull = async (): Promise<Uint8Array | undefined> => {
		if (leftover.length > 0) {
			const chunk = leftover;
			leftover = new Uint8Array(0);
			return chunk;
		}
		if (ended) return undefined;
		try {
			const chunk = await stream.read(READ_BYTES);
			if (chunk.length > 0) return chunk;
		} catch {
			// A lost connection ends the stream as an orderly end would.
		}
		ended = true;
		return undefined;
	};
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = tail.then(task);
		tail = run.catch(() => undefined);
		return run;
	};
	return {
		next: () => serial(pull),
		exact: (count) =>
			serial(async () => {
				const out = new Uint8Array(count);
				let got = 0;
				while (got < count) {
					const chunk = await pull();
					if (chunk === undefined) return undefined;
					const used = chunk.subarray(0, count - got);
					out.set(used, got);
					got += used.length;
					if (used.length < chunk.length) leftover = chunk.slice(used.length);
				}
				return out;
			}),
	};
}

/** Reads the grant frame; undefined when it is malformed, oversized or cut short. */
export async function readGrantFrame(
	receiver: Receiver,
): Promise<SignedEnvelope | undefined> {
	const header = await receiver.exact(4);
	if (header === undefined) return undefined;
	const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0);
	if (length === 0 || length > MAX_GRANT_BYTES) return undefined;
	const body = await receiver.exact(length);
	if (body === undefined) return undefined;
	try {
		return fromBinary(SignedEnvelopeSchema, body);
	} catch {
		return undefined;
	}
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export function openSession(
	input: Readonly<{
		peer: string;
		connection: EndpointConnection;
		stream: DuplexStream;
		receiver: Receiver;
	}>,
): FleetStream {
	const { connection, stream, receiver } = input;
	let bytesSent = 0;
	let bytesReceived = 0;
	let closing:
		| Promise<Readonly<{ bytesSent: number; bytesReceived: number }>>
		| undefined;

	/** Once this side has closed: read the peer's remaining bytes away, then end the connection. */
	const linger = async () => {
		const deadline = pause(LINGER_MS).then(() => "late" as const);
		for (;;) {
			const next = await Promise.race([receiver.next(), deadline]);
			if (next === undefined || next === "late") break;
		}
		connection.close();
	};

	return {
		peer: input.peer,
		async *read() {
			while (closing === undefined) {
				const chunk = await receiver.next();
				if (chunk === undefined || closing !== undefined) return;
				bytesReceived += chunk.length;
				yield chunk;
			}
		},
		async write(chunk) {
			if (closing !== undefined) throw new Error("the p2p stream is closed");
			await stream.write(chunk);
			bytesSent += chunk.length;
		},
		close() {
			closing ??= (async () => {
				const counts = { bytesSent, bytesReceived };
				try {
					await stream.finish();
					await stream.flushed(FLUSH_MS);
				} catch {
					// The connection is already gone; the counts stand.
				}
				void linger();
				return counts;
			})();
			return closing;
		},
	};
}
