/**
 * Human claim of a pre-claim agent principal.
 *
 * Two rules carry the weight here:
 *
 * - Post-claim scopes may never silently widen past the pre-claim set. Extra
 *   scopes require an explicit `HumanAuthorization` that names them; without
 *   it the claim is refused with AUTHMD_SCOPE_WIDENING_DENIED, even if the
 *   service happily granted them.
 * - A claim is bound to the same session + tenant/project + audience + exact
 *   service as the registration. A claim polled under a different binding is
 *   not the same authorization.
 */
import { authMdError } from "./errors.js";
import type { HttpPort } from "./http.js";
import { requestJson } from "./http.js";
import type { SensitiveRef } from "./redaction.js";
import { createSensitive, discloseSensitive } from "./redaction.js";
import type { AgentRegistration } from "./registration.js";
import { materialHandle } from "./registration.js";
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
	parseScopes,
	scopesAddedBy,
	scopesSubsetOf,
	sessionBindingMismatches,
} from "./types.js";

/**
 * The pointer a ClaimBundle carries. Deliberately plain strings/booleans: it
 * crosses package boundaries and gets persisted, so it holds no branded types
 * and, above all, no material.
 */
// domain-view: parsed derived type; wire form is AgentPrincipalClaimRefRecord in data-models/auth_md.proto.
export interface AgentPrincipalClaimRef {
	readonly protocol: "auth.md" | "custom";
	readonly registrationRef: string;
	readonly preClaimScopes: readonly string[];
	readonly postClaimScopes: readonly string[];
	readonly rotateAfterInfrastructureClaim: boolean;
}

/** Explicit, attributable human consent to widen scopes. */
export interface HumanAuthorization {
	readonly authorizedScopes: readonly Scope[];
	readonly authorizedBy: string;
	readonly authorizedAt: Instant;
}

export interface ClaimInitiation {
	readonly registrationRef: RegistrationRef;
	/** Where the human goes to approve. Safe to show and log. */
	readonly claimUrl: HttpsUrl;
	/** Poll credential; renders as `"[redacted]"`. */
	readonly pollToken: SensitiveRef<"claim-token">;
	readonly pollEndpoint: HttpsUrl;
	readonly expiresAt: Instant;
	readonly intervalSeconds: number;
	readonly requestedPostClaimScopes: readonly Scope[];
}

export interface ClaimedAgentPrincipal {
	readonly registrationRef: RegistrationRef;
	readonly phase: "human-bound";
	readonly humanSubject: string;
	readonly binding: SessionBinding;
	readonly preClaimScopes: readonly Scope[];
	readonly postClaimScopes: readonly Scope[];
	readonly claimedAt: Instant;
	readonly rotateAfterInfrastructureClaim: boolean;
	/** False until `rotateAgentCredentials` runs; gates management access. */
	readonly rotationSatisfied: boolean;
}

export type ClaimPollResult =
	| { readonly status: "pending"; readonly retryAfterSeconds: number }
	| { readonly status: "claimed"; readonly principal: ClaimedAgentPrincipal };

export interface InitiateHumanClaimOptions {
	readonly port: HttpPort;
	readonly registration: AgentRegistration;
	readonly requestedPostClaimScopes: readonly Scope[];
	/** Overrides `registration.claimEndpoint`; one of the two is required. */
	readonly claimEndpoint?: string;
	readonly now?: () => Date;
}

export async function initiateHumanClaim(
	options: InitiateHumanClaimOptions,
): Promise<ClaimInitiation> {
	const endpoint = options.claimEndpoint ?? options.registration.claimEndpoint;
	if (endpoint === undefined) {
		throw authMdError(
			"AUTHMD_REGISTRATION_UNSUPPORTED",
			"no claim endpoint was advertised for this registration",
			{ registrationRef: options.registration.registrationRef },
		);
	}

	const raw = await requestJson(options.port, endpoint, {
		method: "POST",
		jsonBody: {
			registration_ref: options.registration.registrationRef,
			session_id: options.registration.binding.sessionId,
			tenant_id: options.registration.binding.tenantId,
			project_id: options.registration.binding.projectId,
			audience: options.registration.binding.audience,
			service: options.registration.binding.service,
			requested_scopes: [...options.requestedPostClaimScopes],
		},
	});

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"claim initiation response must be a JSON object",
		);
	}
	const record = raw as Record<string, unknown>;
	const pollToken = record.poll_token;
	if (typeof pollToken !== "string" || pollToken.length === 0) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"claim initiation response carried no poll token",
		);
	}
	const expiresAt = parseInstant(record.expires_at, "expires_at");

	return Object.freeze({
		registrationRef: options.registration.registrationRef,
		claimUrl: parseHttpsUrl(record.claim_url, "claim_url"),
		pollToken: createSensitive(
			"claim-token",
			pollToken,
			materialHandle(options.registration.registrationRef, expiresAt),
		),
		pollEndpoint: parseHttpsUrl(record.poll_endpoint, "poll_endpoint"),
		expiresAt,
		intervalSeconds:
			typeof record.interval_seconds === "number" &&
			Number.isFinite(record.interval_seconds)
				? record.interval_seconds
				: 5,
		requestedPostClaimScopes: options.requestedPostClaimScopes,
	});
}

export interface PollHumanClaimOptions {
	readonly port: HttpPort;
	readonly initiation: ClaimInitiation;
	readonly registration: AgentRegistration;
	readonly humanAuthorization?: HumanAuthorization;
	readonly now?: () => Date;
}

export async function pollHumanClaim(
	options: PollHumanClaimOptions,
): Promise<ClaimPollResult> {
	const now = instantFrom((options.now ?? (() => new Date()))());
	if (Date.parse(now) >= Date.parse(options.initiation.expiresAt)) {
		throw authMdError(
			"AUTHMD_CLAIM_EXPIRED",
			"the human claim window closed before the claim completed",
			{
				registrationRef: options.initiation.registrationRef,
				expiresAt: options.initiation.expiresAt,
			},
		);
	}

	const raw = await requestJson(options.port, options.initiation.pollEndpoint, {
		method: "POST",
		jsonBody: {
			registration_ref: options.initiation.registrationRef,
			poll_token: discloseSensitive(options.initiation.pollToken),
		},
	});

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"claim poll response must be a JSON object",
		);
	}
	const record = raw as Record<string, unknown>;
	const status = record.status;

	if (status === "pending") {
		return {
			status: "pending",
			retryAfterSeconds:
				typeof record.interval_seconds === "number"
					? record.interval_seconds
					: options.initiation.intervalSeconds,
		};
	}

	if (status === "expired") {
		throw authMdError(
			"AUTHMD_CLAIM_EXPIRED",
			"the service reports the claim window has closed",
			{ registrationRef: options.initiation.registrationRef },
		);
	}

	if (status === "revoked") {
		throw authMdError(
			"AUTHMD_REVOKED",
			"the agent principal was revoked before the claim completed",
			{ registrationRef: options.initiation.registrationRef },
		);
	}

	if (status !== "claimed") {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`unrecognized claim status: ${typeof status === "string" ? status : "non-string"}`,
		);
	}

	const humanSubject = record.human_subject;
	if (typeof humanSubject !== "string" || humanSubject.length === 0) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			"claimed response names no human subject",
		);
	}

	const grantedScopes = parseScopes(record.granted_scopes, "granted_scopes");
	const postClaimScopes = resolveClaimScopes({
		preClaimScopes: options.registration.preClaimScopes,
		grantedScopes,
		...(options.humanAuthorization === undefined
			? {}
			: { humanAuthorization: options.humanAuthorization }),
	});

	const claimedAt =
		record.claimed_at === undefined
			? now
			: parseInstant(record.claimed_at, "claimed_at");

	return {
		status: "claimed",
		principal: Object.freeze({
			registrationRef: options.registration.registrationRef,
			phase: "human-bound" as const,
			humanSubject,
			binding: options.registration.binding,
			preClaimScopes: options.registration.preClaimScopes,
			postClaimScopes,
			claimedAt,
			rotateAfterInfrastructureClaim:
				record.rotate_after_infrastructure_claim !== false,
			rotationSatisfied: false,
		}),
	};
}

export interface ResolveClaimScopesInput {
	readonly preClaimScopes: readonly Scope[];
	readonly grantedScopes: readonly Scope[];
	readonly humanAuthorization?: HumanAuthorization;
}

/**
 * The widening gate. Scopes at or below the pre-claim set pass. Anything
 * above must appear in an explicit human authorization; otherwise the claim
 * is refused rather than quietly accepted at the wider set.
 */
export function resolveClaimScopes(
	input: ResolveClaimScopesInput,
): readonly Scope[] {
	const widened = scopesAddedBy(input.grantedScopes, input.preClaimScopes);
	if (widened.length === 0) return input.grantedScopes;

	const authorization = input.humanAuthorization;
	if (
		authorization === undefined ||
		!scopesSubsetOf(widened, authorization.authorizedScopes)
	) {
		throw authMdError(
			"AUTHMD_SCOPE_WIDENING_DENIED",
			"post-claim scopes widen past the pre-claim set without explicit human authorization",
			{
				preClaim: input.preClaimScopes.join(" "),
				granted: input.grantedScopes.join(" "),
				widened: widened.join(" "),
				authorizedBy: authorization?.authorizedBy ?? "none",
			},
		);
	}
	return input.grantedScopes;
}

/** Build the ClaimBundle-facing pointer. Contains no branded types, no material. */
export function toAgentPrincipalClaimRef(
	principal: ClaimedAgentPrincipal,
	protocol: "auth.md" | "custom" = "auth.md",
): AgentPrincipalClaimRef {
	return Object.freeze({
		protocol,
		registrationRef: principal.registrationRef,
		preClaimScopes: Object.freeze([...principal.preClaimScopes]),
		postClaimScopes: Object.freeze([...principal.postClaimScopes]),
		rotateAfterInfrastructureClaim: principal.rotateAfterInfrastructureClaim,
	});
}

/** Pre-claim pointer: registered, not yet claimed, so post-claim scopes are empty. */
export function preClaimAgentPrincipalClaimRef(
	registration: AgentRegistration,
	rotateAfterInfrastructureClaim = true,
	protocol: "auth.md" | "custom" = "auth.md",
): AgentPrincipalClaimRef {
	return Object.freeze({
		protocol,
		registrationRef: registration.registrationRef,
		preClaimScopes: Object.freeze([...registration.preClaimScopes]),
		postClaimScopes: Object.freeze([]),
		rotateAfterInfrastructureClaim,
	});
}

/** Fail closed when a later call arrives under a different four-part binding. */
export function assertBindingMatches(
	expected: SessionBinding,
	actual: SessionBinding,
	registrationRef: string,
): void {
	const mismatches = sessionBindingMismatches(expected, actual);
	if (mismatches.length > 0) {
		throw authMdError(
			"AUTHMD_ASSERTION_INVALID",
			"pre-claim authorization is bound to a different session, tenant/project, audience, or service",
			{ registrationRef, mismatches: mismatches.join(" ") },
		);
	}
}
