/**
 * Account-owned Upstash Blob token exchange. The token is not an R2 key: the
 * Upstash credential service issues a short-lived bucket-scoped S3 session.
 * The independently observed physical endpoint and bucket are pinned before
 * any session credential leaves this adapter. Upstash Blob remains the owning
 * Yard; Cloudflare R2 is a shared underlying failure domain.
 *
 * Protocol: https://upstash.com/docs/blob/reference/signing and the published
 * @upstash/blob 0.0.13 credential response. The injected transport must not
 * follow redirects; the shared guard refuses redirect responses.
 */
import { guardTransport, type HttpTransport } from "@hobo/core";
import type { AwsCredentials } from "@hobo/core/aws-sigv4";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "./json.js";

const PATH = "/v1/credentials";
const MARGIN_MS = 30_000;
const MAX_RESPONSE_BYTES = 16_384;

export class UpstashBlobCredentialError extends Error {
	constructor(readonly reason: string) {
		super(`Upstash Blob credential exchange failed (${reason})`);
		this.name = "UpstashBlobCredentialError";
	}
}

export type UpstashBlobCredentialOptions = Readonly<{
	/** The account and bucket are supplied by independent provider observation. */
	upstashAccountId: string;
	bucketId: string;
	/** R2 account serving this Upstash-owned bucket, observed independently. */
	r2AccountId: string;
	resolveToken(): Promise<string>;
	transport: HttpTransport;
	now(): number;
	/** Reserve a mint; legacy callbacks claim immediately before I/O. */
	reserveMint(): Promise<
		| (() => Promise<void>)
		| Readonly<{ claim(): Promise<void>; revalidate(): Promise<void> }>
	>;
}>;

/** Upstash and the underlying R2 provider are both outage domains. */
export function upstashBlobFailureDomains(
	accountId: string,
	r2AccountId: string,
): readonly string[] {
	if (
		!/^[A-Za-z0-9._:-]{1,200}$/u.test(accountId) ||
		!/^[a-f0-9]{32}$/u.test(r2AccountId)
	)
		throw new UpstashBlobCredentialError("invalid-scope");
	return [
		`upstash:${accountId}`,
		"cloudflare",
		"cloudflare:r2",
		`cloudflare:r2:${r2AccountId}`,
	];
}

/** A per-binding cache, shared by callers only while the custody token is unchanged. */
export function createUpstashBlobCredentials(
	options: UpstashBlobCredentialOptions,
): Readonly<{
	resolveCredentials(): Promise<AwsCredentials>;
	resolveSession(): Promise<
		Readonly<{
			credentials: AwsCredentials;
			observedAtMs: number;
			expiresAtMs: number;
		}>
	>;
}> {
	upstashBlobFailureDomains(options.upstashAccountId, options.r2AccountId);
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(options.bucketId))
		throw new UpstashBlobCredentialError("invalid-scope");
	const endpoint = `https://${options.r2AccountId}.r2.cloudflarestorage.com`;
	const transport = guardTransport(options.transport, {
		allowedHosts: ["blob.upstash.io"],
		allowedPathPrefixes: [PATH],
		maxTimeoutMs: 10_000,
		maxResponseBytes: MAX_RESPONSE_BYTES,
	});
	type Session = {
		token: string;
		credentials: AwsCredentials;
		expiresAt: number;
		observedAt: number;
	};
	let cached: Session | undefined;
	let latestToken: string | undefined;
	const pending = new Map<string, Promise<Session>>();
	function now() {
		const at = options.now();
		if (!Number.isSafeInteger(at) || at < 0)
			throw new UpstashBlobCredentialError("invalid-clock");
		return at;
	}
	async function mint(token: string): Promise<Session> {
		let admission: Awaited<
			ReturnType<UpstashBlobCredentialOptions["reserveMint"]>
		>;
		try {
			admission = await options.reserveMint();
			if (admission instanceof Function) await admission();
			else await admission.claim();
		} catch {
			throw new UpstashBlobCredentialError("budget-unavailable");
		}
		let response: Awaited<ReturnType<HttpTransport>>;
		try {
			response = await transport({
				method: "POST",
				url: `https://blob.upstash.io${PATH}`,
				headers: { authorization: `Bearer ${token}` },
				timeoutMs: 10_000,
				maxResponseBytes: MAX_RESPONSE_BYTES,
			});
			if (!(admission instanceof Function)) await admission.revalidate();
		} catch {
			throw new UpstashBlobCredentialError("unavailable");
		}
		if (response.status !== 200)
			throw new UpstashBlobCredentialError("rejected");
		let value: ReturnType<typeof parseJsonValue>;
		try {
			value = parseJsonValue(response.body);
		} catch {
			throw new UpstashBlobCredentialError("invalid-response");
		}
		if (
			!isJsonObject(value) ||
			value.endpoint !== endpoint ||
			value.bucket !== options.bucketId ||
			value.region !== "auto" ||
			value.visibility !== "private" ||
			!isJsonString(value.accessKeyId) ||
			!/^[\x21-\x7e]{1,4096}$/u.test(value.accessKeyId) ||
			!isJsonString(value.secretAccessKey) ||
			!/^[\x21-\x7e]{1,4096}$/u.test(value.secretAccessKey) ||
			!isJsonString(value.sessionToken) ||
			!/^[\x21-\x7e]{1,8192}$/u.test(value.sessionToken) ||
			!isJsonNumber(value.expiresAt) ||
			!Number.isSafeInteger(value.expiresAt)
		)
			throw new UpstashBlobCredentialError("scope-mismatch");
		const observedAt = now();
		const expiresAt = value.expiresAt * 1000;
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= observedAt + MARGIN_MS)
			throw new UpstashBlobCredentialError("expired");
		return {
			token,
			credentials: Object.freeze({
				accessKeyId: value.accessKeyId,
				secretAccessKey: value.secretAccessKey,
				sessionToken: value.sessionToken,
			}),
			expiresAt,
			observedAt,
		};
	}
	async function resolveSession() {
		let token: string;
		try {
			token = await options.resolveToken();
		} catch {
			throw new UpstashBlobCredentialError("credential-unavailable");
		}
		if (!/^[A-Za-z0-9_-]{8,8192}$/u.test(token))
			throw new UpstashBlobCredentialError("credential-unavailable");
		latestToken = token;
		const at = now();
		if (
			cached?.token === token &&
			at >= cached.observedAt &&
			at + MARGIN_MS < cached.expiresAt
		)
			return Object.freeze({
				credentials: cached.credentials,
				observedAtMs: cached.observedAt,
				expiresAtMs: cached.expiresAt,
			});
		let promise = pending.get(token);
		if (!promise) {
			promise = mint(token).finally(() => pending.delete(token));
			pending.set(token, promise);
		}
		const session = await promise;
		const current = now();
		if (latestToken !== token)
			throw new UpstashBlobCredentialError("credential-rotated");
		if (
			current < session.observedAt ||
			current + MARGIN_MS >= session.expiresAt
		)
			throw new UpstashBlobCredentialError("expired");
		cached = session;
		return Object.freeze({
			credentials: session.credentials,
			observedAtMs: session.observedAt,
			expiresAtMs: session.expiresAt,
		});
	}
	return Object.freeze({
		resolveSession,
		async resolveCredentials() {
			return (await resolveSession()).credentials;
		},
	});
}
