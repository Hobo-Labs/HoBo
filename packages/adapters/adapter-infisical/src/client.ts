/**
 * The Infisical HTTP client: one login, an access token cached in memory until
 * shortly before it expires, bounded retries, and no logging. Endpoints used
 * (Infisical API reference):
 *
 * - POST /api/v1/auth/oidc-auth/login       https://infisical.com/docs/api-reference/endpoints/oidc-auth/login
 * - POST /api/v1/auth/universal-auth/login  https://infisical.com/docs/api-reference/endpoints/universal-auth/login
 * - GET  /api/v4/secrets                    https://infisical.com/docs/api-reference/endpoints/secrets/list
 * - GET  /api/v4/secrets/{secretName}       https://infisical.com/docs/api-reference/endpoints/secrets/read
 * - POST /api/v4/secrets/{secretName}       https://infisical.com/docs/api-reference/endpoints/secrets/create
 * - PATCH /api/v4/secrets/{secretName}      https://infisical.com/docs/api-reference/endpoints/secrets/update
 *
 * Reads ask for literal values (`expandSecretReferences=false`) from the bound
 * folder only (`includeImports=false`, `recursive=false`), so what the relay
 * reads is exactly what was written there.
 */

import { create, type JsonValue, toJsonString } from "@bufbuild/protobuf";
import {
	InfisicalOidcLoginRequestSchema,
	InfisicalSecretWriteRequestSchema,
	InfisicalUniversalAuthLoginRequestSchema,
} from "./_generated/adapter_infisical_pb.js";
import type { InfisicalAuth } from "./auth.js";
import { parseJwt } from "./auth.js";
import {
	type ParsedInfisicalBinding,
	parseInfisicalSecretKey,
} from "./binding.js";
import { InfisicalError, requestIdOf } from "./errors.js";
import {
	type ParsedSecret,
	type ParsedSecretName,
	parseLogin,
	parseSecretEnvelope,
	parseSecretList,
	parseSecretNames,
	parseWrittenVersion,
} from "./wire.js";

export type InfisicalRetryPolicy = Readonly<{
	/** Attempts per request, the first included. Default 4. */
	attempts: number;
	/** First backoff; doubles per attempt. Default 250 ms. */
	baseDelayMs: number;
	/** Cap on one wait, `Retry-After` included. Default 5 s. */
	maxDelayMs: number;
}>;

export type InfisicalClientOptions = Readonly<{
	binding: ParsedInfisicalBinding;
	auth: InfisicalAuth;
	fetch?: typeof fetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	retry?: Partial<InfisicalRetryPolicy>;
	/** Per HTTP request. Default 10 s. */
	timeoutMs?: number;
}>;

export interface InfisicalClient {
	readonly binding: ParsedInfisicalBinding;
	/** Every secret in the bound folder, values included, in one request. */
	listSecrets(): Promise<readonly ParsedSecret[]>;
	/** Keys and versions only (`viewSecretValue=false`). */
	listSecretNames(): Promise<readonly ParsedSecretName[]>;
	getSecret(name: string, version?: number): Promise<ParsedSecret>;
	/** Update the secret, or create it when it does not exist. */
	putSecret(name: string, value: string): Promise<{ version: number }>;
	/** Drop the cached access token; the next request logs in again. */
	signOut(): void;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

type Answer = Readonly<{ status: number; body: JsonValue | undefined }>;

async function readBody(response: Response): Promise<JsonValue | undefined> {
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				void reader.cancel().catch(() => undefined);
				return undefined;
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (size === 0) return undefined;
	try {
		const parsed: JsonValue = JSON.parse(
			Buffer.concat(chunks).toString("utf8"),
		);
		return parsed;
	} catch {
		return undefined;
	}
}

function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header || !/^\d{1,6}$/u.test(header)) return undefined;
	return Number(header) * 1000;
}

function failure(operation: string, answer: Answer): InfisicalError {
	const reqId = requestIdOf(answer.body);
	const details = { status: answer.status, reqId };
	switch (answer.status) {
		case 400:
		case 422:
			return new InfisicalError(operation, "rejected", details);
		case 401:
			return new InfisicalError(operation, "unauthorized", details);
		case 403:
			return new InfisicalError(operation, "forbidden", details);
		case 404:
			return new InfisicalError(operation, "not-found", details);
		case 429:
			return new InfisicalError(operation, "rate-limited", {
				...details,
				retryable: true,
			});
		default:
			return new InfisicalError(operation, "unavailable", {
				...details,
				retryable: answer.status >= 500,
			});
	}
}

export function createInfisicalClient(
	options: InfisicalClientOptions,
): InfisicalClient {
	const { binding, auth } = options;
	const send = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const retry: InfisicalRetryPolicy = {
		attempts: Math.max(1, Math.min(options.retry?.attempts ?? 4, 10)),
		baseDelayMs: Math.max(0, options.retry?.baseDelayMs ?? 250),
		maxDelayMs: Math.max(0, options.retry?.maxDelayMs ?? 5000),
	};
	const timeoutMs = options.timeoutMs ?? 10_000;

	let cached: { token: string; refreshAtMs: number } | undefined =
		auth.method === "access-token"
			? { token: auth.accessToken, refreshAtMs: Number.POSITIVE_INFINITY }
			: undefined;
	let pendingLogin: Promise<string> | undefined;

	/** One HTTP exchange with bounded retries on 429, 5xx and transport errors. */
	async function exchange(
		operation: string,
		method: "GET" | "POST" | "PATCH",
		path: string,
		headers: Record<string, string>,
		body: string | undefined,
	): Promise<Answer> {
		let last: InfisicalError | undefined;
		for (let attempt = 1; attempt <= retry.attempts; attempt++) {
			let waitMs = Math.min(
				retry.maxDelayMs,
				retry.baseDelayMs * 2 ** (attempt - 1),
			);
			try {
				const response = await send(`${binding.siteUrl}${path}`, {
					method,
					headers: {
						accept: "application/json",
						...(body === undefined
							? undefined
							: { "content-type": "application/json" }),
						...headers,
					},
					...(body === undefined ? undefined : { body }),
					redirect: "error",
					signal: AbortSignal.timeout(timeoutMs),
				});
				const answer: Answer = {
					status: response.status,
					body: await readBody(response),
				};
				if (response.ok || !RETRYABLE_STATUS.has(response.status))
					return answer;
				last = failure(operation, answer);
				const hinted = retryAfterMs(response);
				if (hinted !== undefined) waitMs = Math.min(retry.maxDelayMs, hinted);
			} catch {
				// The cause is not kept: a transport error may quote the request.
				last = new InfisicalError(operation, "unavailable", {
					retryable: true,
				});
			}
			if (attempt < retry.attempts) await sleep(waitMs);
		}
		throw last ?? new InfisicalError(operation, "unavailable");
	}

	async function login(): Promise<string> {
		if (auth.method === "access-token") return auth.accessToken;
		let path: string;
		let payload: string;
		if (auth.method === "oidc") {
			let jwt: string;
			try {
				jwt = parseJwt(await auth.jwt());
			} catch {
				throw new InfisicalError("login", "jwt-unavailable");
			}
			path = "/api/v1/auth/oidc-auth/login";
			payload = toJsonString(
				InfisicalOidcLoginRequestSchema,
				create(InfisicalOidcLoginRequestSchema, {
					identityId: auth.identityId,
					jwt,
				}),
			);
		} else {
			path = "/api/v1/auth/universal-auth/login";
			payload = toJsonString(
				InfisicalUniversalAuthLoginRequestSchema,
				create(InfisicalUniversalAuthLoginRequestSchema, {
					clientId: auth.clientId,
					clientSecret: auth.clientSecret,
				}),
			);
		}
		const startedAt = now();
		const answer = await exchange("login", "POST", path, {}, payload);
		if (answer.status !== 200) {
			const error = failure("login", answer);
			if (["rejected", "unauthorized", "forbidden"].includes(error.code))
				throw new InfisicalError("login", "login-denied", {
					status: answer.status,
					reqId: error.reqId,
				});
			throw error;
		}
		if (answer.body === undefined)
			throw new InfisicalError("login", "invalid-response");
		const parsed = parseLogin(answer.body);
		const lifetimeMs = parsed.expiresIn * 1000;
		// Refresh before expiry: a tenth of the lifetime, at most a minute.
		cached = {
			token: parsed.accessToken,
			refreshAtMs: startedAt + lifetimeMs - Math.min(60_000, lifetimeMs / 10),
		};
		return parsed.accessToken;
	}

	async function accessToken(): Promise<string> {
		if (cached && now() < cached.refreshAtMs) return cached.token;
		pendingLogin ??= login().finally(() => {
			pendingLogin = undefined;
		});
		return pendingLogin;
	}

	/** An authenticated request; one fresh login after a 401. */
	async function request(
		operation: string,
		method: "GET" | "POST" | "PATCH",
		path: string,
		payload?: string,
	): Promise<Answer> {
		for (let round = 0; ; round++) {
			const token = await accessToken();
			const answer = await exchange(
				operation,
				method,
				path,
				{ authorization: `Bearer ${token}` },
				payload,
			);
			if (
				answer.status === 401 &&
				round === 0 &&
				auth.method !== "access-token"
			) {
				if (cached?.token === token) cached = undefined;
				continue;
			}
			return answer;
		}
	}

	function scope(extra: Record<string, string> = {}): string {
		return new URLSearchParams({
			projectId: binding.projectId,
			environment: binding.environment,
			secretPath: binding.secretPath,
			...extra,
		}).toString();
	}

	const literal = {
		expandSecretReferences: "false",
		includeImports: "false",
	};

	function secretPath(name: string, query?: string): string {
		const key = parseInfisicalSecretKey(name);
		return `/api/v4/secrets/${encodeURIComponent(key)}${
			query === undefined ? "" : `?${query}`
		}`;
	}

	function ok(operation: string, answer: Answer): JsonValue {
		if (answer.status !== 200) throw failure(operation, answer);
		if (answer.body === undefined)
			throw new InfisicalError(operation, "invalid-response");
		return answer.body;
	}

	return {
		binding,
		async listSecrets() {
			const answer = await request(
				"list secrets",
				"GET",
				`/api/v4/secrets?${scope({
					viewSecretValue: "true",
					recursive: "false",
					...literal,
				})}`,
			);
			return parseSecretList("list secrets", ok("list secrets", answer));
		},
		async listSecretNames() {
			const answer = await request(
				"list secret names",
				"GET",
				`/api/v4/secrets?${scope({
					viewSecretValue: "false",
					recursive: "false",
					...literal,
				})}`,
			);
			return parseSecretNames(
				"list secret names",
				ok("list secret names", answer),
			);
		},
		async getSecret(name, version) {
			if (
				version !== undefined &&
				(!Number.isSafeInteger(version) || version < 1)
			)
				throw new InfisicalError("read secret", "invalid-input");
			const query = new URLSearchParams(
				scope({ type: "shared", viewSecretValue: "true", ...literal }),
			);
			if (version !== undefined) query.set("version", String(version));
			const answer = await request(
				"read secret",
				"GET",
				secretPath(name, query.toString()),
			);
			return parseSecretEnvelope("read secret", ok("read secret", answer));
		},
		async putSecret(name, value) {
			const target = secretPath(name);
			const body = toJsonString(
				InfisicalSecretWriteRequestSchema,
				create(InfisicalSecretWriteRequestSchema, {
					projectId: binding.projectId,
					environment: binding.environment,
					secretPath: binding.secretPath,
					secretValue: value,
					type: "shared",
				}),
				{ alwaysEmitImplicit: true },
			);
			const updated = await request("write secret", "PATCH", target, body);
			if (updated.status !== 404)
				return {
					version: parseWrittenVersion(
						"write secret",
						ok("write secret", updated),
					),
				};
			const created = await request("write secret", "POST", target, body);
			return {
				version: parseWrittenVersion(
					"write secret",
					ok("write secret", created),
				),
			};
		},
		signOut() {
			if (auth.method !== "access-token") cached = undefined;
		},
	};
}
