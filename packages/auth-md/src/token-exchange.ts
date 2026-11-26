/** OAuth client-credentials exchange with RFC 7523 private_key_jwt proof of possession. */

import type { JsonWebKey, KeyObject } from "node:crypto";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import type { ClaimedAgentPrincipal } from "./claim.js";
import type { AuthMdDiscovery } from "./discovery.js";
import { authMdError } from "./errors.js";
import { type HttpPort, requestJson } from "./http.js";
import {
	authMdJsonObject as object,
	authMdJsonString as string,
} from "./json.js";
import {
	createSensitive,
	discloseSensitive,
	type SensitiveRef,
} from "./redaction.js";
import { type AgentRegistration, materialHandle } from "./registration.js";
import {
	type HttpsUrl,
	type Instant,
	parseHttpsUrl,
	parseInstant,
	parseScopes,
	type RegistrationRef,
	type Scope,
	type SessionBinding,
	scopesSubsetOf,
	sessionBindingsMatch,
} from "./types.js";

// domain-view: refs-only wire form is AgentAccessTokenRecord in data-models/auth_md.proto.
export interface AgentAccessToken {
	readonly registrationRef: RegistrationRef;
	readonly accessToken: SensitiveRef<"access-token">;
	readonly tokenType: "Bearer";
	readonly scopes: readonly Scope[];
	readonly binding: SessionBinding;
	readonly issuedAt: Instant;
	readonly expiresAt: Instant;
	readonly issuer: HttpsUrl;
}

/** Discover the token endpoint from an advertised issuer, never from advisory auth.md prose. */
export async function discoverAgentTokenEndpoint(
	port: HttpPort,
	discovery: AuthMdDiscovery,
) {
	const issuer = discovery.metadata.authorizationServers[0];
	if (!issuer)
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"resource advertises no authorization server",
		);
	const issuerUrl = new URL(issuer);
	const path = issuerUrl.pathname.replace(/\/$/u, "");
	const metadataUrl = new URL(
		`/.well-known/oauth-authorization-server${path}`,
		issuerUrl.origin,
	);
	const metadata = object(
		await requestJson(port, metadataUrl.toString()),
		"authorization server metadata",
	);
	if (parseHttpsUrl(metadata.issuer, "issuer") !== issuer)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"authorization server metadata issuer does not match discovery",
		);
	const tokenEndpoint = parseHttpsUrl(
		metadata.token_endpoint,
		"token_endpoint",
	);
	if (new URL(tokenEndpoint).origin !== issuerUrl.origin)
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"authorization server token endpoint must remain on its issuer origin",
		);
	if (
		!Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
		!metadata.token_endpoint_auth_methods_supported.includes("private_key_jwt")
	)
		throw authMdError(
			"AUTHMD_REGISTRATION_UNSUPPORTED",
			"authorization server does not advertise private_key_jwt authentication",
		);
	const algorithms = metadata.token_endpoint_auth_signing_alg_values_supported;
	if (!Array.isArray(algorithms) || !algorithms.every(string))
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"authorization server must advertise token assertion signing algorithms",
		);
	return { issuer, tokenEndpoint, algorithms };
}

export async function exchangeAgentAccessToken(options: {
	readonly port: HttpPort;
	readonly discovery: AuthMdDiscovery;
	readonly registration: AgentRegistration;
	readonly principal?: ClaimedAgentPrincipal;
	readonly requestedScopes?: readonly Scope[];
	readonly now?: () => Date;
}): Promise<AgentAccessToken> {
	const { registration, discovery } = options;
	const now = (options.now ?? (() => new Date()))();
	const nowSeconds = Math.floor(now.getTime() / 1000);
	if (
		registration.expiresAt &&
		Date.parse(registration.expiresAt) <= now.getTime()
	)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"agent registration has expired",
		);
	if (
		new URL(registration.binding.service).origin !==
		new URL(discovery.metadata.resource).origin
	)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"agent registration belongs to another resource",
		);
	if (
		options.principal &&
		(options.principal.registrationRef !== registration.registrationRef ||
			!sessionBindingsMatch(options.principal.binding, registration.binding))
	)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"claimed principal differs from the registered session binding",
		);
	const allowedScopes =
		options.principal?.postClaimScopes ?? registration.preClaimScopes;
	const scopes = options.requestedScopes ?? allowedScopes;
	if (
		!scopesSubsetOf(scopes, allowedScopes) ||
		!scopesSubsetOf(scopes, discovery.effectiveScopes)
	)
		throw authMdError(
			"AUTHMD_SCOPE_WIDENING_DENIED",
			"token request exceeds the registered or advertised scopes",
		);
	const authorization = await discoverAgentTokenEndpoint(
		options.port,
		discovery,
	);
	let key: KeyObject;
	try {
		const material = discloseSensitive(registration.keyMaterial);
		key = material.trimStart().startsWith("{")
			? createPrivateKey({
					// SAFETY: Node crypto parses and validates the JWK before any signing operation.
					key: JSON.parse(material) as JsonWebKey,
					format: "jwk",
				})
			: createPrivateKey(material);
	} catch {
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"registered agent private key cannot sign an assertion",
		);
	}
	const algorithm =
		key.asymmetricKeyType === "ed25519"
			? "EdDSA"
			: key.asymmetricKeyType === "ec" &&
					key.asymmetricKeyDetails?.namedCurve === "prime256v1"
				? "ES256"
				: key.asymmetricKeyType === "rsa"
					? "RS256"
					: undefined;
	if (!algorithm || !authorization.algorithms.includes(algorithm))
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"registered agent key has no advertised signing algorithm",
		);
	const expires = Math.min(
		nowSeconds + 60,
		registration.expiresAt
			? Math.floor(Date.parse(registration.expiresAt) / 1000)
			: nowSeconds + 60,
	);
	const encode = (value: Readonly<Record<string, string | number>>) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const signingInput = `${encode({ typ: "JWT", alg: algorithm })}.${encode({ iss: registration.registrationRef, sub: registration.registrationRef, aud: authorization.tokenEndpoint, iat: nowSeconds, exp: expires, jti: randomUUID(), session_id: registration.binding.sessionId, tenant_id: registration.binding.tenantId, project_id: registration.binding.projectId, resource: discovery.metadata.resource, audience: registration.binding.audience, service: registration.binding.service })}`;
	let assertion: string;
	try {
		const signature = sign(
			algorithm === "EdDSA" ? null : "sha256",
			Buffer.from(signingInput),
			{ key, dsaEncoding: "ieee-p1363" },
		);
		assertion = `${signingInput}.${signature.toString("base64url")}`;
	} catch {
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"registered agent key failed to sign the client assertion",
		);
	}
	const raw = object(
		await requestJson(options.port, authorization.tokenEndpoint, {
			method: "POST",
			rejectRedirects: true,
			formBody: {
				grant_type: "client_credentials",
				client_id: registration.registrationRef,
				client_assertion_type:
					"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
				client_assertion: assertion,
				resource: discovery.metadata.resource,
				audience: registration.binding.audience,
				scope: scopes.join(" "),
				session_id: registration.binding.sessionId,
				tenant_id: registration.binding.tenantId,
				project_id: registration.binding.projectId,
				service: registration.binding.service,
			},
		}),
		"token response",
	);
	if (
		!string(raw.access_token) ||
		!raw.access_token ||
		!string(raw.token_type) ||
		raw.token_type.toLowerCase() !== "bearer"
	)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"token response did not carry a bearer access token",
		);
	if (!Number.isSafeInteger(raw.expires_in) || Number(raw.expires_in) <= 0)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"token response must declare a positive expires_in",
		);
	if (
		raw.audience !== undefined &&
		raw.audience !== registration.binding.audience
	)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"token response audience differs from the requested binding",
		);
	if (
		raw.resource !== undefined &&
		raw.resource !== discovery.metadata.resource
	)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"token response resource differs from discovery",
		);
	const returnedBinding = [
		["session_id", registration.binding.sessionId],
		["tenant_id", registration.binding.tenantId],
		["project_id", registration.binding.projectId],
		["service", registration.binding.service],
	] as const;
	for (const [field, expected] of returnedBinding)
		if (raw[field] !== undefined && raw[field] !== expected)
			throw authMdError(
				"AUTHMD_ASSERTION_INVALID",
				`token response ${field} differs from the requested binding`,
			);
	const granted =
		raw.scope === undefined
			? scopes
			: parseScopes(
					string(raw.scope)
						? raw.scope.split(/\s+/u).filter(Boolean)
						: raw.scope,
					"token scopes",
				);
	if (!scopesSubsetOf(granted, scopes))
		throw authMdError(
			"AUTHMD_SCOPE_WIDENING_DENIED",
			"token response widened the requested scopes",
		);
	const expiresAt = new Date(now.getTime() + Number(raw.expires_in) * 1000);
	if (
		!Number.isFinite(expiresAt.getTime()) ||
		(registration.expiresAt &&
			expiresAt.getTime() > Date.parse(registration.expiresAt))
	)
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"access token would outlive its registration",
		);
	return Object.freeze({
		registrationRef: registration.registrationRef,
		accessToken: createSensitive(
			"access-token",
			raw.access_token,
			materialHandle(
				registration.registrationRef,
				now.toISOString(),
				authorization.issuer,
				raw.access_token,
			),
		),
		tokenType: "Bearer",
		scopes: granted,
		binding: registration.binding,
		issuedAt: parseInstant(now.toISOString()),
		expiresAt: parseInstant(expiresAt.toISOString()),
		issuer: authorization.issuer,
	});
}
