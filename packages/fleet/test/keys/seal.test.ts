import {
	createDecipheriv,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
} from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	KeyPurpose,
	PublicKeyRefSchema,
	SealedBoxSchema,
} from "../../src/_generated/fleet_pb.js";
import { CLAIM_CONTEXT, ORDER_SECRET_CONTEXT } from "../../src/contexts.js";
import { openSealedWith, seal, sessionKeys } from "../../src/keys/index.js";

function recipient() {
	const { privateKey, publicKey } = generateKeyPairSync("x25519");
	const raw = publicKey.export({ format: "jwk" }).x ?? "";
	const ref = create(PublicKeyRefSchema, {
		purpose: KeyPurpose.SEAL,
		keyId: "dev_0123456789abcdef0123456789abcdef#seal",
		value: raw,
	});
	return { privateKey, ref, raw };
}

const ad = new Uint8Array(
	Buffer.from("order-1\u0000dev_0123456789abcdef0123456789abcdef"),
);
const secret = new Uint8Array(Buffer.from("a single-use runner registration"));

describe("seal and openSealedWith (§7.4)", () => {
	it("round-trips and names the recipient key", () => {
		const r = recipient();
		const box = seal(r.ref, secret, ORDER_SECRET_CONTEXT, ad);
		expect(box.recipientKeyId).toBe(r.ref.keyId);
		expect(box.nonce.length).toBe(12);
		expect(box.ciphertext.length).toBe(secret.length + 16);
		const opened = openSealedWith(r.privateKey, box, ORDER_SECRET_CONTEXT, ad);
		expect(opened.ok && Buffer.from(opened.value).toString()).toBe(
			Buffer.from(secret).toString(),
		);
	});

	it("uses fresh ephemeral keys and nonces", () => {
		const r = recipient();
		const a = seal(r.ref, secret, ORDER_SECRET_CONTEXT, ad);
		const b = seal(r.ref, secret, ORDER_SECRET_CONTEXT, ad);
		expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
		expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
	});

	it("follows the exact parameters: X25519, HKDF-SHA-256 salt eph‖recipient, info context, ChaCha20-Poly1305 with context‖0x00‖ad", () => {
		const r = recipient();
		const box = seal(r.ref, secret, ORDER_SECRET_CONTEXT, ad);
		const ephemeral = createPublicKey({
			key: { kty: "OKP", crv: "X25519", x: box.ephemeralPublicKey },
			format: "jwk",
		});
		const shared = diffieHellman({
			privateKey: r.privateKey,
			publicKey: ephemeral,
		});
		const key = Buffer.from(
			hkdfSync(
				"sha256",
				shared,
				Buffer.concat([
					Buffer.from(box.ephemeralPublicKey, "base64url"),
					Buffer.from(r.raw, "base64url"),
				]),
				Buffer.from(ORDER_SECRET_CONTEXT),
				32,
			),
		);
		const decipher = createDecipheriv("chacha20-poly1305", key, box.nonce, {
			authTagLength: 16,
		});
		const body = box.ciphertext.subarray(0, -16);
		decipher.setAAD(
			Buffer.concat([Buffer.from(ORDER_SECRET_CONTEXT), Buffer.from([0]), ad]),
			{ plaintextLength: body.length },
		);
		decipher.setAuthTag(box.ciphertext.subarray(-16));
		const plain = Buffer.concat([decipher.update(body), decipher.final()]);
		expect(plain.toString()).toBe(Buffer.from(secret).toString());
	});

	it("refuses the wrong key, context or associated data, and any altered byte", () => {
		const r = recipient();
		const box = seal(r.ref, secret, ORDER_SECRET_CONTEXT, ad);
		expect(
			openSealedWith(recipient().privateKey, box, ORDER_SECRET_CONTEXT, ad).ok,
		).toBe(false);
		expect(openSealedWith(r.privateKey, box, CLAIM_CONTEXT, ad).ok).toBe(false);
		expect(
			openSealedWith(
				r.privateKey,
				box,
				ORDER_SECRET_CONTEXT,
				new Uint8Array([1]),
			).ok,
		).toBe(false);
		for (let i = 0; i < box.ciphertext.length; i += 1) {
			const ciphertext = new Uint8Array(box.ciphertext);
			ciphertext[i] = (ciphertext[i] ?? 0) ^ 1;
			const altered = create(SealedBoxSchema, { ...box, ciphertext });
			const result = openSealedWith(
				r.privateKey,
				altered,
				ORDER_SECRET_CONTEXT,
				ad,
			);
			expect(result.ok ? undefined : result.error.code).toBe("proof-invalid");
		}
		const nonce = new Uint8Array(box.nonce);
		nonce[0] = (nonce[0] ?? 0) ^ 1;
		expect(
			openSealedWith(
				r.privateKey,
				create(SealedBoxSchema, { ...box, nonce }),
				ORDER_SECRET_CONTEXT,
				ad,
			).ok,
		).toBe(false);
		const short = create(SealedBoxSchema, { ...box, nonce: new Uint8Array(4) });
		const refused = openSealedWith(
			r.privateKey,
			short,
			ORDER_SECRET_CONTEXT,
			ad,
		);
		expect(refused.ok ? undefined : refused.error.code).toBe("invalid-request");
	});

	it("refuses to seal to a key that is not a raw X25519 SEAL key", () => {
		const r = recipient();
		expect(() =>
			seal(
				{ ...r.ref, purpose: KeyPurpose.SIGN },
				secret,
				ORDER_SECRET_CONTEXT,
				ad,
			),
		).toThrow();
		expect(() =>
			seal({ ...r.ref, value: "AAAA" }, secret, ORDER_SECRET_CONTEXT, ad),
		).toThrow();
	});
});

describe("sessionKeys (§7.4)", () => {
	it("derives the two directions with HKDF-SHA-256, salt session id, the i2a and a2i infos", () => {
		const shared = new Uint8Array(32).fill(7);
		const keys = sessionKeys(shared, "sess-1");
		const expected = (info: string) =>
			Buffer.from(
				hkdfSync(
					"sha256",
					shared,
					Buffer.from("sess-1"),
					Buffer.from(info),
					32,
				),
			);
		expect(Buffer.from(keys.initiatorToAcceptor)).toEqual(
			expected("hobo-fleet/session/v1/i2a"),
		);
		expect(Buffer.from(keys.acceptorToInitiator)).toEqual(
			expected("hobo-fleet/session/v1/a2i"),
		);
		expect(keys.initiatorToAcceptor.length).toBe(32);
		expect(Buffer.from(keys.initiatorToAcceptor)).not.toEqual(
			Buffer.from(keys.acceptorToInitiator),
		);
		expect(
			Buffer.from(sessionKeys(shared, "sess-2").initiatorToAcceptor),
		).not.toEqual(Buffer.from(keys.initiatorToAcceptor));
	});
});
