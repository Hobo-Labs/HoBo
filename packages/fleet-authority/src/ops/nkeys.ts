// Ed25519 keys as raw seeds, and their NATS nkey text form (seed `S…`,
// public `O…` for operators, `A…` for accounts): base32 without padding over
// the role prefix, the 32 key bytes and a CRC-16/XMODEM, little endian.
// Private to L27; the ceremony and rotation create keys only through here.
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	randomBytes,
	sign,
} from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

// public-contract: the nkeys role prefixes (nats-io/nkeys) the server parses.
export const NKEY_ROLE = {
	seed: 18 << 3,
	operator: 14 << 3,
	account: 0,
} as const;

export type NkeyRole = "operator" | "account";

export function crc16(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit += 1)
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

export function base32(bytes: Uint8Array): string {
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

export function unbase32(text: string): Uint8Array | undefined {
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

/** A fresh raw Ed25519 seed. */
export function freshSeed(): Uint8Array {
	return new Uint8Array(randomBytes(32));
}

export function privateKeyOf(seed: Uint8Array): KeyObject {
	return createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519, seed]),
		format: "der",
		type: "pkcs8",
	});
}

/** The raw 32-byte public key of a seed. */
export function rawPublicKey(seed: Uint8Array): Uint8Array {
	return new Uint8Array(
		createPublicKey(privateKeyOf(seed))
			.export({ format: "der", type: "spki" })
			.subarray(-32),
	);
}

export function signWithSeed(seed: Uint8Array, bytes: Uint8Array): Uint8Array {
	return new Uint8Array(sign(null, bytes, privateKeyOf(seed)));
}

export function encodeNkeySeed(role: NkeyRole, seed: Uint8Array): string {
	const prefix = NKEY_ROLE[role];
	const body = new Uint8Array(2 + seed.length);
	body[0] = NKEY_ROLE.seed | (prefix >> 5);
	body[1] = (prefix & 31) << 3;
	body.set(seed, 2);
	return base32(withCrc(body));
}

export function encodeNkeyPublic(role: NkeyRole, seed: Uint8Array): string {
	const body = new Uint8Array(33);
	body[0] = NKEY_ROLE[role];
	body.set(rawPublicKey(seed), 1);
	return base32(withCrc(body));
}

/** The role and raw seed of an nkey seed text; undefined when the text is not one, or its checksum fails. */
export function decodeNkeySeed(
	text: string,
): Readonly<{ role: NkeyRole; seed: Uint8Array }> | undefined {
	const full = unbase32(text);
	if (full === undefined || full.length !== 36) return undefined;
	const body = full.subarray(0, 34);
	const crc = (full[34] ?? 0) | ((full[35] ?? 0) << 8);
	if (crc16(body) !== crc) return undefined;
	const first = body[0] ?? 0;
	if ((first & 0xf8) !== NKEY_ROLE.seed) return undefined;
	const prefix = ((first & 7) << 5) | ((body[1] ?? 0) >> 3);
	const role: NkeyRole | undefined =
		prefix === NKEY_ROLE.operator
			? "operator"
			: prefix === NKEY_ROLE.account
				? "account"
				: undefined;
	if (role === undefined) return undefined;
	return { role, seed: new Uint8Array(body.subarray(2)) };
}

/**
 * A NATS operator JWT (v2) naming `signingKeys`, signed by the operator key.
 * The ceremony is the only place the operator key exists; this is its one use.
 */
export function operatorJwt(
	operatorSeed: Uint8Array,
	name: string,
	signingKeys: readonly string[],
	issuedAtMs: number,
): string {
	const issuer = encodeNkeyPublic("operator", operatorSeed);
	const claims = {
		jti: "",
		iat: Math.floor(issuedAtMs / 1_000),
		iss: issuer,
		name,
		sub: issuer,
		nats: { signing_keys: [...signingKeys], type: "operator", version: 2 },
	};
	claims.jti = base32(
		createHash("sha256").update(JSON.stringify(claims)).digest(),
	);
	const header = Buffer.from(
		JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" }),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = signWithSeed(
		operatorSeed,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}
