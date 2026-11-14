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
 * - POST /api/v1/auth/token/revoke          https://infisical.com/docs/api-reference/endpoints/universal-auth/revoke-access-token
 *
 * Reads ask for literal values (`expandSecretReferences=false`) from the bound
 * folder only (`includeImports=false`, `recursive=false`), so what the relay
 * reads is exactly what was written there.
 */

import { create, type JsonValue, toJsonString } from "@bufbuild/protobuf";
import {
	InfisicalOidcLoginRequestSchema,
	InfisicalSecretWriteRequestSchema,
	InfisicalTokenRevokeRequestSchema,
	InfisicalUniversalAuthLoginRequestSchema,
} from "./_generated/adapter_infisical_pb.js";
import type { InfisicalAuth } from "./auth.js";
import { parseJwt } from "./auth.js";
import {
	type ParsedInfisicalBinding,
	parseInfisicalBinding,
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
	/**
	 * Log in now (or reuse the cached access token) and say when the token
	 * expires. A failed login throws `login-denied`; nothing is retried with
	 * other credentials. Used to prove a credential works before a write.
	 */
	signIn(): Promise<Readonly<{ expiresAtMs: number }>>;
	/**
	 * End the access token this client obtained by logging in
	 * (`POST /api/v1/auth/token/revoke`) and forget it. A client given an
	 * access token by its owner (`access-token` auth) never revokes it: the
	 * token is not this client's to end. Resolves when there is nothing to end.
	 */
	revoke(): Promise<void>;
	/**
	 * The same sign-in, bound to another project, environment or folder on
	 * the same Infisical origin: one login serves both, and `revoke` on either
	 * ends it for both. A different origin is refused (`invalid-input`).
	 */
	forBinding(binding: ParsedInfisicalBinding): InfisicalClient;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export type Answer = Readonly<{ status: number; body: JsonValue | undefined }>;

/** A bounded JSON body; undefined when empty, oversized or not JSON. */
export async function readBody(
	response: Response,
): Promise<JsonValue | undefined> {
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

/** The adapter error for a non-2xx answer. */
export function failure(operation: string, answer: Answer): InfisicalError {
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

interface InfisicalPlanControl {
	readOrganizationPlan(organizationId: string): Promise<{
		readonly slug: string | null;
		readonly limits: Readonly<{
			read: number;
			write: number;
			secrets: number;
		}>;
	}>;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
	if (Object.prototype.toString.call(value) !== "[object Object]")
		throw new InfisicalError("read organization plan", "invalid-response");
	// SAFETY: the response was parsed as JSON and the object tag excludes arrays and primitives.
	return value as Record<string, JsonValue>;
}

function planLimit(value: JsonValue | undefined): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new InfisicalError("read organization plan", "invalid-response");
	return Number(value);
}

class InfisicalPlanAdmissionError extends InfisicalError {
	constructor(code: "lease-unverified" | "budget-unavailable") {
		super("observe organization plan", code);
	}
}

function createInfisicalClientInternal(
	options: InfisicalClientOptions,
): InfisicalClient & InfisicalPlanControl {
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

	let cached:
		| { token: string; refreshAtMs: number; expiresAtMs: number }
		| undefined =
		auth.method === "access-token"
			? {
					token: auth.accessToken,
					refreshAtMs: Number.POSITIVE_INFINITY,
					expiresAtMs: Number.POSITIVE_INFINITY,
				}
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
			} catch (error) {
				if (error instanceof InfisicalPlanAdmissionError) throw error;
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
			expiresAtMs: startedAt + lifetimeMs,
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

	function build(
		bound: ParsedInfisicalBinding,
	): InfisicalClient & InfisicalPlanControl {
		function scope(extra: Record<string, string> = {}): string {
			return new URLSearchParams({
				projectId: bound.projectId,
				environment: bound.environment,
				secretPath: bound.secretPath,
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
			binding: bound,
			async readOrganizationPlan(organizationId) {
				const project = jsonRecord(
					ok(
						"read project",
						await request(
							"read project",
							"GET",
							`/api/v1/projects/${encodeURIComponent(bound.projectId)}`,
						),
					),
				);
				const account = jsonRecord(project.project);
				if (account.id !== bound.projectId || account.orgId !== organizationId)
					throw new InfisicalError("read project", "invalid-response");
				const body = jsonRecord(
					ok(
						"read organization plan",
						await request(
							"read organization plan",
							"GET",
							`/api/v1/organizations/${encodeURIComponent(organizationId)}/plan`,
						),
					),
				);
				const plan = jsonRecord(body.plan),
					limits = jsonRecord(plan.rateLimits);
				if (
					plan.slug !== null &&
					Object.prototype.toString.call(plan.slug) !== "[object String]"
				)
					throw new InfisicalError(
						"read organization plan",
						"invalid-response",
					);
				// SAFETY: the value is null or the JSON string checked above.
				const slug = plan.slug as string | null;
				if (slug !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(slug))
					throw new InfisicalError(
						"read organization plan",
						"invalid-response",
					);
				return Object.freeze({
					slug,
					limits: Object.freeze({
						read: planLimit(limits.readLimit),
						write: planLimit(limits.writeLimit),
						secrets: planLimit(limits.secretsLimit),
					}),
				});
			},
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
						projectId: bound.projectId,
						environment: bound.environment,
						secretPath: bound.secretPath,
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
			async signIn() {
				await accessToken();
				return Object.freeze({
					expiresAtMs: cached?.expiresAtMs ?? now(),
				});
			},
			async revoke() {
				if (auth.method === "access-token") return;
				const held = cached;
				cached = undefined;
				if (held === undefined) return;
				const answer = await exchange(
					"revoke token",
					"POST",
					"/api/v1/auth/token/revoke",
					{},
					toJsonString(
						InfisicalTokenRevokeRequestSchema,
						create(InfisicalTokenRevokeRequestSchema, {
							accessToken: held.token,
						}),
					),
				);
				if (answer.status !== 200) throw failure("revoke token", answer);
			},
			forBinding(other) {
				if (other.siteUrl !== binding.siteUrl)
					throw new InfisicalError("bind client", "invalid-input");
				return build(other);
			},
		};
	}

	return build(binding);
}

export function createInfisicalClient(
	options: InfisicalClientOptions,
): InfisicalClient {
	return createInfisicalClientInternal(options);
}

/** The exact provider account and workload identity enrolled by the host. */
export type InfisicalPlanLeaseScope = Readonly<{
	tenantId: string;
	leaseId: string;
	siteUrl: string;
	projectId: string;
	organizationId: string;
	rootOrganizationId: string;
	identityId: string;
}>;

export type InfisicalPlanAttempt = Readonly<{
	scope: InfisicalPlanLeaseScope;
	operation: "login" | "read-project" | "read-plan";
}>;

/** An API report, not proof of capacity, fresh billing or readiness. */
export type InfisicalPlanObservation = Readonly<{
	scope: InfisicalPlanLeaseScope;
	slug: string | null;
	limits: Readonly<{ read: number; write: number; secrets: number }>;
	observedAtMs: number;
	completedAtMs: number;
	providerFreshness: "unverified";
}>;

/**
 * Observe Infisical's project account and organization plan using an enrolled
 * OIDC identity. The host verifies the same lease before every wire attempt and
 * reserves and claims each attempt through its independently funded authority.
 * The verifier must independently bind the project's organization to its root
 * organization: Infisical's plan route returns the caller's root-org plan.
 *
 * The plan endpoint may return a cached or fallback plan without exposing its
 * age or fallback marker. A report therefore never establishes provider
 * freshness, remaining shared-IP capacity, pricing, settlement, or readiness.
 */
export function createInfisicalPlanObserver(options: {
	readonly client: Omit<InfisicalClientOptions, "auth" | "retry"> & {
		readonly auth: Extract<InfisicalAuth, { readonly method: "oidc" }>;
	};
	readonly tenantId: string;
	readonly leaseId: string;
	readonly organizationId: string;
	readonly rootOrganizationId: string;
	readonly verifyLease: (scope: InfisicalPlanLeaseScope) => Promise<void>;
	/** Return a guard that claims the funded attempt immediately before I/O. */
	readonly reserveAttempt: (
		attempt: InfisicalPlanAttempt,
	) => Promise<() => Promise<void>>;
}): Readonly<{ observe(): Promise<InfisicalPlanObservation> }> {
	const id = /^[A-Za-z0-9-]{1,64}$/u;
	if (
		!id.test(options.organizationId) ||
		!id.test(options.rootOrganizationId) ||
		!id.test(options.client.auth.identityId) ||
		!/^[\x21-\x7e]{1,256}$/u.test(options.tenantId) ||
		!/^[\x21-\x7e]{1,256}$/u.test(options.leaseId) ||
		!(options.verifyLease instanceof Function) ||
		!(options.reserveAttempt instanceof Function)
	)
		throw new InfisicalError("observe organization plan", "invalid-input");
	const binding = parseInfisicalBinding(options.client.binding);
	const auth = Object.freeze({ ...options.client.auth });
	const scope = Object.freeze({
		tenantId: options.tenantId,
		leaseId: options.leaseId,
		siteUrl: binding.siteUrl,
		projectId: binding.projectId,
		organizationId: options.organizationId,
		rootOrganizationId: options.rootOrganizationId,
		identityId: auth.identityId,
	});
	const verifyLease = options.verifyLease.bind(options);
	const reserveAttempt = options.reserveAttempt.bind(options);
	const send = options.client.fetch ?? fetch;
	const now = options.client.now ?? Date.now;
	async function verifyBoundLease(): Promise<void> {
		try {
			await verifyLease(scope);
		} catch {
			throw new InfisicalPlanAdmissionError("lease-unverified");
		}
	}
	const guardedFetch: typeof fetch = async (resource, init) => {
		const url = new URL(String(resource));
		if (
			url.origin !== scope.siteUrl ||
			url.search ||
			url.hash ||
			init?.redirect !== "error"
		)
			throw new InfisicalError("observe organization plan", "invalid-input");
		let operation: InfisicalPlanAttempt["operation"];
		if (
			init.method === "POST" &&
			url.pathname === "/api/v1/auth/oidc-auth/login"
		)
			operation = "login";
		else if (
			init.method === "GET" &&
			url.pathname === `/api/v1/projects/${encodeURIComponent(scope.projectId)}`
		)
			operation = "read-project";
		else if (
			init.method === "GET" &&
			url.pathname ===
				`/api/v1/organizations/${encodeURIComponent(scope.organizationId)}/plan`
		)
			operation = "read-plan";
		else throw new InfisicalError("observe organization plan", "invalid-input");
		await verifyBoundLease();
		try {
			const claim = await reserveAttempt(Object.freeze({ scope, operation }));
			await claim();
		} catch {
			throw new InfisicalPlanAdmissionError("budget-unavailable");
		}
		await verifyBoundLease();
		return send(resource, init);
	};
	const client = createInfisicalClientInternal({
		...options.client,
		binding,
		auth,
		fetch: guardedFetch,
		retry: { attempts: 1 },
	});
	function time(): number {
		const value = now();
		if (!Number.isSafeInteger(value) || value < 0)
			throw new InfisicalError("observe organization plan", "invalid-input");
		return value;
	}
	return Object.freeze({
		async observe() {
			await verifyBoundLease();
			const observedAtMs = time();
			try {
				const report = await client.readOrganizationPlan(scope.organizationId);
				await verifyBoundLease();
				const completedAtMs = time();
				if (completedAtMs < observedAtMs)
					throw new InfisicalError(
						"observe organization plan",
						"invalid-input",
					);
				return Object.freeze({
					scope,
					...report,
					observedAtMs,
					completedAtMs,
					providerFreshness: "unverified" as const,
				});
			} finally {
				client.signOut();
			}
		},
	});
}
