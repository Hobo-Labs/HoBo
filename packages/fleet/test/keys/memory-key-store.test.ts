// The in-memory KeyStore against the KeyStore contract of §7.3 and §6.4. The
// shared conformance suite (`runKeyStoreConformance`, L29) lands in the same
// wave; once it has merged this store is run through it as well.
import { generateKeyPairSync } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	KeyAlgorithm,
	KeyPurpose,
	PublicKeyRefSchema,
	SignedEnvelopeSchema,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	CLAIM_CONTEXT,
	KEY_BUNDLE_CONTEXT,
	ORDER_SECRET_CONTEXT,
} from "../../src/contexts.js";
import { parseMemberId } from "../../src/ids.js";
import {
	createMemoryKeyStore,
	memberIdFromJwk,
	parsePublicJwk,
	seal,
	sessionKeys,
	signEnvelope,
	verifyEnvelope,
} from "../../src/keys/index.js";
import { signKeyBundle, verifyKeyBundle } from "../../src/keys/key-bundle.js";
import { memorySignKeyRef } from "../../src/keys/memory-key-store.js";
import type { AgentState, DeviceKeys } from "../../src/ports.js";

const NOW = Date.parse("2026-11-12T10:00:00Z");

function sealRefOf(keys: DeviceKeys) {
	return create(PublicKeyRefSchema, {
		purpose: KeyPurpose.SEAL,
		keyId: `${keys.memberId}#seal`,
		value: keys.sealPublicKey,
	});
}

function identityOf(keys: DeviceKeys) {
	const jwk = parsePublicJwk(keys.identityJwk);
	if (!jwk.ok) throw new Error(jwk.error.message);
	return jwk.value;
}

describe("createMemoryKeyStore", () => {
	it("creates keys once: the member id is the identity key's, and opening again returns the same keys", async () => {
		const store = createMemoryKeyStore();
		const keys = await store.open();
		const identity = identityOf(keys);
		expect(keys.memberId).toBe(memberIdFromJwk(identity));
		expect(parseMemberId(keys.memberId)).toBe(keys.memberId);
		expect(keys.identity.keyId).toBe(`${keys.memberId}#identity`);
		expect(keys.sign.keyId).toBe(`${keys.memberId}#sign`);
		expect(keys.sign.algorithm).toBe(KeyAlgorithm.EDDSA);
		expect(keys.heldKey).toBe(false);
		expect(Buffer.from(keys.sealPublicKey, "base64url").length).toBe(32);
		const again = await store.open();
		expect(again.memberId).toBe(keys.memberId);
		expect(again.sealPublicKey).toBe(keys.sealPublicKey);
	});

	it("never returns private material", async () => {
		const keys = await createMemoryKeyStore().open();
		const text = JSON.stringify(keys);
		expect(text).not.toContain('"d"');
		expect(keys.identityJwk).not.toContain('"d"');
		expect(Object.keys(identityOf(keys)).sort()).toEqual(
			identityOf(keys).kty === "EC"
				? ["crv", "kty", "x", "y"]
				: ["crv", "kty", "x"],
		);
	});

	it("signs with the identity and SIGN keys, each verifiable by its public key", async () => {
		const keys = await createMemoryKeyStore().open();
		const payload = new Uint8Array([1, 2, 3]);
		const byIdentity = await signEnvelope(
			keys.identity,
			CLAIM_CONTEXT,
			payload,
		);
		expect(verifyEnvelope(byIdentity, CLAIM_CONTEXT, identityOf(keys))).toBe(
			true,
		);
		const signRef = memorySignKeyRef(keys);
		if (signRef === undefined) throw new Error("no sign ref");
		const bySign = await signEnvelope(keys.sign, CLAIM_CONTEXT, payload);
		expect(verifyEnvelope(bySign, CLAIM_CONTEXT, signRef)).toBe(true);
		expect(verifyEnvelope(bySign, CLAIM_CONTEXT, identityOf(keys))).toBe(false);
	});

	it("opens what was sealed to its SEAL key, and nothing sealed to another key or context", async () => {
		const keys = await createMemoryKeyStore().open();
		const ad = new Uint8Array([9]);
		const box = seal(
			sealRefOf(keys),
			new Uint8Array([42]),
			ORDER_SECRET_CONTEXT,
			ad,
		);
		expect(await keys.openSealed(box, ORDER_SECRET_CONTEXT, ad)).toEqual(
			new Uint8Array([42]),
		);
		await expect(keys.openSealed(box, CLAIM_CONTEXT, ad)).rejects.toThrow();
		await expect(keys.openSealed(box, "not-a-context", ad)).rejects.toThrow();
		const other = await createMemoryKeyStore().open();
		const elsewhere = seal(
			sealRefOf(other),
			new Uint8Array([42]),
			ORDER_SECRET_CONTEXT,
			ad,
		);
		await expect(
			keys.openSealed(elsewhere, ORDER_SECRET_CONTEXT, ad),
		).rejects.toThrow();
	});

	it("agrees a raw X25519 secret with a peer, symmetric on both sides", async () => {
		const a = await createMemoryKeyStore().open();
		const b = await createMemoryKeyStore().open();
		const ab = await a.agree(b.sealPublicKey);
		const ba = await b.agree(a.sealPublicKey);
		expect(ab.length).toBe(32);
		expect(Buffer.from(ab)).toEqual(Buffer.from(ba));
		expect(Buffer.from(sessionKeys(ab, "s").initiatorToAcceptor)).toEqual(
			Buffer.from(sessionKeys(ba, "s").initiatorToAcceptor),
		);
		await expect(a.agree("AAAA")).rejects.toThrow();
	});

	it("starts from an empty state and replaces it atomically, keeping no reference to the caller's object", async () => {
		const store = createMemoryKeyStore();
		const empty = await store.readState();
		expect(empty).toEqual({
			generation: 0,
			pendingRefreshNonce: undefined,
			trust: undefined,
			lastSequence: {},
			seenOrderIds: [],
			pendingReceipts: [],
		});
		const nonce = new Uint8Array([1, 2, 3]);
		const lastSequence = { "fleet-orders": 4 };
		const seen = ["o-1"];
		const next: AgentState = {
			generation: 3,
			pendingRefreshNonce: nonce,
			trust: create(WitnessedEnvelopeSchema, {}),
			lastSequence,
			seenOrderIds: seen,
			pendingReceipts: [
				create(SignedEnvelopeSchema, { context: CLAIM_CONTEXT }),
			],
		};
		await store.writeState(next);
		nonce[0] = 99;
		lastSequence["fleet-orders"] = 100;
		seen.push("o-2");
		const read = await store.readState();
		expect(read.generation).toBe(3);
		expect(read.pendingRefreshNonce).toEqual(new Uint8Array([1, 2, 3]));
		expect(read.lastSequence).toEqual({ "fleet-orders": 4 });
		expect(read.seenOrderIds).toEqual(["o-1"]);
		expect(read.pendingReceipts.length).toBe(1);
		expect(read.trust).toBeDefined();
	});

	it("rotates the operational keys and keeps the identity key and member id", async () => {
		const store = createMemoryKeyStore();
		const before = await store.open();
		const after = await store.rotateOperational();
		expect(after.memberId).toBe(before.memberId);
		expect(after.identityJwk).toBe(before.identityJwk);
		expect(after.sealPublicKey).not.toBe(before.sealPublicKey);
		expect(memorySignKeyRef(after)?.value).not.toBe(
			memorySignKeyRef(before)?.value,
		);
		expect((await store.open()).sealPublicKey).toBe(after.sealPublicKey);
	});

	it("destroys keys and state: the next open is a new device", async () => {
		const store = createMemoryKeyStore();
		const before = await store.open();
		await store.writeState({ ...(await store.readState()), generation: 7 });
		await store.destroy();
		expect((await store.readState()).generation).toBe(0);
		expect((await store.open()).memberId).not.toBe(before.memberId);
	});
});

describe("key bundles (§6.4)", () => {
	it("signs one SIGN and one SEAL key with the identity key, and verifies against the identity JWK", async () => {
		const keys = await createMemoryKeyStore().open();
		const signPublic = memorySignKeyRef(keys);
		if (signPublic === undefined) throw new Error("no sign ref");
		const envelope = await signKeyBundle({
			keys,
			signPublic,
			sequence: 1,
			nowMs: NOW,
			hours: 24,
		});
		expect(envelope.context).toBe(KEY_BUNDLE_CONTEXT);
		const bundle = verifyKeyBundle(envelope, identityOf(keys), NOW + 1);
		expect(bundle.ok).toBe(true);
		if (bundle.ok) {
			expect(bundle.value.memberId).toBe(keys.memberId);
			expect(bundle.value.keys.map((k) => k.purpose)).toEqual([
				KeyPurpose.SIGN,
				KeyPurpose.SEAL,
			]);
			expect(bundle.value.notAfter).toBe(
				new Date(NOW + 24 * 3_600_000).toISOString(),
			);
		}
		const expired = verifyKeyBundle(
			envelope,
			identityOf(keys),
			NOW + 24 * 3_600_000,
		);
		expect(expired.ok).toBe(false);
		const stranger = identityOf(await createMemoryKeyStore().open());
		expect(verifyKeyBundle(envelope, stranger, NOW).ok).toBe(false);
	});

	it("refuses a bundle lifetime above 720 hours", async () => {
		const keys = await createMemoryKeyStore().open();
		const signPublic = memorySignKeyRef(keys);
		if (signPublic === undefined) throw new Error("no sign ref");
		await expect(
			signKeyBundle({ keys, signPublic, sequence: 1, nowMs: NOW, hours: 721 }),
		).rejects.toThrow();
	});

	it("refuses a bundle with a second SIGN key or another member's key", async () => {
		const keys = await createMemoryKeyStore().open();
		const signPublic = memorySignKeyRef(keys);
		if (signPublic === undefined) throw new Error("no sign ref");
		const twice = await signKeyBundle({
			keys,
			signPublic,
			transport: signPublic,
			sequence: 1,
			nowMs: NOW,
			hours: 1,
		});
		expect(verifyKeyBundle(twice, identityOf(keys), NOW).ok).toBe(false);
		const { publicKey } = generateKeyPairSync("ed25519");
		const foreign = create(PublicKeyRefSchema, {
			purpose: KeyPurpose.SIGN,
			keyId: "dev_ffffffffffffffffffffffffffffffff#sign",
			algorithm: KeyAlgorithm.EDDSA,
			value: publicKey.export({ format: "jwk" }).x ?? "",
		});
		const other = await signKeyBundle({
			keys,
			signPublic: foreign,
			sequence: 1,
			nowMs: NOW,
			hours: 1,
		});
		expect(verifyKeyBundle(other, identityOf(keys), NOW).ok).toBe(false);
	});
});
