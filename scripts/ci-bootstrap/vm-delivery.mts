import {
	constants,
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	KeyObject,
	privateDecrypt,
	publicEncrypt,
	randomBytes,
	sign,
	verify,
} from "node:crypto";
import { z } from "zod";

export type CryptoKey = KeyObject | string | Buffer;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const MAX_TTL = 80_000,
	MAX_JIT = 1024 * 1024;
const Timestamp = z.number().int().positive();
const Encoded = z
	.string()
	.min(1)
	.max(2 * MAX_JIT)
	.regex(/^[A-Za-z0-9_-]+$/);
export const WorkerIdentitySchema = z
	.object({
		repositoryId: z.literal(1274791462),
		leaseId: z.string().regex(UUID),
		runId: Timestamp,
		runAttempt: Timestamp,
		sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
		imageDigest: z.string().regex(SHA),
	})
	.strict();
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;
const EnvironmentSchema = z
	.object({
		NODE_OPTIONS: z.string().regex(/^--max-old-space-size=[1-9][0-9]{2,4}$/),
		HOBO_CI_JOB_MEMORY_MB: z.string(),
		HOBO_CI_RELAY_ORIGIN: z.string().url(),
		HOBO_CI_RUNNER_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
		HOBO_CI_RUNNER_URL: z
			.string()
			.regex(
				/^https:\/\/github\.com\/actions\/runner\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\/actions-runner-linux-x64-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/,
			),
	})
	.strict();
export const ContainerSpecSchema = z
	.object({
		env: EnvironmentSchema,
		memoryMb: z.number().int().min(512).max(16384),
		runAsUser: z.literal("1000:1000"),
	})
	.strict()
	.superRefine((value, context) => {
		const origin = URL.canParse(value.env.HOBO_CI_RELAY_ORIGIN)
			? new URL(value.env.HOBO_CI_RELAY_ORIGIN)
			: undefined;
		const validOrigin =
			origin &&
			["https:", "http:"].includes(origin.protocol) &&
			!origin.username &&
			!origin.password &&
			!origin.search &&
			!origin.hash &&
			origin.pathname === "/" &&
			(origin.protocol !== "http:" ||
				["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname));
		if (
			!validOrigin ||
			value.env.HOBO_CI_JOB_MEMORY_MB !== String(value.memoryMb) ||
			Number(value.env.NODE_OPTIONS.slice("--max-old-space-size=".length)) >
				value.memoryMb
		)
			context.addIssue({
				code: "custom",
				message: "invalid worker environment",
			});
	});
export type ContainerSpec = z.infer<typeof ContainerSpecSchema>;
export const DeliveryEnvelopeSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("hobo-worker-delivery"),
		identity: WorkerIdentitySchema,
		issuedAt: Timestamp,
		notAfter: Timestamp,
		nonce: z.string().regex(/^[0-9a-f]{32}$/),
		encryptedKey: Encoded.max(2048),
		iv: Encoded.max(32),
		ciphertext: Encoded,
		tag: Encoded.max(32),
		signature: Encoded.max(2048),
	})
	.strict();
export type DeliveryEnvelope = z.infer<typeof DeliveryEnvelopeSchema>;
export const StartEnvelopeSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("hobo-worker-start"),
		identity: WorkerIdentitySchema,
		issuedAt: Timestamp,
		notAfter: Timestamp,
		nonce: z.string().regex(/^[0-9a-f]{32}$/),
		deliveryHash: z.string().regex(/^[0-9a-f]{64}$/),
		signature: Encoded.max(2048),
	})
	.strict();
export type StartEnvelope = z.infer<typeof StartEnvelopeSchema>;
const PayloadSchema = z
	.object({
		jitConfig: z
			.string()
			.min(1)
			.max(MAX_JIT)
			.regex(/^[A-Za-z0-9+/_=-]+$/),
		container: ContainerSpecSchema,
	})
	.strict();
export type OpenedDelivery = z.infer<typeof PayloadSchema> & {
	notAfter: number;
};
type FreshCommand = { issuedAt: number; notAfter: number; nonce: string };
type DeliveryUnsigned = Omit<DeliveryEnvelope, "signature">;
type StartUnsigned = Omit<StartEnvelope, "signature">;
function identityValues(value: WorkerIdentity): readonly (number | string)[] {
	return [
		value.repositoryId,
		value.leaseId,
		value.runId,
		value.runAttempt,
		value.sourceSha,
		value.imageDigest,
	];
}
function sameIdentity(first: WorkerIdentity, second: WorkerIdentity): void {
	if (
		JSON.stringify(identityValues(first)) !==
		JSON.stringify(identityValues(second))
	)
		throw new Error("worker identity mismatch");
}
function b64(value: string, size = 2 * MAX_JIT): Buffer {
	const parsed = Encoded.max(size).parse(value);
	return Buffer.from(parsed, "base64url");
}
function freshness(value: FreshCommand, now: number): void {
	Timestamp.parse(now);
	if (
		value.issuedAt > now + 5000 ||
		value.notAfter <= now ||
		value.notAfter <= value.issuedAt ||
		value.notAfter - value.issuedAt > MAX_TTL
	)
		throw new Error("expired worker command");
}
function envelopeBytes(value: DeliveryUnsigned): Buffer {
	return Buffer.from(
		JSON.stringify([
			value.version,
			value.kind,
			identityValues(value.identity),
			value.issuedAt,
			value.notAfter,
			value.nonce,
			value.encryptedKey,
			value.iv,
			value.ciphertext,
			value.tag,
		]),
	);
}
function startBytes(value: StartUnsigned): Buffer {
	return Buffer.from(
		JSON.stringify([
			value.version,
			value.kind,
			identityValues(value.identity),
			value.issuedAt,
			value.notAfter,
			value.nonce,
			value.deliveryHash,
		]),
	);
}
function privateKey(key: CryptoKey): KeyObject {
	return key instanceof KeyObject ? key : createPrivateKey(key);
}
function publicKey(key: CryptoKey): KeyObject {
	return key instanceof KeyObject && key.type === "public"
		? key
		: createPublicKey(key);
}
function signature(bytes: Buffer, key: CryptoKey): string {
	return sign("sha256", bytes, {
		key: privateKey(key),
		padding: constants.RSA_PKCS1_PSS_PADDING,
		saltLength: 32,
	}).toString("base64url");
}
function validSignature(bytes: Buffer, value: string, key: CryptoKey): void {
	if (
		!verify(
			"sha256",
			bytes,
			{
				key: publicKey(key),
				padding: constants.RSA_PKCS1_PSS_PADDING,
				saltLength: 32,
			},
			b64(value, 2048),
		)
	)
		throw new Error("invalid worker signature");
}
export function publicKeyFingerprint(key: CryptoKey): string {
	const publicKey =
		key instanceof KeyObject && key.type === "public"
			? key
			: createPublicKey(key);
	return createHash("sha256")
		.update(publicKey.export({ format: "der", type: "spki" }))
		.digest("hex");
}
export function deliveryHash(envelope: DeliveryEnvelope): string {
	return createHash("sha256")
		.update(envelopeBytes(envelope))
		.update(envelope.signature)
		.digest("hex");
}
export function validateContainer(
	value: Parameters<typeof ContainerSpecSchema.parse>[0],
): ContainerSpec {
	return ContainerSpecSchema.parse(value);
}

export function sealDelivery(input: {
	jitConfig: string;
	container: Parameters<typeof ContainerSpecSchema.parse>[0];
	identity: WorkerIdentity;
	workerPublicKey: CryptoKey;
	signingPrivateKey: CryptoKey;
	notAfter: number;
	clock?: () => number;
}): DeliveryEnvelope {
	const identity = WorkerIdentitySchema.parse(input.identity),
		payload = PayloadSchema.parse({
			jitConfig: input.jitConfig,
			container: input.container,
		});
	const issuedAt = (input.clock ?? Date.now)(),
		nonce = randomBytes(16).toString("hex");
	freshness({ issuedAt, notAfter: input.notAfter, nonce }, issuedAt);
	const key = randomBytes(32),
		iv = randomBytes(12),
		cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(
		Buffer.from(
			JSON.stringify([
				1,
				"hobo-worker-delivery",
				identityValues(identity),
				issuedAt,
				input.notAfter,
				nonce,
			]),
		),
	);
	const data = Buffer.concat([
		cipher.update(JSON.stringify(payload), "utf8"),
		cipher.final(),
	]);
	const value: DeliveryUnsigned = {
		version: 1,
		kind: "hobo-worker-delivery",
		identity,
		issuedAt,
		notAfter: input.notAfter,
		nonce,
		encryptedKey: publicEncrypt(
			{ key: input.workerPublicKey, oaepHash: "sha256" },
			key,
		).toString("base64url"),
		iv: iv.toString("base64url"),
		ciphertext: data.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
	};
	return {
		...value,
		signature: signature(envelopeBytes(value), input.signingPrivateKey),
	};
}

export function openDelivery(input: {
	envelope: Parameters<typeof DeliveryEnvelopeSchema.parse>[0];
	identity: WorkerIdentity;
	workerPrivateKey: CryptoKey;
	signingPublicKey: CryptoKey;
	clock?: () => number;
}): OpenedDelivery {
	const envelope = DeliveryEnvelopeSchema.parse(input.envelope),
		identity = WorkerIdentitySchema.parse(input.identity);
	sameIdentity(envelope.identity, identity);
	freshness(envelope, (input.clock ?? Date.now)());
	validSignature(
		envelopeBytes(envelope),
		envelope.signature,
		input.signingPublicKey,
	);
	const key = privateDecrypt(
			{ key: input.workerPrivateKey, oaepHash: "sha256" },
			b64(envelope.encryptedKey, 2048),
		),
		iv = b64(envelope.iv, 32),
		tag = b64(envelope.tag, 32);
	if (key.length !== 32 || iv.length !== 12 || tag.length !== 16)
		throw new Error("invalid worker encryption");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(
		Buffer.from(
			JSON.stringify([
				envelope.version,
				envelope.kind,
				identityValues(identity),
				envelope.issuedAt,
				envelope.notAfter,
				envelope.nonce,
			]),
		),
	);
	decipher.setAuthTag(tag);
	const raw = Buffer.concat([
		decipher.update(b64(envelope.ciphertext)),
		decipher.final(),
	]);
	if (raw.length > MAX_JIT + 65536)
		throw new Error("oversized worker delivery");
	const data = PayloadSchema.parse(JSON.parse(raw.toString("utf8")));
	return { ...data, notAfter: envelope.notAfter };
}

export function signStart(input: {
	envelope: DeliveryEnvelope;
	identity: WorkerIdentity;
	signingPrivateKey: CryptoKey;
	notAfter: number;
	clock?: () => number;
}): StartEnvelope {
	const envelope = DeliveryEnvelopeSchema.parse(input.envelope),
		identity = WorkerIdentitySchema.parse(input.identity);
	sameIdentity(envelope.identity, identity);
	const value: StartUnsigned = {
		version: 1,
		kind: "hobo-worker-start",
		identity,
		issuedAt: (input.clock ?? Date.now)(),
		notAfter: input.notAfter,
		nonce: randomBytes(16).toString("hex"),
		deliveryHash: deliveryHash(envelope),
	};
	freshness(value, value.issuedAt);
	if (input.notAfter > envelope.notAfter)
		throw new Error("start outlives delivery");
	return {
		...value,
		signature: signature(startBytes(value), input.signingPrivateKey),
	};
}

export function verifyStart(input: {
	start: Parameters<typeof StartEnvelopeSchema.parse>[0];
	envelope: DeliveryEnvelope;
	identity: WorkerIdentity;
	signingPublicKey: CryptoKey;
	clock?: () => number;
}): true {
	const start = StartEnvelopeSchema.parse(input.start),
		envelope = DeliveryEnvelopeSchema.parse(input.envelope),
		identity = WorkerIdentitySchema.parse(input.identity);
	sameIdentity(start.identity, identity);
	sameIdentity(envelope.identity, identity);
	const now = (input.clock ?? Date.now)();
	freshness(start, now);
	freshness(envelope, now);
	if (
		start.deliveryHash !== deliveryHash(envelope) ||
		start.notAfter > envelope.notAfter
	)
		throw new Error("invalid worker start");
	validSignature(startBytes(start), start.signature, input.signingPublicKey);
	return true;
}
