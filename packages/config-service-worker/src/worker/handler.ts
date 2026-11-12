/**
 * HoBo's config-service Worker: its request handler (`index.ts` is the
 * module Cloudflare runs and exports only the handler and the class).
 *
 * Routes (JSON, never cached):
 *
 * | Route | Who | Does |
 * |---|---|---|
 * | `GET /v1/health?nonce=` | anyone | `ConfigServiceHealth`: the store id and the nonce, nothing else |
 * | `GET /v1/folders/{relay,deploy}` | relay (Vercel OIDC) reads `relay`; deploy (GitHub OIDC) reads `deploy`; owner reads both | `ConfigFolderRead` |
 * | `PATCH /v1/folders/{relay,deploy}` | deploy writes `relay`; owner writes both | `ConfigFolderWrite` → `ConfigFolderWritten` |
 * | `POST /v1/seed` | the single-use bootstrap credential, once | `ConfigServiceSeed` → `ConfigServiceSeeded` |
 * | `GET /v1/audit` | owner | `ConfigAuditLog`, names only |
 *
 * Callers authenticate here, in the Worker; the Durable Object is reachable
 * only through this Worker's binding and trusts the principal it is told.
 * The relay and the deploy workflow send `Authorization: Bearer <OIDC
 * token>`; the owner reaches the Worker through a Cloudflare Access
 * application they put in front of it after the claim, whose assertion
 * (`Cf-Access-Jwt-Assertion`) is verified against the Access team's keys;
 * HoBo's provisioning sends `Authorization: HoBo-Bootstrap <credential>`.
 */
import { base64UrlDecode, readBounded } from "./bytes.js";
import { failure, json } from "./http.js";
import { field, isJsonString, jsonObject } from "./json.js";
import {
	createJwtVerifier,
	type JwtVerifier,
	type VerifiedClaims,
} from "./jwt.js";
import {
	type Folder,
	LIMITS,
	type OwnerAccess,
	parseFolder,
	parseOwnerAccess,
	parseWorkerBinding,
	type WorkerBinding,
} from "./records.js";
import {
	BOOTSTRAP_HEADER,
	INTERNAL_ORIGIN,
	PRINCIPAL_HEADER,
	type Principal,
} from "./store.js";

declare const storeIdBrand: unique symbol;
/** A `DurableObjectId`, opaque to the Worker. */
export type StoreObjectId = { readonly [storeIdBrand]: "DurableObjectId" };

/** The Durable Object namespace binding, as far as the Worker uses it. */
export type StoreNamespace = Readonly<{
	idFromName(name: string): StoreObjectId;
	get(id: StoreObjectId): Readonly<{
		fetch(request: Request): Promise<Response>;
	}>;
}>;

export type ConfigServiceEnv = Readonly<{
	CONFIG_STORE: StoreNamespace;
	HOBO_CONFIG_BINDING?: string;
	HOBO_CONFIG_OWNER_ACCESS?: string;
}>;

// public-contract: the service name the health route answers with.
export const CONFIG_SERVICE_NAME = "hobo-config-service";
// public-contract: the Authorization scheme of the single-use bootstrap credential.
export const BOOTSTRAP_SCHEME = "HoBo-Bootstrap";

const NONCE = /^[A-Za-z0-9_-]{16,64}$/u;

const CAN_READ: Readonly<Record<Principal, readonly Folder[]>> = Object.freeze({
	"vercel-relay": ["relay"],
	"github-deploy": ["deploy"],
	owner: ["relay", "deploy"],
});
const CAN_WRITE: Readonly<Record<Principal, readonly Folder[]>> = Object.freeze(
	{
		"vercel-relay": [],
		"github-deploy": ["relay"],
		owner: ["relay", "deploy"],
	},
);

function bearer(request: Request, scheme: string): string | undefined {
	const header = request.headers.get("authorization") ?? "";
	const prefix = `${scheme} `;
	if (!header.startsWith(prefix)) return undefined;
	const token = header.slice(prefix.length).trim();
	return token.length > 0 && token.length <= LIMITS.tokenBytes
		? token
		: undefined;
}

/** Which issuer a token names, to pick the keys that will verify it. */
function unverifiedIssuer(token: string): string | undefined {
	const bytes = base64UrlDecode(token.split(".")[1] ?? "");
	if (bytes === undefined) return undefined;
	const iss = field(jsonObject(new TextDecoder().decode(bytes)), "iss");
	return isJsonString(iss) ? iss : undefined;
}

/** The relay: every claim Vercel binds to the project and environment. */
function isRelay(claims: VerifiedClaims, binding: WorkerBinding): boolean {
	return (
		field(claims, "sub") === binding.relay.subject &&
		field(claims, "owner_id") === binding.relay.ownerId &&
		field(claims, "project_id") === binding.relay.projectId &&
		field(claims, "environment") === binding.relay.environment
	);
}

/** The deploy workflow: one repository (by id too, when pinned) and one ref. */
function isDeploy(claims: VerifiedClaims, binding: WorkerBinding): boolean {
	return (
		field(claims, "repository") === binding.deploy.repository &&
		field(claims, "ref") === binding.deploy.ref &&
		(binding.deploy.repositoryId === "" ||
			field(claims, "repository_id") === binding.deploy.repositoryId)
	);
}

async function authenticate(
	request: Request,
	binding: WorkerBinding,
	owner: OwnerAccess | undefined,
	verifier: JwtVerifier,
): Promise<Principal | undefined> {
	const assertion = request.headers.get("cf-access-jwt-assertion");
	if (owner !== undefined && assertion !== null) {
		const claims = await verifier.verify(assertion, {
			issuer: owner.issuer,
			audience: owner.audience,
			keys: "access-certs",
		});
		return claims === undefined ? undefined : "owner";
	}
	const token = bearer(request, "Bearer");
	if (token === undefined) return undefined;
	const issuer = unverifiedIssuer(token);
	if (issuer === binding.relay.issuer) {
		const claims = await verifier.verify(token, {
			issuer: binding.relay.issuer,
			audience: binding.relay.audience,
			keys: "openid-discovery",
		});
		return claims !== undefined && isRelay(claims, binding)
			? "vercel-relay"
			: undefined;
	}
	if (issuer === binding.deploy.issuer) {
		const claims = await verifier.verify(token, {
			issuer: binding.deploy.issuer,
			audience: binding.deploy.audience,
			keys: "openid-discovery",
		});
		return claims !== undefined && isDeploy(claims, binding)
			? "github-deploy"
			: undefined;
	}
	return undefined;
}

export type ConfigServiceHandler = Readonly<{
	fetch(request: Request, env: ConfigServiceEnv): Promise<Response>;
}>;

/** The Worker's handler; `send` reaches the issuers' key endpoints. */
export function createConfigServiceHandler(
	send: typeof fetch,
	now: () => number = Date.now,
): ConfigServiceHandler {
	const verifier = createJwtVerifier(send, now);

	return Object.freeze({
		async fetch(request, env) {
			const url = new URL(request.url);
			const binding = parseWorkerBinding(env.HOBO_CONFIG_BINDING);
			if (binding === undefined) return failure("STORE_UNCONFIGURED");
			const store = env.CONFIG_STORE.get(env.CONFIG_STORE.idFromName("store"));
			const internal = (
				path: string,
				method: string,
				headers: Record<string, string>,
				body?: string,
			) =>
				store.fetch(
					new Request(`${INTERNAL_ORIGIN}${path}`, {
						method,
						headers,
						...(body !== undefined ? { body } : undefined),
					}),
				);
			const [, version, area, name, extra] = url.pathname.split("/");
			if (version !== "v1" || extra !== undefined) return failure("NOT_FOUND");

			if (area === "health" && name === undefined) {
				if (request.method !== "GET") return failure("METHOD_NOT_ALLOWED");
				const nonce = url.searchParams.get("nonce") ?? "";
				if (!NONCE.test(nonce)) return failure("BODY_REJECTED");
				return json(200, {
					service: CONFIG_SERVICE_NAME,
					storeId: binding.storeId,
					nonce,
				});
			}

			if (area === "seed" && name === undefined) {
				if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED");
				const credential = bearer(request, BOOTSTRAP_SCHEME);
				if (credential === undefined) return failure("BOOTSTRAP_REFUSED");
				const body = await readBounded(request, LIMITS.bodyBytes);
				if (body === undefined) return failure("BODY_REJECTED");
				return internal(
					"/seed",
					"POST",
					{ [BOOTSTRAP_HEADER]: credential },
					body,
				);
			}

			const owner = parseOwnerAccess(env.HOBO_CONFIG_OWNER_ACCESS);
			if (area === "audit" && name === undefined) {
				if (request.method !== "GET") return failure("METHOD_NOT_ALLOWED");
				const principal = await authenticate(request, binding, owner, verifier);
				if (principal === undefined) return failure("UNAUTHENTICATED");
				return principal === "owner"
					? internal("/audit", "GET", {})
					: failure("FORBIDDEN");
			}

			const folder = parseFolder(name ?? "");
			if (area !== "folders" || folder === undefined)
				return failure("NOT_FOUND");
			if (request.method !== "GET" && request.method !== "PATCH")
				return failure("METHOD_NOT_ALLOWED");
			const principal = await authenticate(request, binding, owner, verifier);
			if (principal === undefined) return failure("UNAUTHENTICATED");
			const allowed = (request.method === "GET" ? CAN_READ : CAN_WRITE)[
				principal
			];
			const as = { [PRINCIPAL_HEADER]: principal };
			if (!allowed.includes(folder))
				return internal(`/denied/${folder}`, "POST", as);
			if (request.method === "GET")
				return internal(`/folder/${folder}`, "GET", as);
			const body = await readBounded(request, LIMITS.bodyBytes);
			if (body === undefined) return failure("BODY_REJECTED");
			return internal(`/folder/${folder}`, "PATCH", as, body);
		},
	});
}
