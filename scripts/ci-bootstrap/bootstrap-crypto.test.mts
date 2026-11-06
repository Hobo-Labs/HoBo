import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
	openAppKey,
	publicKeySha256Base64,
	type SealedAppKey,
	sealAppKey,
} from "./bootstrap-crypto.mts";
import { fingerprint } from "./protocol.mts";

const key = () =>
	generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
const local = key(),
	controller = key(),
	attacker = key(),
	app = key();
const now = 2_000_000_000_000;
const expected = { runId: 42, runAttempt: 2, sourceSha: "a".repeat(40) };
const meta = {
	version: 1,
	kind: "hobo-controller-ready",
	appId: 5636332,
	repositoryId: 1274791462,
	...expected,
	publicKey: controller.publicKey,
	localPublicKeyFingerprint: fingerprint(local.publicKey),
};
const seal = () =>
	sealAppKey({
		appPrivateKey: app.privateKey,
		localPrivateKey: local.privateKey,
		controllerMetadata: meta,
		issuedAt: now,
	});
const open = (envelope: SealedAppKey, opts = {}) =>
	openAppKey({
		envelope,
		controllerPrivateKey: controller.privateKey,
		localPublicKey: local.publicKey,
		expected,
		now,
		...opts,
	});
test("App key envelope is encrypted and tied to verified run and local key", () => {
	const envelope = seal();
	assert(!JSON.stringify(envelope).includes("PRIVATE KEY"));
	const decrypted = open(envelope);
	assert.equal(decrypted.toString(), app.privateKey);
	assert.equal(
		publicKeySha256Base64(decrypted.toString()),
		publicKeySha256Base64(app.publicKey),
	);
	decrypted.fill(0);
});
test("App key rejects stale, cross-run, wrong recipient and forged signature", () => {
	const e = seal();
	assert.throws(() => open(e, { now: now + 300000 }));
	assert.throws(() => open(e, { expected: { ...expected, runAttempt: 3 } }));
	assert.throws(() => open(e, { controllerPrivateKey: attacker.privateKey }));
	assert.throws(() =>
		open({ ...e, ciphertext: e.ciphertext.slice(0, -2) + "aa" }),
	);
	assert.throws(() => open(e, { localPublicKey: attacker.publicKey }));
	assert.throws(() =>
		sealAppKey({
			appPrivateKey: app.privateKey,
			localPrivateKey: attacker.privateKey,
			controllerMetadata: meta,
			issuedAt: now,
		}),
	);
});
