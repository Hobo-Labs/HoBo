/**
 * The NATS nkey text forms `hobo fleet ops provision` writes into the
 * operations' key slots (design §6.16; the slot layout of
 * @hobo/fleet-authority's operations): seeds `S…` and public keys (`A…`
 * accounts, `X…` curve keys) are base32 without padding over the role
 * prefix, the 32 key bytes and a CRC-16/XMODEM, little endian.
 */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

// public-contract: the nkeys role prefixes (nats-io/nkeys) the server parses.
const ROLE = { seed: 18 << 3, account: 0, curve: 23 << 3 } as const;

export type NkeyRole = "account" | "curve";

function crc16(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit += 1)
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

function base32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = ((buffer << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
	return out;
}

function unbase32(text: string): Uint8Array | undefined {
	const out: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const char of text) {
		const value = BASE32.indexOf(char);
		if (value < 0) return undefined;
		buffer = ((buffer << 5) | value) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((buffer >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Uint8Array.from(out);
}

function withCrc(body: Uint8Array): Uint8Array {
	const crc = crc16(body);
	const full = new Uint8Array(body.length + 2);
	full.set(body);
	full[body.length] = crc & 0xff;
	full[body.length + 1] = crc >> 8;
	return full;
}

function rawPublicKey(role: NkeyRole, seed: Uint8Array): Uint8Array {
	const privateKey = createPrivateKey({
		key: Buffer.concat([role === "curve" ? PKCS8_X25519 : PKCS8_ED25519, seed]),
		format: "der",
		type: "pkcs8",
	});
	return new Uint8Array(
		createPublicKey(privateKey)
			.export({ format: "der", type: "spki" })
			.subarray(-32),
	);
}

export function encodeSeed(role: NkeyRole, seed: Uint8Array): string {
	const prefix = ROLE[role];
	const body = new Uint8Array(34);
	body[0] = ROLE.seed | (prefix >> 5);
	body[1] = (prefix & 31) << 3;
	body.set(seed, 2);
	return base32(withCrc(body));
}

export function encodePublic(role: NkeyRole, seed: Uint8Array): string {
	const body = new Uint8Array(33);
	body[0] = ROLE[role];
	body.set(rawPublicKey(role, seed), 1);
	return base32(withCrc(body));
}

/** The role and raw seed of a seed text; undefined when it is not one of these roles or its checksum fails. */
export function decodeSeed(
	text: string,
): Readonly<{ role: NkeyRole; seed: Uint8Array }> | undefined {
	const full = unbase32(text);
	if (full === undefined || full.length !== 36) return undefined;
	const body = full.subarray(0, 34);
	if (crc16(body) !== ((full[34] ?? 0) | ((full[35] ?? 0) << 8)))
		return undefined;
	const first = body[0] ?? 0;
	if ((first & 0xf8) !== ROLE.seed) return undefined;
	const prefix = ((first & 7) << 5) | ((body[1] ?? 0) >> 3);
	const role: NkeyRole | undefined =
		prefix === ROLE.account
			? "account"
			: prefix === ROLE.curve
				? "curve"
				: undefined;
	return role === undefined
		? undefined
		: { role, seed: new Uint8Array(body.subarray(2)) };
}

/** The public key text of an account or curve seed text. */
export function publicOfSeed(text: string): string | undefined {
	const decoded = decodeSeed(text);
	return decoded === undefined
		? undefined
		: encodePublic(decoded.role, decoded.seed);
}

/** A fresh curve (xkey) seed text, for the callout responder. */
export function freshCurveSeed(): string {
	return encodeSeed("curve", new Uint8Array(randomBytes(32)));
}
