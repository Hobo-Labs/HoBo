/**
 * Content-addressed blob transfer (design §6.12 "Blob transfer"): SHA-256,
 * verified by the receiver. `fetchBlob` yields the bytes as they arrive and
 * fails before completing if they do not match the digest.
 */
import { createHash } from "node:crypto";
import type { FleetStream } from "../ports.js";
import { readMessages, SESSION_TAG, writeMessage } from "./wire.js";

const SHA256 = /^sha256:([0-9a-f]{64})$/;
const decoder = new TextDecoder();

/** The hex of a `sha256:<hex>` digest, or undefined. */
export function digestHex(digest: string): string | undefined {
	return SHA256.exec(digest)?.[1];
}

/** Where an order's sandbox holds the blob with this digest (§6.12, decided by L28). */
export function blobPath(hex: string): string {
	return `/hobo/blobs/sha256/${hex}`;
}

export async function* fetchVerified(
	stream: FleetStream,
	digest: string,
): AsyncGenerator<Uint8Array> {
	const hex = digestHex(digest);
	if (hex === undefined) throw new Error("a blob digest is sha256:<hex>");
	await writeMessage(
		stream,
		SESSION_TAG.REQUEST,
		new TextEncoder().encode(digest),
	);
	const hash = createHash("sha256");
	for await (const message of readMessages(stream)) {
		switch (message.tag) {
			case SESSION_TAG.OUTPUT:
				hash.update(message.payload);
				yield message.payload;
				break;
			case SESSION_TAG.END:
				if (hash.digest("hex") !== hex)
					throw new Error(`the blob does not match its digest ${digest}`);
				return;
			case SESSION_TAG.ERROR:
				throw new Error(
					`the blob was refused: ${decoder.decode(message.payload)}`,
				);
			default:
				throw new Error("an unexpected message in a blob session");
		}
	}
	throw new Error("the blob session ended before the blob did");
}
