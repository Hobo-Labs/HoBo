import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

/**
 * The cursor an MCP caller holds, in place of a journal position.
 *
 * A position is the journal's own sequence, and the journal holds every
 * account's events: handed out as a number, the gap between two cursors would
 * tell one account how much the others had journalled. So a cursor is the
 * position enciphered under a key derived for the account. It says nothing
 * about the position, it cannot be compared with another account's, and one
 * that was not issued here for this account does not decipher.
 */
export type CursorCodec = Readonly<{
	encode(position: number): string;
	/** The position a cursor stands for; undefined when it is not one of ours. */
	decode(cursor: string): number | undefined;
}>;

/** The one literal cursor: read from the start of the account's journal. */
// public-contract: the documented cursor for reading an account's journal from its start.
export const CURSOR_START = "0";

const MARK = Buffer.from("hobo.cur", "ascii");
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** A codec per account, from one secret the relay's hosts share. */
export function createCursorCodecs(
	secret: string,
): (accountId: string) => CursorCodec {
	if (Buffer.byteLength(secret, "utf8") < 32)
		throw new Error("cursor secret must have at least 32 bytes");
	return (accountId) => {
		// The secret is never the key: each account's key is derived from it,
		// for this purpose only.
		const key = Buffer.from(
			hkdfSync(
				"sha256",
				secret,
				Buffer.alloc(0),
				`hobo-ci-mcp-cursor:${accountId}`,
				16,
			),
		);
		return {
			encode(position) {
				if (!Number.isSafeInteger(position) || position < 0)
					throw new Error("journal position out of range");
				// One block: a mark that only a cursor issued here carries, then
				// the position. A position enciphers to the same cursor each time.
				const block = Buffer.alloc(16);
				MARK.copy(block);
				block.writeBigUInt64BE(BigInt(position), 8);
				const cipher = createCipheriv("aes-128-ecb", key, null);
				cipher.setAutoPadding(false);
				return Buffer.concat([cipher.update(block), cipher.final()]).toString(
					"base64url",
				);
			},
			decode(cursor) {
				if (cursor === CURSOR_START) return 0;
				if (!TOKEN.test(cursor)) return undefined;
				const decipher = createDecipheriv("aes-128-ecb", key, null);
				decipher.setAutoPadding(false);
				const block = Buffer.concat([
					decipher.update(Buffer.from(cursor, "base64url")),
					decipher.final(),
				]);
				if (block.length !== 16 || !block.subarray(0, 8).equals(MARK))
					return undefined;
				const position = block.readBigUInt64BE(8);
				return position <= BigInt(Number.MAX_SAFE_INTEGER)
					? Number(position)
					: undefined;
			},
		};
	};
}
