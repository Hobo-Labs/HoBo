import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

export type CursorCodec = Readonly<{
	encode(position: number): string;
	decode(cursor: string): number | undefined;
}>;

// public-contract: the documented cursor for reading an account's journal from its start.
export const CURSOR_START = "0";

const MARK = Buffer.from("hobo.cur", "ascii");
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

export function createCursorCodecs(
	secret: string,
): (accountId: string) => CursorCodec {
	if (Buffer.byteLength(secret, "utf8") < 32)
		throw new Error("cursor secret must have at least 32 bytes");
	return (accountId) => {
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
