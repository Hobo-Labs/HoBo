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

export const VERSION = 1;
export const REPOSITORY = "Hobo-Labs/HoBo";
export const REPOSITORY_ID = 1274791462;
export const APP_ID = 5636332;
export const MAX_REQUEST_TTL_MS = 80_000;
// Keep encrypted/base64 mailbox files below the GitHub Contents 1 MiB inline-file limit.
export const MAX_BODY_BYTES = 512 * 1024;
const ID = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const SOURCE = /^[0-9a-f]{40}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const positiveInt = z.number().int().safe().positive();
export type BridgeKey = string | Buffer;
export interface BridgeIdentity {
	installationId: number;
	runId: number;
	runAttempt: number;
	sourceSha: string;
}
export const BridgeRequestSchema = z
	.strictObject({
		version: z.literal(VERSION),
		id: z.string().regex(ID),
		issuedAt: z.number().int().safe(),
		notAfter: z.number().int().safe(),
		installationId: positiveInt,
		repositoryId: z.literal(REPOSITORY_ID),
		runId: positiveInt,
		runAttempt: positiveInt,
		sourceSha: z.string().regex(SOURCE),
		workerKey: z.string().regex(SHA),
		controllerKey: z.string().regex(SHA),
		method: z.enum(["GET", "POST", "DELETE"]),
		path: z.string(),
		body: z.string().nullable(),
		ifNoneMatch: z.string().nullable(),
		capability: z
			.string()
			.regex(/^[A-Za-z0-9_-]{32,200}$/)
			.nullable(),
	})
	.refine((q) => q.body === null || Buffer.byteLength(q.body) <= 65536);
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;
export const SignedRequestSchema = z.strictObject({
	request: BridgeRequestSchema,
	signature: z.string().regex(B64),
});
export type SignedRequest = z.infer<typeof SignedRequestSchema>;
const SealedResponseSchema = z.strictObject({
	version: z.literal(VERSION),
	id: z.string(),
	requestHash: z.string(),
	workerKey: z.string(),
	controllerKey: z.string(),
	encryptedKey: z.string().regex(B64),
	iv: z.string().regex(B64),
	ciphertext: z.string().regex(B64),
	tag: z.string().regex(B64),
	signature: z.string().regex(B64),
});
export type SealedResponse = z.infer<typeof SealedResponseSchema>;
export const BridgePayloadSchema = z.discriminatedUnion("outcome", [
	z.strictObject({ outcome: z.literal("uncertain") }),
	z.strictObject({
		outcome: z.literal("http"),
		status: z.number().int().min(200).max(599),
		headers: z.record(z.string(), z.string()),
		body: z.string(),
	}),
]);
export type BridgePayload = z.infer<typeof BridgePayloadSchema>;
export function containsControl(value: string, includeSpace = false): boolean {
	for (const character of value) {
		const code = character.codePointAt(0);
		if (
			code !== undefined &&
			(code <= (includeSpace ? 32 : 31) || code === 127)
		)
			return true;
	}
	return false;
}
function buffer(value: string) {
	return Buffer.from(z.string().regex(B64).parse(value), "base64url");
}
export function fingerprint(key: BridgeKey) {
	return createHash("sha256")
		.update(createPublicKey(key).export({ format: "der", type: "spki" }))
		.digest("hex");
}
function requestArray(q: BridgeRequest) {
	return [
		q.version,
		q.id,
		q.issuedAt,
		q.notAfter,
		q.installationId,
		q.repositoryId,
		q.runId,
		q.runAttempt,
		q.sourceSha,
		q.workerKey,
		q.controllerKey,
		q.method,
		q.path,
		q.body,
		q.ifNoneMatch,
		q.capability,
	];
}
export function requestDigest(q: BridgeRequest) {
	return createHash("sha256")
		.update(JSON.stringify(requestArray(q)))
		.digest("hex");
}
function requestBytes(q: BridgeRequest) {
	return Buffer.from(JSON.stringify(requestArray(q)));
}
export function signRequest(
	q: BridgeRequest,
	privateKey: BridgeKey,
): SignedRequest {
	BridgeRequestSchema.parse(q);
	if (fingerprint(privateKey) !== q.workerKey)
		throw new Error("signing key mismatch");
	return {
		request: q,
		signature: sign("sha256", requestBytes(q), {
			key: createPrivateKey(privateKey),
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		}).toString("base64url"),
	};
}
export function verifyRequest(
	envelope: SignedRequest,
	{
		workerPublicKey,
		controllerPublicKey,
		installationId,
		runId,
		runAttempt,
		sourceSha,
		now = Date.now(),
	}: BridgeIdentity & {
		workerPublicKey: BridgeKey;
		controllerPublicKey: BridgeKey;
		now?: number;
	},
) {
	const parsed = SignedRequestSchema.parse(envelope);
	const q = parsed.request;
	if (
		fingerprint(workerPublicKey) !== q.workerKey ||
		fingerprint(controllerPublicKey) !== q.controllerKey ||
		q.installationId !== installationId ||
		q.runId !== runId ||
		q.runAttempt !== runAttempt ||
		q.sourceSha !== sourceSha
	)
		throw new Error("identity mismatch");
	if (
		!Number.isSafeInteger(now) ||
		q.issuedAt > now + 5000 ||
		q.notAfter <= now ||
		q.notAfter <= q.issuedAt ||
		q.notAfter - q.issuedAt > MAX_REQUEST_TTL_MS
	)
		throw new Error("expired request");
	if (
		!verify(
			"sha256",
			requestBytes(q),
			{
				key: createPublicKey(workerPublicKey),
				padding: constants.RSA_PKCS1_PSS_PADDING,
				saltLength: 32,
			},
			buffer(parsed.signature),
		)
	)
		throw new Error("invalid signature");
	validateScope(q);
	return q;
}
export function validateScope(q: BridgeRequest) {
	if (
		q.path.length > 2048 ||
		!q.path.startsWith("/") ||
		q.path.startsWith("//") ||
		q.path.includes("\\") ||
		containsControl(q.path, true)
	)
		throw new Error("scope denied");
	const url = new URL(q.path, "https://api.github.com");
	if (
		url.origin !== "https://api.github.com" ||
		url.hash ||
		url.pathname.includes("%") ||
		url.pathname.includes("\\") ||
		containsControl(url.pathname, true) ||
		!url.pathname.startsWith(`/repos/${REPOSITORY}/`)
	)
		throw new Error("scope denied");
	const suffix = url.pathname.slice(`/repos/${REPOSITORY}/`.length);
	const allowedQuery = new Map([
		["status", /^(queued|in_progress|completed)$/],
		["per_page", /^(?:[1-9]|[1-9][0-9]|100)$/],
		["page", /^[1-9][0-9]{0,2}$/],
		["filter", /^(latest|all)$/],
		["created", /^>=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/],
		["event", /^workflow_dispatch$/],
	]);
	const seen = new Set();
	for (const [k, v] of url.searchParams) {
		if (seen.has(k) || !allowedQuery.get(k)?.test(v))
			throw new Error("scope denied");
		seen.add(k);
	}
	if (
		q.ifNoneMatch !== null &&
		(q.method !== "GET" ||
			q.ifNoneMatch.length > 1024 ||
			containsControl(q.ifNoneMatch))
	)
		throw new Error("scope denied");
	let kind: "read" | "jit" | "mutation" = "read";
	if (q.method === "GET") {
		if (
			!/^actions\/(?:runs(?:\/[1-9][0-9]*(?:\/jobs)?)?|jobs\/[1-9][0-9]*|runners(?:\/[1-9][0-9]*)?)$/.test(
				suffix,
			) ||
			q.body !== null ||
			q.capability !== null
		)
			throw new Error("scope denied");
	} else if (
		q.method === "POST" &&
		suffix === "actions/runners/generate-jitconfig"
	) {
		if (
			url.search ||
			q.ifNoneMatch !== null ||
			q.body === null ||
			q.capability === null
		)
			throw new Error("scope denied");
		const parsed = z
			.strictObject({
				name: z.string().regex(/^hobo-[A-Za-z0-9_-]{1,100}$/),
				runner_group_id: positiveInt,
				labels: z.tuple([z.enum(["hobo", "hobo-trunk"])]),
				work_folder: z.literal("_hobo_work"),
			})
			.safeParse(JSON.parse(q.body));
		if (!parsed.success) throw new Error("scope denied");
		kind = "jit";
	} else if (
		q.method === "POST" &&
		/^actions\/runs\/[1-9][0-9]*\/(?:force-cancel|rerun-failed-jobs)$/.test(
			suffix,
		)
	) {
		if (
			url.search ||
			q.ifNoneMatch !== null ||
			!(q.body === null || q.body === "{}") ||
			q.capability === null
		)
			throw new Error("scope denied");
		kind = "mutation";
	} else if (
		q.method === "DELETE" &&
		/^actions\/runners\/[1-9][0-9]*$/.test(suffix)
	) {
		if (
			url.search ||
			q.ifNoneMatch !== null ||
			q.body !== null ||
			q.capability === null
		)
			throw new Error("scope denied");
		kind = "mutation";
	} else throw new Error("scope denied");
	return { url, kind };
}
function responseBytes(s: Omit<SealedResponse, "signature">) {
	return Buffer.from(
		JSON.stringify([
			s.version,
			s.id,
			s.requestHash,
			s.workerKey,
			s.controllerKey,
			s.encryptedKey,
			s.iv,
			s.ciphertext,
			s.tag,
		]),
	);
}
export function sealResponse(
	q: BridgeRequest,
	payload: BridgePayload,
	{
		workerPublicKey,
		controllerPrivateKey,
	}: { workerPublicKey: BridgeKey; controllerPrivateKey: BridgeKey },
) {
	if (
		fingerprint(workerPublicKey) !== q.workerKey ||
		fingerprint(controllerPrivateKey) !== q.controllerKey
	)
		throw new Error("identity mismatch");
	const raw = Buffer.from(JSON.stringify(payload));
	if (raw.length > MAX_BODY_BYTES * 2) throw new Error("response too large");
	const key = randomBytes(32),
		iv = randomBytes(12),
		hash = requestDigest(q);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(`hobo-ci-bootstrap-v1:${q.id}:${hash}`));
	const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
	const sealed: Omit<SealedResponse, "signature"> = {
		version: VERSION,
		id: q.id,
		requestHash: hash,
		workerKey: q.workerKey,
		controllerKey: q.controllerKey,
		encryptedKey: publicEncrypt(
			{ key: createPublicKey(workerPublicKey), oaepHash: "sha256" },
			key,
		).toString("base64url"),
		iv: iv.toString("base64url"),
		ciphertext: ciphertext.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
	};
	return {
		...sealed,
		signature: sign("sha256", responseBytes(sealed), {
			key: createPrivateKey(controllerPrivateKey),
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		}).toString("base64url"),
	};
}
export function openResponse(
	q: BridgeRequest,
	input: SealedResponse,
	{
		workerPrivateKey,
		controllerPublicKey,
	}: { workerPrivateKey: BridgeKey; controllerPublicKey: BridgeKey },
) {
	const sealed = SealedResponseSchema.parse(input);
	if (
		sealed.version !== VERSION ||
		sealed.id !== q.id ||
		sealed.requestHash !== requestDigest(q) ||
		sealed.workerKey !== q.workerKey ||
		sealed.controllerKey !== q.controllerKey ||
		fingerprint(workerPrivateKey) !== q.workerKey ||
		fingerprint(controllerPublicKey) !== q.controllerKey
	)
		throw new Error("identity mismatch");
	if (
		!verify(
			"sha256",
			responseBytes(sealed),
			{
				key: createPublicKey(controllerPublicKey),
				padding: constants.RSA_PKCS1_PSS_PADDING,
				saltLength: 32,
			},
			buffer(sealed.signature),
		)
	)
		throw new Error("invalid signature");
	const key = privateDecrypt(
		{ key: createPrivateKey(workerPrivateKey), oaepHash: "sha256" },
		buffer(sealed.encryptedKey),
	);
	const decipher = createDecipheriv("aes-256-gcm", key, buffer(sealed.iv));
	decipher.setAAD(
		Buffer.from(`hobo-ci-bootstrap-v1:${q.id}:${sealed.requestHash}`),
	);
	decipher.setAuthTag(buffer(sealed.tag));
	const raw = Buffer.concat([
		decipher.update(buffer(sealed.ciphertext)),
		decipher.final(),
	]);
	if (raw.length > MAX_BODY_BYTES * 2) throw new Error("response too large");
	return BridgePayloadSchema.parse(JSON.parse(raw.toString("utf8")));
}
