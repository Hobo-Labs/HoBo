/**
 * One authenticated conversation with one registry host.
 *
 * Every request goes through `@hobo/core` `guardTransport`, pinned to the one
 * host the session was opened for and the `/v2/` distribution surface. The
 * credential is resolved by the host from a locator and lives only in this
 * closure and in the `authorization` header of a guarded request; it is never
 * written to an outcome, a diagnostic or an error message (I9).
 *
 * Authentication follows the distribution token flow. A request is sent with
 * whatever authorization the session already holds for its scope; a 401 carries
 * a `WWW-Authenticate` challenge, and:
 *
 * - `Bearer realm=…,service=…,scope=…` exchanges the credential at the realm
 *   for a scoped registry token and retries once. The realm is chosen by the
 *   peer, so it must match one of the endpoint's allowlisted realm URLs
 *   exactly. Otherwise a compromised or misconfigured registry could have the
 *   basic credential mailed to any host it names.
 * - `Basic` (ECR, some Harbor and Zot deployments) retries once with the basic
 *   credential.
 *
 * A second 401 is a refusal, never a loop.
 *
 * Redirects: the guard refuses to follow a 3xx, and that stays true. Blob GETs
 * are the one place the distribution spec documents a redirect (to a CDN or an
 * object store), so the session rewrites a 3xx `Location` into a private header
 * that the guard does not inspect, and the blob reader decides whether to
 * follow it. It follows only to an allowlisted host, once, with no
 * `authorization` header. Every other caller treats a 3xx as an unexpected
 * status.
 */
import {
	guardTransport,
	type HttpTransport,
	ResolverError,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import { isJsonString, parseJsonObject } from "./json.js";
import { OCI_REGISTRY_IMAGE_PRODUCT_ID, rejected } from "./reference.js";

/** What the host's credential resolver hands back for a locator. */
export type OciRegistryCredential =
	| { readonly kind: "anonymous" }
	| {
			readonly kind: "basic";
			readonly username: string;
			readonly password: string;
	  }
	| { readonly kind: "bearer"; readonly token: string };

/** A registry the host binds, by exact host. */
export interface OciRegistryEndpoint {
	readonly host: string;
	/**
	 * Exact token realm URLs (`https://auth.docker.io/token`) a
	 * `WWW-Authenticate: Bearer` challenge from this host may name. Absent or
	 * empty means no realm is reachable, so a bearer challenge is refused.
	 */
	readonly authRealms?: readonly string[];
	/** Hosts a blob GET may be redirected to (CDN or object storage). */
	readonly blobRedirectHosts?: readonly string[];
	/** Locator for a source registry's pull credential; absent means anonymous. */
	readonly credentialRef?: string | undefined;
}

/**
 * How the host transport carries bodies. `utf-8` is the stock
 * `createBoundedFetchTransport`: only blobs that are valid UTF-8 (JSON config,
 * manifests, most attestations) round-trip. `latin1` is a host transport that
 * maps each byte to one code unit 0–255, which is what binary layers need.
 */
export type TransportBodyEncoding = "utf-8" | "latin1";

export interface SessionLimits {
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
}

export interface SessionRequest {
	readonly method: TransportMethod;
	/** Path plus query, starting with `/v2/`. */
	readonly path: string;
	readonly scopes: readonly string[];
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly maxResponseBytes?: number;
}

/** Private header carrying a captured 3xx `Location`; never sent to a peer. */
// public-contract: shared by session.ts and resolver.ts; never on the wire.
export const REDIRECT_HEADER = "x-hobo-oci-redirect-location";

const PRINTABLE_SECRET = /^[!-~]{1,8192}$/u;
const PRINTABLE_USERNAME = /^[!-9;-~]{1,512}$/u;

export function header(
	response: TransportResponse,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers))
		if (key.toLowerCase() === lower) return value;
	return undefined;
}

/** Refuse credential material that cannot be a registry credential. */
export function checkCredential(
	credential: OciRegistryCredential,
): OciRegistryCredential {
	const missing = (): never => {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"OCI registry credential is missing or malformed; the host credential resolver must return { kind: 'basic' | 'bearer' | 'anonymous' } with printable material",
			OCI_REGISTRY_IMAGE_PRODUCT_ID,
		);
	};
	if (!credential) return missing();
	switch (credential.kind) {
		case "anonymous":
			return { kind: "anonymous" };
		case "basic":
			if (
				!isJsonString(credential.username) ||
				!PRINTABLE_USERNAME.test(credential.username) ||
				!isJsonString(credential.password) ||
				!PRINTABLE_SECRET.test(credential.password)
			)
				return missing();
			return {
				kind: "basic",
				username: credential.username,
				password: credential.password,
			};
		case "bearer":
			if (
				!isJsonString(credential.token) ||
				!PRINTABLE_SECRET.test(credential.token)
			)
				return missing();
			return { kind: "bearer", token: credential.token };
		default:
			return missing();
	}
}

interface Challenge {
	readonly scheme: string;
	readonly params: Readonly<Record<string, string>>;
}

/** Parse one `WWW-Authenticate` challenge; unknown shapes parse to no scheme. */
export function parseChallenge(value: string | undefined): Challenge {
	if (value === undefined) return { scheme: "", params: {} };
	const trimmed = value.trim();
	const space = trimmed.indexOf(" ");
	const scheme = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	const params: Record<string, string> = {};
	const rest = space < 0 ? "" : trimmed.slice(space + 1);
	for (const match of rest.matchAll(/([A-Za-z_]+)="([^"]{0,2048})"/gu)) {
		const [, key, raw] = match;
		if (key !== undefined && raw !== undefined) params[key.toLowerCase()] = raw;
	}
	return { scheme, params };
}

/** Make a guarded transport keep a 3xx Location visible without following it. */
function captureRedirects(inner: HttpTransport): HttpTransport {
	return async (request) => {
		const response = await inner(request);
		if (response.status < 300 || response.status >= 400) return response;
		const location = header(response, "location");
		if (location === undefined) return response;
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(response.headers))
			if (key.toLowerCase() !== "location") headers[key] = value;
		headers[REDIRECT_HEADER] = location;
		return { status: response.status, headers, body: response.body };
	};
}

export interface RegistrySession {
	readonly host: string;
	send(request: SessionRequest): Promise<TransportResponse>;
	/** Follow a captured blob redirect once, unauthenticated, to an allowlisted host. */
	followBlobRedirect(
		location: string,
		maxResponseBytes: number,
	): Promise<TransportResponse>;
}

export function openSession(options: {
	readonly endpoint: OciRegistryEndpoint;
	readonly credential: OciRegistryCredential;
	readonly transport: HttpTransport;
	readonly limits: SessionLimits;
}): RegistrySession {
	const { endpoint, limits } = options;
	const credential = checkCredential(options.credential);
	const host = endpoint.host;
	const registry = guardTransport(captureRedirects(options.transport), {
		allowedHosts: [host],
		allowedPathPrefixes: ["/v2/"],
		maxTimeoutMs: limits.timeoutMs,
		maxResponseBytes: limits.maxResponseBytes,
	});
	const realms = new Map<string, HttpTransport>();
	for (const realm of endpoint.authRealms ?? []) {
		const url = new URL(realm);
		realms.set(
			`${url.origin}${url.pathname}`,
			guardTransport(options.transport, {
				allowedHosts: [url.hostname],
				allowedPathPrefixes: [url.pathname],
				maxTimeoutMs: limits.timeoutMs,
				maxResponseBytes: 64 * 1024,
			}),
		);
	}
	const authorizations = new Map<string, string>();

	function basicHeader(): string | undefined {
		if (credential.kind !== "basic") return undefined;
		return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;
	}

	async function exchange(
		challenge: Challenge,
		scopes: readonly string[],
	): Promise<string> {
		if (credential.kind === "bearer")
			rejected(
				`registry ${host} refused the pre-minted bearer token`,
				"rotate the token behind the credential locator, or resolve a basic credential so the token flow can mint a scoped token",
			);
		const realmText = challenge.params.realm;
		let realm: URL;
		try {
			realm = new URL(realmText ?? "");
		} catch {
			return rejected(
				`registry ${host} sent a bearer challenge with no usable realm`,
			);
		}
		const key = `${realm.origin}${realm.pathname}`;
		const transport = realms.get(key);
		if (
			transport === undefined ||
			realm.protocol !== "https:" ||
			realm.username !== "" ||
			realm.password !== ""
		)
			rejected(
				`registry ${host} named token realm ${JSON.stringify(key.slice(0, 200))}, which is not allowlisted for it`,
				"add the exact realm URL to the endpoint's authRealms after confirming it belongs to the registry operator",
			);
		const query = new URLSearchParams();
		if (challenge.params.service)
			query.append("service", challenge.params.service);
		const wanted = new Set<string>(scopes);
		if (challenge.params.scope)
			for (const scope of challenge.params.scope.split(" "))
				if (scope) wanted.add(scope);
		for (const scope of [...wanted].sort()) query.append("scope", scope);
		const basic = basicHeader();
		let response: TransportResponse;
		try {
			response = await transport({
				method: "GET",
				url: `${key}?${query.toString()}`,
				headers: basic ? { authorization: basic } : {},
				timeoutMs: limits.timeoutMs,
				maxResponseBytes: 64 * 1024,
			});
		} catch {
			return rejected(
				`token exchange with registry ${host} failed in transport`,
			);
		}
		if (response.status !== 200)
			rejected(
				`token realm for registry ${host} answered HTTP ${response.status}`,
				"check that the credential behind the locator may pull/push this repository",
			);
		const body = parseJsonObject(response.body);
		const token = isJsonString(body.token)
			? body.token
			: isJsonString(body.access_token)
				? body.access_token
				: undefined;
		if (token === undefined || !PRINTABLE_SECRET.test(token))
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`token realm for registry ${host} returned no usable token`,
				OCI_REGISTRY_IMAGE_PRODUCT_ID,
			);
		return `Bearer ${token}`;
	}

	async function attempt(
		request: SessionRequest,
		authorization: string | undefined,
	): Promise<TransportResponse> {
		const outbound = {
			method: request.method,
			url: `https://${host}${request.path}`,
			headers: authorization
				? { ...request.headers, authorization }
				: { ...request.headers },
			timeoutMs: limits.timeoutMs,
			maxResponseBytes: request.maxResponseBytes ?? limits.maxResponseBytes,
		};
		return request.body === undefined
			? registry(outbound)
			: registry({ ...outbound, body: request.body });
	}

	return {
		host,
		async send(request) {
			const key = [...request.scopes].sort().join(" ");
			const initial =
				authorizations.get(key) ??
				(credential.kind === "bearer"
					? `Bearer ${credential.token}`
					: undefined);
			const first = await attempt(request, initial);
			if (first.status !== 401) return first;
			const challenge = parseChallenge(header(first, "www-authenticate"));
			let authorization: string;
			if (challenge.scheme === "bearer")
				authorization = await exchange(challenge, request.scopes);
			else if (challenge.scheme === "basic") {
				const basic = basicHeader();
				if (basic === undefined)
					rejected(
						`registry ${host} demands basic authentication and no basic credential was resolved`,
						"bind a credential locator that resolves to a basic credential for this registry",
					);
				authorization = basic;
			} else
				rejected(`registry ${host} answered 401 without a supported challenge`);
			authorizations.set(key, authorization);
			const second = await attempt(request, authorization);
			if (second.status === 401)
				rejected(
					`registry ${host} refused the credential for ${key || "this request"}`,
					"grant the credential behind the locator pull/push on the repository",
				);
			return second;
		},
		async followBlobRedirect(location, maxResponseBytes) {
			let url: URL;
			try {
				url = new URL(location, `https://${host}`);
			} catch {
				return rejected(
					`registry ${host} redirected a blob read to an unparseable location`,
				);
			}
			if (
				url.protocol !== "https:" ||
				!(endpoint.blobRedirectHosts ?? []).includes(url.hostname)
			)
				rejected(
					`registry ${host} redirected a blob read to ${url.hostname}, which is not an allowlisted blob host`,
					"add the storage host to the endpoint's blobRedirectHosts after confirming the registry operator serves blobs from it",
				);
			const storage = guardTransport(options.transport, {
				allowedHosts: [url.hostname],
				allowedPathPrefixes: ["/"],
				maxTimeoutMs: limits.timeoutMs,
				maxResponseBytes: limits.maxResponseBytes,
			});
			// No authorization header: a presigned URL carries its own grant, and the
			// registry credential must never reach the storage host.
			return storage({
				method: "GET",
				url: url.toString(),
				headers: {},
				timeoutMs: limits.timeoutMs,
				maxResponseBytes,
			});
		},
	};
}

/** Bytes as the transport delivered them, under the declared body encoding. */
export function decodeBody(
	body: string,
	encoding: TransportBodyEncoding,
): Uint8Array {
	if (encoding === "utf-8") return Buffer.from(body, "utf8");
	for (let index = 0; index < body.length; index++)
		if (body.charCodeAt(index) > 0xff)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"latin1 transport delivered a code unit above 0xFF; the host transport is not a byte transport",
				OCI_REGISTRY_IMAGE_PRODUCT_ID,
			);
	return Buffer.from(body, "latin1");
}

/** A body string the transport will send as exactly these bytes, or undefined. */
export function encodeBody(
	bytes: Uint8Array,
	encoding: TransportBodyEncoding,
): string | undefined {
	if (encoding === "latin1") return Buffer.from(bytes).toString("latin1");
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		return undefined;
	}
}
