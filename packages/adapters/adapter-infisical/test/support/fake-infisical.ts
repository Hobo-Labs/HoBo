/**
 * A local stand-in for the Infisical API: OIDC and Universal Auth login, the
 * v4 secrets endpoints, per-token read/write permission, token revocation
 * (expiry as the server sees it) and injected 401/403/429/5xx answers. The
 * same `handle` serves HTTP for unit tests and answers the pact's recorded
 * requests in the provider verification, so the fake cannot drift from the
 * pact unnoticed. Request bodies are read with the same generated records the
 * adapter writes them with.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	InfisicalOidcLoginRequestSchema,
	InfisicalSecretWriteRequestSchema,
	InfisicalTokenRevokeRequestSchema,
	InfisicalUniversalAuthLoginRequestSchema,
} from "../../src/_generated/adapter_infisical_pb.js";

export type FakeRequest = Readonly<{
	method: string;
	path: string;
	headers?: Readonly<Record<string, string>>;
	body?: JsonValue | undefined;
}>;

export type FakeResponse = {
	status: number;
	headers?: Record<string, string>;
	body?: JsonValue;
};

/**
 * `write-only` is a custom role that may create and edit secrets in a folder
 * but not read them back: the capture writer's role.
 */
type Access = "read" | "write" | "write-only";

type Identity =
	| { kind: "oidc"; identityId: string; jwt: string; access: Access }
	| {
			kind: "universal-auth";
			clientId: string;
			clientSecret: string;
			access: Access;
			/** Infisical's `numUsesLimit` on the client secret; absent is unlimited. */
			usesLeft?: number;
	  };

type Fault = Readonly<{
	match: (request: FakeRequest) => boolean;
	response: FakeResponse;
}>;

export type RecordedRequest = Readonly<{
	method: string;
	path: string;
	authorized: boolean;
	body: JsonValue | undefined;
}>;

export type FakeInfisical = {
	readonly identities: Identity[];
	readonly requests: RecordedRequest[];
	/** Tokens the fake issued, so tests can assert none leaked. */
	readonly issuedTokens: string[];
	/** Tokens ended through `POST /api/v1/auth/token/revoke`. */
	readonly revokedTokens: string[];
	expiresIn: number;
	/** Tokens the next logins issue, in order, before random ones. */
	nextTokens: string[];
	/** Accept `token` with `access` (a token another login issued). */
	grant(token: string, access: Access): void;
	tokenFor(access: Access): string;
	/** The server forgets every token: the next request answers 401. */
	revokeTokens(): void;
	seed(
		scope: Scope,
		key: string,
		value: string,
		options?: { hidden?: boolean },
	): void;
	value(scope: Scope, key: string): string | undefined;
	/** Answer the next `times` matching requests with `response`. */
	fail(
		match: (request: FakeRequest) => boolean,
		response: FakeResponse,
		times?: number,
	): void;
	handle(request: FakeRequest): FakeResponse;
	listen(): Promise<{ url: string; close: () => Promise<void> }>;
};

export type Scope = Readonly<{
	projectId: string;
	environment: string;
	secretPath: string;
}>;

type Stored = { versions: string[]; hidden: boolean };

const ERROR_NAMES = new Map([
	[400, "BadRequest"],
	[401, "UnauthorizedError"],
	[403, "PermissionDenied"],
	[404, "NotFound"],
	[429, "RateLimitExceeded"],
]);

function error(status: number, message: string): FakeResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: {
			reqId: `req-${status}`,
			statusCode: status,
			error: ERROR_NAMES.get(status) ?? "InternalServerError",
			message,
		},
	};
}

function json(body: JsonValue): FakeResponse {
	return {
		status: 200,
		headers: { "content-type": "application/json" },
		body,
	};
}

function scopeKey(scope: Scope): string {
	return `${scope.projectId}|${scope.environment}|${scope.secretPath}`;
}

/** Parse a request body into a generated record; undefined when it is not one. */
function record<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

export function createFakeInfisical(): FakeInfisical {
	const identities: Identity[] = [];
	const tokens = new Map<string, Access>();
	const issuedTokens: string[] = [];
	const store = new Map<string, Map<string, Stored>>();
	const faults: { fault: Fault; remaining: number }[] = [];
	const requests: RecordedRequest[] = [];
	const revokedTokens: string[] = [];

	function folder(scope: Scope): Map<string, Stored> {
		const key = scopeKey(scope);
		let entries = store.get(key);
		if (!entries) {
			entries = new Map();
			store.set(key, entries);
		}
		return entries;
	}

	function issue(access: Access, expiresIn: number): FakeResponse {
		const token =
			fake.nextTokens.shift() ?? `fake-at-${randomBytes(12).toString("hex")}`;
		tokens.set(token, access);
		issuedTokens.push(token);
		return json({
			accessToken: token,
			expiresIn,
			accessTokenMaxTTL: expiresIn,
			tokenType: "Bearer",
		});
	}

	function secretJson(
		scope: Scope,
		key: string,
		stored: Stored,
		version: number,
		viewValue: boolean,
	): JsonValue {
		const hidden = stored.hidden || !viewValue;
		return {
			id: `${key}-id`,
			_id: `${key}-id`,
			workspace: scope.projectId,
			environment: scope.environment,
			version,
			type: "shared",
			secretKey: key,
			secretValue: hidden
				? "<hidden-by-infisical>"
				: (stored.versions[version - 1] ?? ""),
			secretValueHidden: hidden,
			secretComment: "",
			secretPath: scope.secretPath,
			createdAt: "2026-11-11T00:00:00.000Z",
			updatedAt: "2026-11-11T00:00:00.000Z",
			tags: [],
		};
	}

	function login(request: FakeRequest, path: string): FakeResponse {
		const body = request.body ?? null;
		if (path === "/api/v1/auth/oidc-auth/login") {
			const presented = record(() =>
				fromJson(InfisicalOidcLoginRequestSchema, body),
			);
			const identity = identities.find(
				(candidate) =>
					candidate.kind === "oidc" &&
					candidate.identityId === presented?.identityId,
			);
			if (identity?.kind !== "oidc" || identity.jwt !== presented?.jwt)
				return error(401, "Access denied: OIDC claims not allowed");
			return issue(identity.access, fake.expiresIn);
		}
		const presented = record(() =>
			fromJson(InfisicalUniversalAuthLoginRequestSchema, body),
		);
		const identity = identities.find(
			(candidate) =>
				candidate.kind === "universal-auth" &&
				candidate.clientId === presented?.clientId &&
				candidate.clientSecret === presented?.clientSecret,
		);
		if (identity?.kind !== "universal-auth")
			return error(401, "Invalid credentials");
		if (identity.usesLeft !== undefined) {
			if (identity.usesLeft <= 0) return error(401, "Invalid credentials");
			identity.usesLeft--;
		}
		return issue(identity.access, fake.expiresIn);
	}

	function secrets(
		request: FakeRequest,
		url: URL,
		access: Access,
	): FakeResponse {
		const name = url.pathname.startsWith("/api/v4/secrets/")
			? decodeURIComponent(url.pathname.slice("/api/v4/secrets/".length))
			: undefined;
		if (request.method === "GET") {
			if (access === "write-only")
				return error(403, "You are not allowed to read secrets");
			const scope: Scope = {
				projectId: url.searchParams.get("projectId") ?? "",
				environment: url.searchParams.get("environment") ?? "",
				secretPath: url.searchParams.get("secretPath") ?? "/",
			};
			const entries = folder(scope);
			if (name === undefined) {
				const view = url.searchParams.get("viewSecretValue") !== "false";
				return json({
					secrets: [...entries.entries()].map(([key, stored]) =>
						secretJson(scope, key, stored, stored.versions.length, view),
					),
					imports: [],
				});
			}
			const stored = entries.get(name);
			if (!stored) return error(404, `Secret with name '${name}' not found`);
			const version = Number(
				url.searchParams.get("version") ?? stored.versions.length,
			);
			if (!(version >= 1 && version <= stored.versions.length))
				return error(404, "Secret version not found");
			return json({ secret: secretJson(scope, name, stored, version, true) });
		}
		if (name === undefined) return error(404, "Route not found");
		if (access === "read")
			return error(403, "You are not allowed to edit secrets");
		const write = record(() =>
			fromJson(InfisicalSecretWriteRequestSchema, request.body ?? null),
		);
		if (!write) return error(400, "Invalid request body");
		const scope: Scope = {
			projectId: write.projectId,
			environment: write.environment,
			secretPath: write.secretPath || "/",
		};
		const entries = folder(scope);
		const stored = entries.get(name);
		if (request.method === "PATCH") {
			if (!stored) return error(404, `Secret with name '${name}' not found`);
			stored.versions.push(write.secretValue);
			return json({
				secret: secretJson(scope, name, stored, stored.versions.length, true),
			});
		}
		if (request.method === "POST") {
			if (stored) return error(400, "Secret already exist");
			const created = { versions: [write.secretValue], hidden: false };
			entries.set(name, created);
			return json({ secret: secretJson(scope, name, created, 1, true) });
		}
		return error(404, "Route not found");
	}

	const fake: FakeInfisical = {
		identities,
		requests,
		issuedTokens,
		revokedTokens,
		expiresIn: 7200,
		nextTokens: [],
		grant(token, access) {
			tokens.set(token, access);
		},
		tokenFor(access) {
			const token = `fake-at-${access}-${randomBytes(6).toString("hex")}`;
			tokens.set(token, access);
			issuedTokens.push(token);
			return token;
		},
		revokeTokens() {
			tokens.clear();
		},
		seed(scope, key, value, options = {}) {
			const entries = folder(scope);
			const stored = entries.get(key) ?? { versions: [], hidden: false };
			stored.versions.push(value);
			stored.hidden = options.hidden ?? false;
			entries.set(key, stored);
		},
		value(scope, key) {
			return folder(scope).get(key)?.versions.at(-1);
		},
		fail(match, response, times = 1) {
			faults.push({ fault: { match, response }, remaining: times });
		},
		handle(request) {
			const authorization = request.headers?.authorization ?? "";
			requests.push({
				method: request.method,
				path: request.path,
				authorized: authorization.startsWith("Bearer "),
				body: request.body,
			});
			const fault = faults.find(
				(candidate) =>
					candidate.remaining > 0 && candidate.fault.match(request),
			);
			if (fault) {
				fault.remaining--;
				return fault.fault.response;
			}
			const url = new URL(request.path, "http://fake.invalid");
			if (
				request.method === "POST" &&
				url.pathname.startsWith("/api/v1/auth/") &&
				url.pathname.endsWith("/login")
			)
				return login(request, url.pathname);
			if (
				request.method === "POST" &&
				url.pathname === "/api/v1/auth/token/revoke"
			) {
				const presented = record(() =>
					fromJson(InfisicalTokenRevokeRequestSchema, request.body ?? null),
				);
				if (!presented || !tokens.has(presented.accessToken))
					return error(401, "Token expired or invalid");
				tokens.delete(presented.accessToken);
				revokedTokens.push(presented.accessToken);
				return json({ message: "Successfully revoked access token" });
			}
			if (!url.pathname.startsWith("/api/v4/secrets"))
				return error(404, "Route not found");
			const token = /^Bearer (.+)$/u.exec(authorization)?.[1];
			const access = token === undefined ? undefined : tokens.get(token);
			if (access === undefined) return error(401, "Token expired or invalid");
			return secrets(request, url, access);
		},
		async listen() {
			const server: Server = createServer((incoming, outgoing) => {
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
				incoming.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf8");
					const headers: Record<string, string> = {};
					// rawHeaders alternates names and values, all strings.
					for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2)
						headers[(incoming.rawHeaders[i] ?? "").toLowerCase()] =
							incoming.rawHeaders[i + 1] ?? "";
					const body: JsonValue | undefined = raw ? JSON.parse(raw) : undefined;
					const response = fake.handle({
						method: incoming.method ?? "GET",
						path: incoming.url ?? "/",
						headers,
						body,
					});
					outgoing.writeHead(response.status, response.headers ?? {});
					outgoing.end(
						response.body === undefined ? "" : JSON.stringify(response.body),
					);
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			// SAFETY: a server listening on a TCP port reports an AddressInfo.
			const { port } = server.address() as AddressInfo;
			return {
				url: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise<void>((resolve, reject) => {
						server.close((closed) => (closed ? reject(closed) : resolve()));
						server.closeAllConnections();
					}),
			};
		},
	};
	return fake;
}

/** A syntactically valid JWT for the fake; it is never verified. */
export function fakeJwt(subject: string): string {
	const part = (value: JsonValue) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256", typ: "JWT" })}.${part({ sub: subject })}.${randomBytes(16).toString("base64url")}`;
}
