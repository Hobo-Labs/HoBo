/**
 * Key material the conformance suites make for themselves with `node:crypto`:
 * an Ed25519 signer for authority-signed records and grants, device keys for
 * transports, and the sealing of §7.4 to check a key store's `openSealed`.
 *
 * Nothing here is the fleet's key code (`@hobo/fleet/keys` is another lane's);
 * these are the suites' own fixtures, written from §7.4 directly, so a suite
 * never depends on the code it may be used to check.
 */
import {
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
	sign,
	verify,
} from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	type SealedBox,
	SealedBoxSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "../../_generated/fleet_pb.js";
import { type MemberId, parseKeyId, parseMemberId } from "../../ids.js";
import type { DeviceKeys, Signer } from "../../ports.js";

const encoder = new TextEncoder();

/** An Ed25519 key the suite signs with, and its public half as JWK JSON. */
export type SuiteKey = Readonly<{
	signer: Signer;
	publicJwk: string;
	verify(bytes: Uint8Array, signature: Uint8Array): boolean;
}>;

export function createSuiteKey(keyId: string): SuiteKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		signer: {
			keyId: parseKeyId(keyId),
			algorithm: KeyAlgorithm.EDDSA,
			async sign(bytes) {
				return new Uint8Array(sign(null, bytes, privateKey));
			},
		},
		publicJwk: JSON.stringify(publicKey.export({ format: "jwk" })),
		verify(bytes, signature) {
			return verify(null, bytes, publicKey, signature);
		},
	};
}

/** The bytes a signature covers (§7.4): `utf8(context) || 0x00 || payload`. */
export function signedBytes(context: string, payload: Uint8Array): Uint8Array {
	const prefix = encoder.encode(context);
	const out = new Uint8Array(prefix.length + 1 + payload.length);
	out.set(prefix, 0);
	out.set(payload, prefix.length + 1);
	return out;
}

export async function signEnvelope(
	signer: Signer,
	context: string,
	payload: Uint8Array,
): Promise<SignedEnvelope> {
	return create(SignedEnvelopeSchema, {
		context,
		keyId: signer.keyId,
		algorithm: signer.algorithm,
		payload,
		signature: await signer.sign(signedBytes(context, payload)),
	});
}

/** A random device member id (`dev_` and 32 hex digits). */
export function randomMemberId(): MemberId {
	return parseMemberId(`dev_${randomBytes(16).toString("hex")}`);
}

const rawX25519 = (key: KeyObject): Buffer => {
	const x = key.export({ format: "jwk" }).x;
	if (x === undefined) throw new Error("an X25519 key without x");
	return Buffer.from(x, "base64url");
};

const x25519Public = (raw: string): KeyObject =>
	createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: raw },
		format: "jwk",
	});

const sealKey = (
	shared: Buffer,
	ephemeralPublic: Buffer,
	recipientPublic: Buffer,
	context: string,
): Buffer =>
	Buffer.from(
		hkdfSync(
			"sha256",
			shared,
			Buffer.concat([ephemeralPublic, recipientPublic]),
			encoder.encode(context),
			32,
		),
	);

const sealAad = (context: string, associatedData: Uint8Array): Buffer =>
	Buffer.concat([encoder.encode(context), Buffer.from([0]), associatedData]);

/** §7.4 `seal(recipient, plaintext, context, associatedData)`; `recipient` is a raw X25519 public key, base64url. */
export function sealTo(
	recipient: string,
	recipientKeyId: string,
	plaintext: Uint8Array,
	context: string,
	associatedData: Uint8Array,
): SealedBox {
	const ephemeral = generateKeyPairSync("x25519");
	const recipientKey = x25519Public(recipient);
	const ephemeralPublic = rawX25519(ephemeral.publicKey);
	const key = sealKey(
		diffieHellman({
			privateKey: ephemeral.privateKey,
			publicKey: recipientKey,
		}),
		ephemeralPublic,
		rawX25519(recipientKey),
		context,
	);
	const nonce = randomBytes(12);
	const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
		authTagLength: 16,
	});
	cipher.setAAD(sealAad(context, associatedData), {
		plaintextLength: plaintext.length,
	});
	const ciphertext = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return create(SealedBoxSchema, {
		recipientKeyId,
		ephemeralPublicKey: ephemeralPublic.toString("base64url"),
		nonce,
		ciphertext,
	});
}

function openWith(
	privateKey: KeyObject,
	publicKey: KeyObject,
	box: SealedBox,
	context: string,
	associatedData: Uint8Array,
): Uint8Array {
	const ephemeral = x25519Public(box.ephemeralPublicKey);
	const key = sealKey(
		diffieHellman({ privateKey, publicKey: ephemeral }),
		rawX25519(ephemeral),
		rawX25519(publicKey),
		context,
	);
	const body = box.ciphertext.subarray(0, box.ciphertext.length - 16);
	const tag = box.ciphertext.subarray(box.ciphertext.length - 16);
	const decipher = createDecipheriv("chacha20-poly1305", key, box.nonce, {
		authTagLength: 16,
	});
	decipher.setAAD(sealAad(context, associatedData), {
		plaintextLength: body.length,
	});
	decipher.setAuthTag(tag);
	return new Uint8Array(
		Buffer.concat([decipher.update(body), decipher.final()]),
	);
}

/** Device keys made in memory for a transport under test: Ed25519 identity and SIGN keys, an X25519 SEAL key. */
export function createSuiteDeviceKeys(): DeviceKeys {
	const memberId = randomMemberId();
	const identity = createSuiteKey(`${memberId}#identity`);
	const signing = createSuiteKey(`${memberId}#sign`);
	const seal = generateKeyPairSync("x25519");
	return {
		memberId,
		identityJwk: identity.publicJwk,
		identity: identity.signer,
		sign: signing.signer,
		sealPublicKey: rawX25519(seal.publicKey).toString("base64url"),
		async openSealed(box, context, associatedData) {
			return openWith(
				seal.privateKey,
				seal.publicKey,
				box,
				context,
				associatedData,
			);
		},
		async agree(peerSealPublicKey) {
			return new Uint8Array(
				diffieHellman({
					privateKey: seal.privateKey,
					publicKey: x25519Public(peerSealPublicKey),
				}),
			);
		},
		heldKey: false,
	};
}

/** Verifies an identity signature against a public JWK (ES256 in IEEE P1363 form, or EdDSA). */
export function verifyWithJwk(
	jwk: string,
	algorithm: KeyAlgorithm,
	bytes: Uint8Array,
	signature: Uint8Array,
): boolean {
	try {
		const key = createPublicKey({ key: JSON.parse(jwk), format: "jwk" });
		if (algorithm === KeyAlgorithm.ES256)
			return verify(
				"sha256",
				bytes,
				{ key, dsaEncoding: "ieee-p1363" },
				signature,
			);
		if (algorithm === KeyAlgorithm.EDDSA)
			return verify(null, bytes, key, signature);
		return false;
	} catch {
		return false;
	}
}
