/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) against a configurable OIDC
 * issuer for `hobo login`.
 *
 * The grant runs ONLY when an issuer is explicitly configured
 * (`HOBO_OIDC_ISSUER`); the offline fixture session stays the default lane.
 * All network I/O goes through the injected `fetchImpl` — this module never
 * reaches for global fetch, so tests drive the whole grant offline.
 *
 * Fail-closed: once an issuer is configured, every failure (discovery,
 * malformed metadata, device-auth rejection, `access_denied`, `expired_token`,
 * JWKS/token verification) surfaces as a typed {@link DeviceGrantError} with
 * remediation text — never a silent fixture fallback.
 */

import { verifyJwtWithJwks } from "@hobo/identity";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: env var holding the OIDC issuer URL that opts `hobo login` into the real device-code grant.
export const HOBO_OIDC_ISSUER_ENV = "HOBO_OIDC_ISSUER";
// public-contract: env var overriding the OAuth client id presented by the CLI during the device grant.
export const HOBO_OIDC_CLIENT_ID_ENV = "HOBO_OIDC_CLIENT_ID";
// public-contract: env var overriding the audience the minted token must carry (defaults to the client id).
export const HOBO_OIDC_AUDIENCE_ENV = "HOBO_OIDC_AUDIENCE";
// public-contract: default OAuth client id the composed CLI presents to the issuer.
export const DEFAULT_OIDC_CLIENT_ID = "hobo-cli";
// public-contract: RFC 8628 §3.4 device-code grant type identifier sent to the token endpoint.
export const DEVICE_CODE_GRANT_TYPE =
	"urn:ietf:params:oauth:grant-type:device_code";

// RFC 8628 §3.2 — default polling interval (seconds) when the issuer omits one.
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 §3.5 — `slow_down` means add 5 seconds to the current interval.
const SLOW_DOWN_INCREMENT_SECONDS = 5;

export type DeviceGrantErrorCode =
	| "HOBO_OIDC_DISCOVERY_FAILED"
	| "HOBO_OIDC_METADATA_INVALID"
	| "HOBO_OIDC_DEVICE_AUTH_FAILED"
	| "HOBO_OIDC_ACCESS_DENIED"
	| "HOBO_OIDC_EXPIRED"
	| "HOBO_OIDC_TOKEN_FAILED"
	| "HOBO_OIDC_TOKEN_INVALID";

/** Typed, remediable failure of the device-code grant. Never swallowed into a fixture fallback. */
export class DeviceGrantError extends Error {
	readonly code: DeviceGrantErrorCode;
	readonly remediation: readonly string[];

	constructor(
		code: DeviceGrantErrorCode,
		message: string,
		remediation: readonly string[],
	) {
		super(message);
		this.name = "DeviceGrantError";
		this.code = code;
		this.remediation = remediation;
	}
}

export interface OidcIssuerConfig {
	readonly issuer: string;
	readonly clientId: string;
	readonly audience: string;
}

/**
 * Read the device-grant configuration from the environment. `null` means no
 * issuer is configured and `hobo login` stays on the offline fixture lane.
 */
export function resolveOidcIssuerConfig(
	env: NodeJS.ProcessEnv,
): OidcIssuerConfig | null {
	const raw = env[HOBO_OIDC_ISSUER_ENV];
	if (!isJsonString(raw) || raw.trim().length === 0) return null;
	const issuer = raw.trim().replace(/\/+$/, "");
	const clientId =
		isJsonString(env[HOBO_OIDC_CLIENT_ID_ENV]) &&
		env[HOBO_OIDC_CLIENT_ID_ENV].trim().length > 0
			? env[HOBO_OIDC_CLIENT_ID_ENV].trim()
			: DEFAULT_OIDC_CLIENT_ID;
	const audience =
		isJsonString(env[HOBO_OIDC_AUDIENCE_ENV]) &&
		env[HOBO_OIDC_AUDIENCE_ENV].trim().length > 0
			? env[HOBO_OIDC_AUDIENCE_ENV].trim()
			: clientId;
	return { issuer, clientId, audience };
}

export interface DeviceGrantResult {
	/** The verified JWT minted by the issuer. */
	readonly token: string;
	/** Verified claims (issuer, audience, exp/nbf already checked). */
	readonly claims: JsonObject;
	readonly verificationUri: string;
	readonly userCode: string;
}

export interface DeviceGrantOptions {
	readonly config: OidcIssuerConfig;
	/** Injected fetch — the grant performs no network I/O outside this. */
	readonly fetchImpl: typeof fetch;
	/** Injected sleep seam so tests never run real timers. */
	readonly sleep: (ms: number) => Promise<void>;
	/** Injected clock (epoch ms). */
	readonly now: () => number;
	readonly emitProgress?: (message: string) => void;
}

interface DiscoveryMetadata {
	readonly issuer: string;
	readonly deviceAuthorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly jwksUri: string;
}

/**
 * Run the full RFC 8628 grant: OIDC discovery → device authorization →
 * token polling (honoring `interval`, `slow_down`, `authorization_pending`,
 * `expired_token`, `access_denied` per §3.5) → JWKS verification of the
 * minted token.
 */
export async function runDeviceCodeGrant(
	options: DeviceGrantOptions,
): Promise<DeviceGrantResult> {
	const { config, fetchImpl, sleep, now } = options;
	const metadata = await discover(config, fetchImpl);

	const authorization = await requestDeviceAuthorization(
		config,
		metadata,
		fetchImpl,
	);
	options.emitProgress?.(
		`To sign in, visit ${authorization.verificationUri} and enter code ${authorization.userCode}`,
	);

	const token = await pollForToken({
		config,
		metadata,
		authorization,
		fetchImpl,
		sleep,
		now,
	});

	const claims = await verifyToken(config, metadata, token, fetchImpl, now);
	return {
		token,
		claims,
		verificationUri: authorization.verificationUri,
		userCode: authorization.userCode,
	};
}

async function discover(
	config: OidcIssuerConfig,
	fetchImpl: typeof fetch,
): Promise<DiscoveryMetadata> {
	const url = `${config.issuer}/.well-known/openid-configuration`;
	let body: JsonValue;
	try {
		const response = await fetchImpl(url);
		if (!response.ok) {
			throw new DeviceGrantError(
				"HOBO_OIDC_DISCOVERY_FAILED",
				`OIDC discovery at ${url} failed with HTTP ${response.status}.`,
				[
					`Confirm ${HOBO_OIDC_ISSUER_ENV} points at a reachable OIDC issuer (its /.well-known/openid-configuration must return 200).`,
				],
			);
		}
		body = await response.json();
	} catch (error) {
		if (error instanceof DeviceGrantError) throw error;
		throw new DeviceGrantError(
			"HOBO_OIDC_DISCOVERY_FAILED",
			`OIDC discovery at ${url} failed: ${String(error)}`,
			[
				`Confirm ${HOBO_OIDC_ISSUER_ENV} is a reachable issuer URL, or unset it to use the offline fixture session.`,
			],
		);
	}
	if (!isJsonObject(body) || body === null) {
		throw metadataInvalid("discovery document is not a JSON object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const doc = body as JsonObject;
	if (doc.issuer !== config.issuer) {
		throw metadataInvalid(
			`discovery issuer ${JSON.stringify(doc.issuer)} does not match configured issuer ${config.issuer}`,
		);
	}
	const deviceAuthorizationEndpoint = doc.device_authorization_endpoint;
	const tokenEndpoint = doc.token_endpoint;
	const jwksUri = doc.jwks_uri;
	if (!isJsonString(deviceAuthorizationEndpoint)) {
		throw metadataInvalid(
			"discovery document has no device_authorization_endpoint (issuer does not support RFC 8628)",
		);
	}
	if (!isJsonString(tokenEndpoint)) {
		throw metadataInvalid("discovery document has no token_endpoint");
	}
	if (!isJsonString(jwksUri)) {
		throw metadataInvalid("discovery document has no jwks_uri");
	}
	return {
		issuer: config.issuer,
		deviceAuthorizationEndpoint,
		tokenEndpoint,
		jwksUri,
	};
}

function metadataInvalid(detail: string): DeviceGrantError {
	return new DeviceGrantError(
		"HOBO_OIDC_METADATA_INVALID",
		`OIDC issuer metadata is invalid: ${detail}.`,
		[
			`Point ${HOBO_OIDC_ISSUER_ENV} at an OIDC issuer that advertises device_authorization_endpoint, token_endpoint, and jwks_uri.`,
		],
	);
}

interface DeviceAuthorization {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUri: string;
	readonly expiresInSeconds: number;
	readonly intervalSeconds: number;
}

async function requestDeviceAuthorization(
	config: OidcIssuerConfig,
	metadata: DiscoveryMetadata,
	fetchImpl: typeof fetch,
): Promise<DeviceAuthorization> {
	let body: JsonValue;
	try {
		const response = await postForm(
			fetchImpl,
			metadata.deviceAuthorizationEndpoint,
			{ client_id: config.clientId, scope: "openid" },
		);
		if (!response.ok) {
			throw new DeviceGrantError(
				"HOBO_OIDC_DEVICE_AUTH_FAILED",
				`Device authorization request failed with HTTP ${response.status}.`,
				[
					`Confirm client id "${config.clientId}" is registered with the issuer for the device-code grant (override with ${HOBO_OIDC_CLIENT_ID_ENV}).`,
				],
			);
		}
		body = await response.json();
	} catch (error) {
		if (error instanceof DeviceGrantError) throw error;
		throw new DeviceGrantError(
			"HOBO_OIDC_DEVICE_AUTH_FAILED",
			`Device authorization request failed: ${String(error)}`,
			[
				"Check network reachability of the issuer's device_authorization_endpoint.",
			],
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const doc = (isJsonObject(body) && body !== null ? body : {}) as JsonObject;
	const deviceCode = doc.device_code;
	const userCode = doc.user_code;
	const verificationUri = doc.verification_uri;
	if (
		!isJsonString(deviceCode) ||
		!isJsonString(userCode) ||
		!isJsonString(verificationUri)
	) {
		throw new DeviceGrantError(
			"HOBO_OIDC_DEVICE_AUTH_FAILED",
			"Device authorization response is missing device_code/user_code/verification_uri.",
			[
				"The issuer's device_authorization_endpoint must implement RFC 8628 §3.2.",
			],
		);
	}
	const expiresIn = doc.expires_in;
	const interval = doc.interval;
	return {
		deviceCode,
		userCode,
		verificationUri,
		expiresInSeconds: isJsonNumber(expiresIn) ? expiresIn : 300,
		intervalSeconds: isJsonNumber(interval)
			? interval
			: DEFAULT_POLL_INTERVAL_SECONDS,
	};
}

async function pollForToken(input: {
	config: OidcIssuerConfig;
	metadata: DiscoveryMetadata;
	authorization: DeviceAuthorization;
	fetchImpl: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}): Promise<string> {
	const { config, metadata, authorization, fetchImpl, sleep, now } = input;
	let intervalSeconds = authorization.intervalSeconds;
	const deadline = now() + authorization.expiresInSeconds * 1000;

	for (;;) {
		await sleep(intervalSeconds * 1000);
		if (now() >= deadline) throw expiredError();

		let response: Awaited<ReturnType<typeof fetch>>;
		let body: JsonValue;
		try {
			response = await postForm(fetchImpl, metadata.tokenEndpoint, {
				grant_type: DEVICE_CODE_GRANT_TYPE,
				device_code: authorization.deviceCode,
				client_id: config.clientId,
			});
			body = await response.json();
		} catch (error) {
			throw new DeviceGrantError(
				"HOBO_OIDC_TOKEN_FAILED",
				`Token endpoint request failed: ${String(error)}`,
				["Check network reachability of the issuer's token_endpoint."],
			);
		}
		// SAFETY: assertion required at this I/O or test boundary.
		const doc = (isJsonObject(body) && body !== null ? body : {}) as JsonObject;

		if (response.ok) {
			const accessToken = doc.access_token;
			if (!isJsonString(accessToken) || accessToken.length === 0) {
				throw new DeviceGrantError(
					"HOBO_OIDC_TOKEN_FAILED",
					"Token endpoint returned success without an access_token.",
					[
						"The issuer's token_endpoint must return an RFC 6749 §5.1 response.",
					],
				);
			}
			return accessToken;
		}

		// RFC 8628 §3.5 error handling.
		switch (doc.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
				continue;
			case "access_denied":
				throw new DeviceGrantError(
					"HOBO_OIDC_ACCESS_DENIED",
					"The authorization request was denied by the user or issuer.",
					[
						"Re-run `hobo login` and approve the device code, or contact your issuer administrator.",
					],
				);
			case "expired_token":
				throw expiredError();
			default:
				throw new DeviceGrantError(
					"HOBO_OIDC_TOKEN_FAILED",
					`Token endpoint rejected the device-code grant: ${JSON.stringify(doc.error ?? `HTTP ${response.status}`)}.`,
					[
						"The issuer must support the RFC 8628 device-code grant for this client.",
					],
				);
		}
	}
}

function expiredError(): DeviceGrantError {
	return new DeviceGrantError(
		"HOBO_OIDC_EXPIRED",
		"The device code expired before the sign-in was approved.",
		["Re-run `hobo login` and complete the browser approval promptly."],
	);
}

async function verifyToken(
	config: OidcIssuerConfig,
	metadata: DiscoveryMetadata,
	token: string,
	fetchImpl: typeof fetch,
	now: () => number,
): Promise<JsonObject> {
	let jwks: unknown;
	try {
		const response = await fetchImpl(metadata.jwksUri);
		if (!response.ok) {
			throw new Error(`JWKS fetch returned HTTP ${response.status}`);
		}
		jwks = await response.json();
	} catch (error) {
		throw new DeviceGrantError(
			"HOBO_OIDC_TOKEN_INVALID",
			`Could not fetch the issuer JWKS from ${metadata.jwksUri}: ${String(error)}`,
			[
				"The issuer's jwks_uri must serve its signing keys; retry `hobo login`.",
			],
		);
	}
	const keys =
		isJsonObject(jwks) && Array.isArray(jwks.keys)
			? jwks.keys.filter((entry) => isJsonObject(entry))
			: null;
	if (keys === null) {
		throw new DeviceGrantError(
			"HOBO_OIDC_TOKEN_INVALID",
			"Issuer JWKS document has no keys array.",
			["The issuer's jwks_uri must serve an RFC 7517 JWK Set."],
		);
	}
	try {
		const verified = await verifyJwtWithJwks(
			token,
			{ keys },
			{
				issuer: config.issuer,
				audience: config.audience,
				now: Math.floor(now() / 1000),
			},
		);
		const claims = cloneAsJson(verified.claims);
		return isJsonObject(claims) ? claims : {};
	} catch (error) {
		throw new DeviceGrantError(
			"HOBO_OIDC_TOKEN_INVALID",
			`The minted token failed JWKS verification: ${String(error)}`,
			[
				`Confirm the issuer signs with a key published at its jwks_uri and that the token audience matches "${config.audience}" (override with ${HOBO_OIDC_AUDIENCE_ENV}).`,
			],
		);
	}
}

async function postForm(
	fetchImpl: typeof fetch,
	url: string,
	fields: Record<string, string>,
): Promise<Awaited<ReturnType<typeof fetch>>> {
	return fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});
}
