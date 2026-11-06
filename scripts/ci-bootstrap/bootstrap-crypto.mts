import {
	constants,
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	privateDecrypt,
	publicEncrypt,
	randomBytes,
	sign,
	verify,
} from "node:crypto";
import { z } from "zod";
import {
	APP_ID,
	type BridgeIdentity,
	type BridgeKey,
	fingerprint,
	REPOSITORY_ID,
} from "./protocol.mts";

const MAX_TTL = 300_000;
const SOURCE = /^[0-9a-f]{40}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const SHA = /^[0-9a-f]{64}$/;
type Context = Pick<BridgeIdentity, "runId" | "runAttempt" | "sourceSha">;
export interface ControllerReadyMetadata extends Context {
	version: number;
	kind: string;
	appId: number;
	repositoryId: number;
	publicKey: string;
	localPublicKeyFingerprint: string;
}
const ReadySchema = z.object({
	version: z.literal(1),
	kind: z.literal("hobo-controller-ready"),
	appId: z.literal(APP_ID),
	repositoryId: z.literal(REPOSITORY_ID),
	runId: z.number().int().safe().positive(),
	runAttempt: z.number().int().safe().positive(),
	sourceSha: z.string().regex(SOURCE),
	publicKey: z.string(),
	localPublicKeyFingerprint: z.string().regex(SHA),
});
const SealedAppKeySchema = z.strictObject({
	version: z.literal(1),
	kind: z.literal("hobo-sealed-app-key"),
	appId: z.literal(APP_ID),
	repositoryId: z.literal(REPOSITORY_ID),
	runId: z.number(),
	runAttempt: z.number(),
	sourceSha: z.string(),
	issuedAt: z.number().int().safe(),
	notAfter: z.number().int().safe(),
	localKey: z.string(),
	controllerKey: z.string(),
	encryptedKey: z.string().regex(B64),
	iv: z.string().regex(B64),
	ciphertext: z.string().regex(B64),
	tag: z.string().regex(B64),
	signature: z.string().regex(B64),
});
export type SealedAppKey = z.infer<typeof SealedAppKeySchema>;
function data(e: Omit<SealedAppKey, "signature">) {
	return Buffer.from(
		JSON.stringify([
			e.version,
			e.kind,
			e.appId,
			e.repositoryId,
			e.runId,
			e.runAttempt,
			e.sourceSha,
			e.issuedAt,
			e.notAfter,
			e.localKey,
			e.controllerKey,
			e.encryptedKey,
			e.iv,
			e.ciphertext,
			e.tag,
		]),
	);
}
function decode(s: string) {
	return Buffer.from(z.string().regex(B64).parse(s), "base64url");
}
export function publicKeySha256Base64(key: BridgeKey) {
	return createHash("sha256")
		.update(createPublicKey(key).export({ format: "der", type: "spki" }))
		.digest("base64");
}
/** Only the caller reads the App PEM; this function returns ciphertext and a signature, never plaintext. */
export function sealAppKey({
	appPrivateKey,
	localPrivateKey,
	controllerMetadata,
	issuedAt = Date.now(),
	ttlMs = MAX_TTL,
}: {
	appPrivateKey: string | Buffer;
	localPrivateKey: BridgeKey;
	controllerMetadata: ControllerReadyMetadata;
	issuedAt?: number;
	ttlMs?: number;
}) {
	ReadySchema.parse(controllerMetadata);
	if (
		!Number.isSafeInteger(issuedAt) ||
		!Number.isInteger(ttlMs) ||
		ttlMs < 1 ||
		ttlMs > MAX_TTL ||
		fingerprint(localPrivateKey) !==
			controllerMetadata.localPublicKeyFingerprint
	)
		throw new Error("invalid bootstrap authority");
	const controllerPublicKey = controllerMetadata.publicKey;
	const key = randomBytes(32),
		iv = randomBytes(12),
		cipher = createCipheriv("aes-256-gcm", key, iv);
	const context = `hobo-ci-app-key-v1:${controllerMetadata.runId}:${controllerMetadata.runAttempt}:${controllerMetadata.sourceSha}`;
	cipher.setAAD(Buffer.from(context));
	const raw = Buffer.isBuffer(appPrivateKey)
		? appPrivateKey
		: Buffer.from(appPrivateKey);
	if (raw.length < 1 || raw.length > 32768) throw new Error("invalid App key");
	const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
	const e: Omit<SealedAppKey, "signature"> = {
		version: 1,
		kind: "hobo-sealed-app-key",
		appId: APP_ID,
		repositoryId: REPOSITORY_ID,
		runId: controllerMetadata.runId,
		runAttempt: controllerMetadata.runAttempt,
		sourceSha: controllerMetadata.sourceSha,
		issuedAt,
		notAfter: issuedAt + ttlMs,
		localKey: fingerprint(localPrivateKey),
		controllerKey: fingerprint(controllerPublicKey),
		encryptedKey: publicEncrypt(
			{ key: createPublicKey(controllerPublicKey), oaepHash: "sha256" },
			key,
		).toString("base64url"),
		iv: iv.toString("base64url"),
		ciphertext: ciphertext.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
	};
	key.fill(0);
	return {
		...e,
		signature: sign("sha256", data(e), {
			key: createPrivateKey(localPrivateKey),
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		}).toString("base64url"),
	};
}
/** Verifies the local signer and run identity before decrypting into controller memory. */
export function openAppKey({
	envelope,
	controllerPrivateKey,
	localPublicKey,
	expected,
	now = Date.now(),
}: {
	envelope: SealedAppKey;
	controllerPrivateKey: BridgeKey;
	localPublicKey: BridgeKey;
	expected: Context;
	now?: number;
}) {
	const e = SealedAppKeySchema.parse(envelope);
	if (
		e.version !== 1 ||
		e.kind !== "hobo-sealed-app-key" ||
		e.appId !== APP_ID ||
		e.repositoryId !== REPOSITORY_ID ||
		e.runId !== expected.runId ||
		e.runAttempt !== expected.runAttempt ||
		e.sourceSha !== expected.sourceSha ||
		!Number.isSafeInteger(e.issuedAt) ||
		!Number.isSafeInteger(e.notAfter) ||
		e.issuedAt > now + 5000 ||
		e.notAfter <= now ||
		e.notAfter <= e.issuedAt ||
		e.notAfter - e.issuedAt > MAX_TTL ||
		e.localKey !== fingerprint(localPublicKey) ||
		e.controllerKey !== fingerprint(controllerPrivateKey)
	)
		throw new Error("invalid bootstrap envelope");
	if (
		!verify(
			"sha256",
			data(e),
			{
				key: createPublicKey(localPublicKey),
				padding: constants.RSA_PKCS1_PSS_PADDING,
				saltLength: 32,
			},
			decode(e.signature),
		)
	)
		throw new Error("invalid bootstrap signature");
	const key = privateDecrypt(
		{ key: createPrivateKey(controllerPrivateKey), oaepHash: "sha256" },
		decode(e.encryptedKey),
	);
	const decipher = createDecipheriv("aes-256-gcm", key, decode(e.iv));
	decipher.setAAD(
		Buffer.from(`hobo-ci-app-key-v1:${e.runId}:${e.runAttempt}:${e.sourceSha}`),
	);
	decipher.setAuthTag(decode(e.tag));
	const raw = Buffer.concat([
		decipher.update(decode(e.ciphertext)),
		decipher.final(),
	]);
	key.fill(0);
	if (raw.length < 1 || raw.length > 32768)
		throw new Error("invalid bootstrap envelope");
	return raw;
}
const ActiveMetadataSchema = z.strictObject({
	version: z.literal(1),
	kind: z.literal("hobo-controller-active"),
	appId: z.literal(APP_ID),
	appSlug: z.literal("hobo-ci-runner-b61dd084"),
	repositoryId: z.literal(REPOSITORY_ID),
	installationId: z.number().int().safe().positive(),
	installationAccount: z.literal("Hobo-Labs"),
	runId: z.number(),
	runAttempt: z.number(),
	sourceSha: z.string(),
	issuedAt: z.number().int().safe(),
	localKey: z.string(),
	controllerKey: z.string(),
	signature: z.string().regex(B64),
});
export type ActiveMetadata = z.infer<typeof ActiveMetadataSchema>;
function activeData(m: Omit<ActiveMetadata, "signature">) {
	return Buffer.from(
		JSON.stringify([
			m.version,
			m.kind,
			m.appId,
			m.appSlug,
			m.repositoryId,
			m.installationId,
			m.installationAccount,
			m.runId,
			m.runAttempt,
			m.sourceSha,
			m.issuedAt,
			m.localKey,
			m.controllerKey,
		]),
	);
}
export function signControllerMetadata({
	installationId,
	runId,
	runAttempt,
	sourceSha,
	localPublicKey,
	controllerPrivateKey,
	issuedAt = Date.now(),
}: Context & {
	installationId: number;
	localPublicKey: BridgeKey;
	controllerPrivateKey: BridgeKey;
	issuedAt?: number;
}) {
	if (
		!Number.isSafeInteger(installationId) ||
		installationId <= 0 ||
		!Number.isSafeInteger(runId) ||
		runId <= 0 ||
		!Number.isSafeInteger(runAttempt) ||
		runAttempt <= 0 ||
		!SOURCE.test(sourceSha) ||
		!Number.isSafeInteger(issuedAt)
	)
		throw new Error("invalid controller metadata");
	const m: Omit<ActiveMetadata, "signature"> = {
		version: 1,
		kind: "hobo-controller-active",
		appId: APP_ID,
		appSlug: "hobo-ci-runner-b61dd084",
		repositoryId: REPOSITORY_ID,
		installationId,
		installationAccount: "Hobo-Labs",
		runId,
		runAttempt,
		sourceSha,
		issuedAt,
		localKey: fingerprint(localPublicKey),
		controllerKey: fingerprint(controllerPrivateKey),
	};
	return {
		...m,
		signature: sign("sha256", activeData(m), {
			key: createPrivateKey(controllerPrivateKey),
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		}).toString("base64url"),
	};
}
export function verifyControllerMetadata({
	metadata,
	expected,
	localPublicKey,
	controllerPublicKey,
}: {
	metadata: ActiveMetadata;
	expected: Context;
	localPublicKey: BridgeKey;
	controllerPublicKey: BridgeKey;
}) {
	const m = ActiveMetadataSchema.parse(metadata);
	if (
		m.version !== 1 ||
		m.kind !== "hobo-controller-active" ||
		m.appId !== APP_ID ||
		m.appSlug !== "hobo-ci-runner-b61dd084" ||
		m.repositoryId !== REPOSITORY_ID ||
		m.installationAccount !== "Hobo-Labs" ||
		!Number.isSafeInteger(m.installationId) ||
		m.installationId <= 0 ||
		m.runId !== expected.runId ||
		m.runAttempt !== expected.runAttempt ||
		m.sourceSha !== expected.sourceSha ||
		!Number.isSafeInteger(m.issuedAt) ||
		m.localKey !== fingerprint(localPublicKey) ||
		m.controllerKey !== fingerprint(controllerPublicKey)
	)
		throw new Error("invalid controller metadata");
	if (
		!verify(
			"sha256",
			activeData(m),
			{
				key: createPublicKey(controllerPublicKey),
				padding: constants.RSA_PKCS1_PSS_PADDING,
				saltLength: 32,
			},
			decode(m.signature),
		)
	)
		throw new Error("invalid controller signature");
	return { installationId: m.installationId };
}
