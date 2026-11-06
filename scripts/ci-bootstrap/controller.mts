import { createSign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
	APP_ID,
	type BridgeIdentity,
	type BridgeKey,
	type BridgePayload,
	BridgePayloadSchema,
	type BridgeRequest,
	containsControl,
	MAX_BODY_BYTES,
	REPOSITORY,
	REPOSITORY_ID,
	requestDigest,
	type SignedRequest,
	sealResponse,
	validateScope,
	verifyRequest,
} from "./protocol.mts";

export type BridgeFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface ControllerOptions extends BridgeIdentity {
	dbPath: string;
	appPrivateKey: BridgeKey;
	controllerPrivateKey: BridgeKey;
	controllerPublicKey: BridgeKey;
	workerPublicKey: BridgeKey;
	authorizeMutation?: (input: {
		request: BridgeRequest;
		digest: string;
		kind: "jit" | "mutation";
	}) => boolean | Promise<boolean>;
	trustSignedLocalAuthority?: boolean;
	fetchImpl?: BridgeFetch;
	clock?: () => number;
}
const COMMON = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2026-03-10",
	"Content-Type": "application/json",
};
const RESPONSE_HEADERS = new Set([
	"content-type",
	"etag",
	"link",
	"retry-after",
	"x-ratelimit-limit",
	"x-ratelimit-remaining",
	"x-ratelimit-reset",
	"x-github-request-id",
]);
function appJwt(privateKey: BridgeKey, now: number) {
	const issued = Math.floor(now / 1000) - 60;
	const head = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const data = Buffer.from(
		JSON.stringify({ iat: issued, exp: issued + 600, iss: APP_ID }),
	).toString("base64url");
	const input = `${head}.${data}`;
	return `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url")}`;
}
async function bodyLimit(response: Response) {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
		throw new Error("oversized");
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader(),
		chunks: Buffer[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) throw new Error("oversized");
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}
function safeBase64(value: string) {
	if (
		value.length > MAX_BODY_BYTES * 2 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	)
		throw new Error("invalid body");
	return value;
}
export function toResponse(input: BridgePayload) {
	const payload = BridgePayloadSchema.parse(input);
	if (payload.outcome !== "http") throw new Error("ambiguous remote result");
	const headers = new Headers();
	for (const [name, value] of Object.entries(payload.headers)) {
		if (!RESPONSE_HEADERS.has(name.toLowerCase()) || containsControl(value))
			throw new Error("invalid header");
		headers.set(name, value);
	}
	const bytes = Buffer.from(safeBase64(payload.body), "base64");
	return new Response([204, 205, 304].includes(payload.status) ? null : bytes, {
		status: payload.status,
		headers,
	});
}
/** Effect authority defaults closed. Trusting signatures alone is safe only if the pinned signer and its durable HoBo authority remain outside every untrusted worker VM. */
export function createController({
	dbPath,
	appPrivateKey,
	controllerPrivateKey,
	controllerPublicKey,
	workerPublicKey,
	installationId,
	runId,
	runAttempt,
	sourceSha,
	authorizeMutation,
	trustSignedLocalAuthority = false,
	fetchImpl = fetch,
	clock = Date.now,
}: ControllerOptions) {
	if (
		!dbPath ||
		!appPrivateKey ||
		!controllerPrivateKey ||
		!controllerPublicKey ||
		!workerPublicKey ||
		!Number.isSafeInteger(installationId) ||
		installationId <= 0
	)
		throw new Error("invalid configuration");
	const db = new DatabaseSync(dbPath);
	db.exec(
		"CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,reply TEXT)",
	);
	let token: string | undefined,
		tokenExpires = 0;
	async function verifyRepository(credential: string, requirePublic: boolean) {
		const identity = await fetchImpl(
			`https://api.github.com/repos/${REPOSITORY}`,
			{
				method: "GET",
				headers: { ...COMMON, Authorization: `Bearer ${credential}` },
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			},
		);
		if (!identity.ok) throw new Error("identity");
		const repo = z
			.object({ id: z.number(), private: z.boolean(), full_name: z.string() })
			.parse(JSON.parse((await bodyLimit(identity)).toString("utf8")));
		if (
			repo.id !== REPOSITORY_ID ||
			(requirePublic && repo.private !== false) ||
			repo.full_name.toLowerCase() !== REPOSITORY.toLowerCase()
		)
			throw new Error("identity");
	}
	async function installationToken() {
		const now = clock();
		if (token && tokenExpires > now + 60000) return token;
		const issued = await fetchImpl(
			`https://api.github.com/app/installations/${installationId}/access_tokens`,
			{
				method: "POST",
				headers: {
					...COMMON,
					Authorization: `Bearer ${appJwt(appPrivateKey, now)}`,
				},
				body: JSON.stringify({
					repository_ids: [REPOSITORY_ID],
					permissions: {
						actions: "write",
						administration: "write",
						contents: "read",
						metadata: "read",
					},
				}),
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			},
		);
		if (!issued.ok) throw new Error("auth");
		const parsed = z
			.object({ token: z.string().min(1), expires_at: z.string() })
			.parse(JSON.parse((await bodyLimit(issued)).toString("utf8")));
		const expires = Date.parse(parsed.expires_at);
		if (!parsed.token || !Number.isFinite(expires) || expires <= now + 60000)
			throw new Error("auth");
		await verifyRepository(parsed.token, false);
		token = parsed.token;
		tokenExpires = Math.min(expires, now + 50 * 60000);
		return token;
	}
	async function handle(envelope: SignedRequest) {
		const q = verifyRequest(envelope, {
			workerPublicKey,
			controllerPublicKey,
			installationId,
			runId,
			runAttempt,
			sourceSha,
			now: clock(),
		});
		const { url, kind } = validateScope(q);
		const digest = requestDigest(q);
		try {
			db.prepare("INSERT INTO requests(id,digest,reply) VALUES(?,?,NULL)").run(
				q.id,
				digest,
			);
		} catch (error) {
			if (
				!/unique/i.test(String(error instanceof Error ? error.message : error))
			)
				throw new Error("request journal failed");
			const existing = db
				.prepare("SELECT digest,reply FROM requests WHERE id=?")
				.get(q.id);
			if (existing?.digest !== digest) throw new Error("request collision");
			return existing.reply
				? JSON.parse(z.string().parse(existing.reply))
				: sealResponse(
						q,
						{ outcome: "uncertain" },
						{ workerPublicKey, controllerPrivateKey },
					);
		}
		let payload: BridgePayload;
		try {
			if (
				kind !== "read" &&
				!authorizeMutation &&
				trustSignedLocalAuthority !== true
			)
				throw new Error("no controller-owned authority");
			const auth = await installationToken();
			// New admissions require a public repo; cleanup remains possible after a visibility change.
			const newAdmission =
				kind === "jit" || url.pathname.endsWith("/rerun-failed-jobs");
			if (kind !== "read") await verifyRepository(auth, newAdmission);
			// Never trust a worker-supplied deadline or capability without independent durable claim verification.
			if (kind !== "read" && authorizeMutation !== undefined) {
				const decision = await authorizeMutation({ request: q, digest, kind });
				if (decision !== true) throw new Error("admission denied");
			}
			if (clock() >= q.notAfter) throw new Error("expired");
			const timeout = Math.min(15000, Math.max(1, q.notAfter - clock()));
			const headers = new Headers(COMMON);
			headers.set("Authorization", `Bearer ${auth}`);
			if (q.ifNoneMatch) headers.set("If-None-Match", q.ifNoneMatch);
			const init: RequestInit = {
				method: q.method,
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(timeout),
			};
			if (q.body !== null) init.body = q.body;
			const response = await fetchImpl(url.href, init);
			if (response.status === 401) {
				token = undefined;
				tokenExpires = 0;
			}
			const out: Record<string, string> = {};
			for (const [name, value] of response.headers)
				if (RESPONSE_HEADERS.has(name.toLowerCase()))
					out[name.toLowerCase()] = value;
			payload = {
				outcome: "http",
				status: response.status,
				headers: out,
				body: (await bodyLimit(response)).toString("base64"),
			};
		} catch {
			payload = { outcome: "uncertain" };
		}
		const sealed = sealResponse(q, payload, {
			workerPublicKey,
			controllerPrivateKey,
		});
		db.prepare("UPDATE requests SET reply=? WHERE id=? AND digest=?").run(
			JSON.stringify(sealed),
			q.id,
			digest,
		);
		return sealed;
	}
	return {
		handle,
		close() {
			db.close();
		},
	};
}
