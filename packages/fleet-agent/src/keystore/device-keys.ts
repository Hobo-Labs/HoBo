// Building `DeviceKeys` (design §6.4, §7.3) from an identity signer and the
// operational keys: SIGN (Ed25519) and SEAL (X25519), generated with
// node:crypto. Private keys stay in this module's closures and in the key
// directory; nothing returned carries them.
import {
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";
import type { JsonObject } from "@hobo/core";
import {
	type DeviceKeys,
	FLEET_CONTEXTS,
	KeyAlgorithm,
	type MemberId,
	type PublicJwk,
	parseKeyId,
	type SealedBox,
	type Signer,
} from "@hobo/fleet";
import {
	memberIdFromJwk,
	openSealedWith,
	parsePublicJwk,
} from "@hobo/fleet/keys";
import { isJsonObject, isJsonString, parseJsonText } from "./json.js";

/** The private operational keys of a device, as PKCS#8 PEM in the key directory. */
export type OperationalKeys = Readonly<{ sign: KeyObject; seal: KeyObject }>;

export function generateOperationalKeys(): OperationalKeys {
	return Object.freeze({
		sign: generateKeyPairSync("ed25519").privateKey,
		seal: generateKeyPairSync("x25519").privateKey,
	});
}

const pem = (key: KeyObject) =>
	String(key.export({ type: "pkcs8", format: "pem" }));

export function encodeOperationalKeys(keys: OperationalKeys): string {
	return `${JSON.stringify({ sign: pem(keys.sign), seal: pem(keys.seal) })}\n`;
}

function privateKeyOf(text: string, type: "ed25519" | "x25519"): KeyObject {
	const key = createPrivateKey(text);
	if (key.asymmetricKeyType !== type)
		throw new Error(
			`the operational key file holds a ${key.asymmetricKeyType} key, not ${type}`,
		);
	return key;
}

export function decodeOperationalKeys(text: string): OperationalKeys {
	const document = parseJsonText(text);
	if (
		!isJsonObject(document) ||
		!isJsonString(document.sign) ||
		!isJsonString(document.seal)
	)
		throw new Error("the operational key file is not valid");
	return Object.freeze({
		sign: privateKeyOf(document.sign, "ed25519"),
		seal: privateKeyOf(document.seal, "x25519"),
	});
}

/** The public JWK members of a key, in the order RFC 7638 lists them. */
export function publicJwkJson(jwk: PublicJwk): JsonObject {
	return jwk.kty === "EC"
		? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
		: { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

/** The public JWK of a node key, through `parsePublicJwk` so that private members can never pass. */
export function publicJwkOf(key: KeyObject): PublicJwk {
	const exported = (key.type === "public" ? key : createPublicKey(key)).export({
		format: "jwk",
	});
	const common = {
		kty: exported.kty ?? "",
		crv: exported.crv ?? "",
		x: exported.x ?? "",
	};
	const members: JsonObject =
		exported.y === undefined ? common : { ...common, y: exported.y };
	const parsed = parsePublicJwk(JSON.stringify(members));
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed.value;
}

export function algorithmOf(jwk: PublicJwk): KeyAlgorithm {
	return jwk.kty === "EC" ? KeyAlgorithm.ES256 : KeyAlgorithm.EDDSA;
}

/** Signs with a private key: ES256 signatures in IEEE P1363 form (r ‖ s), EdDSA over Ed25519. */
export function signingWith(
	privateKey: KeyObject,
): (bytes: Uint8Array) => Promise<Uint8Array> {
	const es256 = privateKey.asymmetricKeyType === "ec";
	return async (bytes) =>
		new Uint8Array(
			es256
				? sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" })
				: sign(null, bytes, privateKey),
		);
}

export function localSigner(keyId: string, privateKey: KeyObject): Signer {
	return Object.freeze({
		keyId: parseKeyId(keyId),
		algorithm:
			privateKey.asymmetricKeyType === "ec"
				? KeyAlgorithm.ES256
				: KeyAlgorithm.EDDSA,
		sign: signingWith(privateKey),
	} satisfies Signer);
}

/** The identity of a device: its public JWK and something that signs with it. */
export type Identity = Readonly<{
	jwk: PublicJwk;
	sign(bytes: Uint8Array): Promise<Uint8Array>;
}>;

export function memberIdOf(identity: Identity): MemberId {
	return memberIdFromJwk(identity.jwk);
}

function rawX25519(raw: string): KeyObject {
	const bytes = Buffer.from(raw, "base64url");
	if (bytes.length !== 32 || bytes.toString("base64url") !== raw)
		throw new Error("the peer key is not a raw X25519 key");
	return createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: raw },
		format: "jwk",
	});
}

export function deviceKeysOf(
	identity: Identity,
	operational: OperationalKeys,
	heldKey: boolean,
): DeviceKeys {
	const memberId = memberIdOf(identity);
	const identityKeyId = parseKeyId(`${memberId}#identity`);
	const signJwk = publicJwkOf(operational.sign);
	const sealPublicKey = rawSealKey(operational.seal);
	const seal = operational.seal;
	return Object.freeze({
		memberId,
		identityJwk: JSON.stringify(publicJwkJson(identity.jwk)),
		identity: Object.freeze({
			keyId: identityKeyId,
			algorithm: algorithmOf(identity.jwk),
			sign: (bytes: Uint8Array) => identity.sign(bytes),
		} satisfies Signer),
		sign: localSigner(`${memberId}#sign`, operational.sign),
		signPublicKey: signJwk.x,
		sealPublicKey,
		async openSealed(
			box: SealedBox,
			context: string,
			associatedData: Uint8Array,
		): Promise<Uint8Array> {
			const known = FLEET_CONTEXTS.find((candidate) => candidate === context);
			if (known === undefined) throw new Error(`unknown context ${context}`);
			if (box.recipientKeyId !== `${memberId}#seal`)
				throw new Error(`the box is sealed to ${box.recipientKeyId}`);
			const opened = openSealedWith(seal, box, known, associatedData);
			if (!opened.ok) throw new Error(opened.error.message);
			return opened.value;
		},
		async agree(peerSealPublicKey: string): Promise<Uint8Array> {
			return new Uint8Array(
				diffieHellman({
					privateKey: seal,
					publicKey: rawX25519(peerSealPublicKey),
				}),
			);
		},
		heldKey,
	} satisfies DeviceKeys);
}

/** The raw X25519 public key, base64url without padding. */
function rawSealKey(key: KeyObject): string {
	const jwk = createPublicKey(key).export({ format: "jwk" });
	if (jwk.crv !== "X25519" || jwk.x === undefined)
		throw new Error("the SEAL key is not an X25519 key");
	return jwk.x;
}
