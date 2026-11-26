/**
 * Anonymous agent registration.
 *
 * Registration is offered only when the *metadata* advertises an endpoint —
 * a `/auth.md` paragraph promising anonymous registration is not sufficient,
 * because prose is not authoritative. What comes back is a pre-claim agent
 * principal: an opaque `registrationRef`, the scopes actually granted, and a
 * `SensitiveRef` locator for the key material. The key value never leaves the
 * vault, so it cannot be logged, serialized, or committed to a fixture.
 */
import { createHash } from "node:crypto";

import type { AuthMdDiscovery } from "./discovery.js";
import { authMdError } from "./errors.js";
import type { HttpPort } from "./http.js";
import { requestJson } from "./http.js";
import {
	type AuthMdJsonValue,
	authMdJsonObject,
	authMdJsonString,
} from "./json.js";
import type { SensitiveRef } from "./redaction.js";
import { createSensitive } from "./redaction.js";
import type {
	HttpsUrl,
	Instant,
	RegistrationRef,
	Scope,
	SessionBinding,
} from "./types.js";
import {
	instantFrom,
	parseHttpsUrl,
	parseInstant,
	parseRegistrationRef,
	parseScopes,
	scopesAddedBy,
	scopesSubsetOf,
} from "./types.js";

// domain-view: parsed derived type; wire form is AgentRegistrationRecord in data-models/auth_md.proto.
export interface AgentRegistration {
	readonly registrationRef: RegistrationRef;
	readonly preClaimScopes: readonly Scope[];
	/** Opaque handle. `JSON.stringify` renders it as `"[redacted]"`. */
	readonly keyMaterial: SensitiveRef<"agent-private-key">;
	readonly binding: SessionBinding;
	readonly issuedAt: Instant;
	readonly expiresAt?: Instant;
	/** Where a human starts the claim, when the service advertises one. */
	readonly claimEndpoint?: HttpsUrl;
	readonly rotationEndpoint?: HttpsUrl;
	readonly revocationEndpoint?: HttpsUrl;
	readonly phase: "pre-claim";
}

export interface RegisterAnonymousAgentOptions {
	readonly port: HttpPort;
	readonly discovery: AuthMdDiscovery;
	readonly binding: SessionBinding;
	readonly requestedScopes: readonly Scope[];
	readonly now?: () => Date;
}

export function materialHandle(...parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

export async function registerAnonymousAgent(
	options: RegisterAnonymousAgentOptions,
): Promise<AgentRegistration> {
	const { discovery, binding } = options;
	const endpoint = discovery.anonymousRegistrationEndpoint;
	if (endpoint === undefined) {
		throw authMdError(
			"AUTHMD_REGISTRATION_UNSUPPORTED",
			"protected resource metadata advertises no anonymous registration endpoint",
			{
				resource: discovery.metadata.resource,
				documentClaims: String(
					discovery.document?.declaresAnonymousRegistration ?? false,
				),
			},
		);
	}

	const resourceOrigin = new URL(discovery.metadata.resource).origin;
	if (new URL(binding.service).origin !== resourceOrigin) {
		throw authMdError(
			"AUTHMD_REGISTRATION_UNSUPPORTED",
			"session binding names a different service than the discovered resource",
			{ service: binding.service, resource: discovery.metadata.resource },
		);
	}

	if (!scopesSubsetOf(options.requestedScopes, discovery.effectiveScopes)) {
		throw authMdError(
			"AUTHMD_SCOPE_WIDENING_DENIED",
			"requested pre-claim scopes exceed the scopes the resource supports",
			{
				requested: options.requestedScopes.join(" "),
				supported: discovery.effectiveScopes.join(" "),
			},
		);
	}

	const raw = await requestJson(options.port, endpoint, {
		method: "POST",
		jsonBody: {
			resource: discovery.metadata.resource,
			audience: binding.audience,
			session_id: binding.sessionId,
			tenant_id: binding.tenantId,
			project_id: binding.projectId,
			service: binding.service,
			requested_scopes: [...options.requestedScopes],
		},
	});

	return parseRegistrationResponse(raw, options);
}

function parseRegistrationResponse(
	raw: AuthMdJsonValue,
	options: RegisterAnonymousAgentOptions,
): AgentRegistration {
	const record = authMdJsonObject(raw, "registration response");
	const registrationRef = parseRegistrationRef(record.registration_ref);
	const granted = parseScopes(record.granted_scopes, "granted_scopes");

	const widened = scopesAddedBy(granted, options.requestedScopes);
	if (widened.length > 0) {
		throw authMdError(
			"AUTHMD_SCOPE_WIDENING_DENIED",
			"registration granted scopes that were never requested",
			{
				granted: granted.join(" "),
				requested: options.requestedScopes.join(" "),
				widened: widened.join(" "),
			},
		);
	}

	const material = record.private_key ?? record.key_material;
	if (!authMdJsonString(material) || material.length === 0) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"registration response carried no agent key material",
			{ registrationRef },
		);
	}

	const issuedAt =
		record.issued_at === undefined
			? instantFrom((options.now ?? (() => new Date()))())
			: parseInstant(record.issued_at, "issued_at");

	const registration: AgentRegistration = {
		registrationRef,
		preClaimScopes: granted,
		keyMaterial: createSensitive(
			"agent-private-key",
			material,
			materialHandle(registrationRef, issuedAt),
		),
		binding: options.binding,
		issuedAt,
		phase: "pre-claim",
	};
	if (record.expires_at !== undefined)
		Object.assign(registration, {
			expiresAt: parseInstant(record.expires_at, "expires_at"),
		});
	if (record.claim_endpoint !== undefined)
		Object.assign(registration, {
			claimEndpoint: parseHttpsUrl(record.claim_endpoint, "claim_endpoint"),
		});
	if (record.rotation_endpoint !== undefined)
		Object.assign(registration, {
			rotationEndpoint: parseHttpsUrl(
				record.rotation_endpoint,
				"rotation_endpoint",
			),
		});
	if (record.revocation_endpoint !== undefined)
		Object.assign(registration, {
			revocationEndpoint: parseHttpsUrl(
				record.revocation_endpoint,
				"revocation_endpoint",
			),
		});
	return Object.freeze(registration);
}
