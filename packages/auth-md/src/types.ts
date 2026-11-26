/**
 * Parsed derived types for the auth.md plane.
 *
 * Parse, don't validate: untrusted input (provider JSON, prose documents,
 * caller options) crosses exactly one parser boundary here and becomes a
 * branded, refined domain type. Nothing downstream re-checks a string.
 */
import { authMdError } from "./errors.js";

export type HttpsUrl = string & { readonly __brand: "HttpsUrl" };
export type Scope = string & { readonly __brand: "Scope" };
export type RegistrationRef = string & { readonly __brand: "RegistrationRef" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type TenantId = string & { readonly __brand: "TenantId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type Audience = string & { readonly __brand: "Audience" };
export type Instant = string & { readonly __brand: "Instant" };

const SCOPE_PATTERN = /^[A-Za-z0-9:._-]+$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`${field} must be a non-empty string`,
			{ field },
		);
	}
	return value;
}

/** HTTPS-only by construction: discovery never dereferences a plain-HTTP URL. */
export function parseHttpsUrl(value: unknown, field = "url"): HttpsUrl {
	const raw = requireNonEmptyString(value, field);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw authMdError("AUTHMD_METADATA_INVALID", `${field} is not a URL`, {
			field,
		});
	}
	if (url.protocol !== "https:") {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`${field} must use https (got ${url.protocol})`,
			{ field, protocol: url.protocol },
		);
	}
	return url.toString() as HttpsUrl;
}

export function parseScope(value: unknown, field = "scope"): Scope {
	const raw = requireNonEmptyString(value, field);
	if (!SCOPE_PATTERN.test(raw)) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`${field} is not a well-formed scope`,
			{ field },
		);
	}
	return raw as Scope;
}

export function parseScopes(
	value: unknown,
	field = "scopes",
): readonly Scope[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`${field} must be an array of scopes`,
			{ field },
		);
	}
	const seen = new Set<string>();
	const scopes: Scope[] = [];
	for (const entry of value) {
		const scope = parseScope(entry, field);
		if (seen.has(scope)) continue;
		seen.add(scope);
		scopes.push(scope);
	}
	return Object.freeze(scopes);
}

export function parseInstant(value: unknown, field = "instant"): Instant {
	const raw = requireNonEmptyString(value, field);
	if (!INSTANT_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
		throw authMdError(
			"AUTHMD_METADATA_INVALID",
			`${field} must be an ISO-8601 UTC instant`,
			{ field },
		);
	}
	return raw as Instant;
}

export function instantFrom(date: Date): Instant {
	return date.toISOString() as Instant;
}

export function parseRegistrationRef(
	value: unknown,
	field = "registrationRef",
): RegistrationRef {
	return requireNonEmptyString(value, field) as RegistrationRef;
}

/**
 * The four-part binding a pre-claim authorization is scoped to. A pre-claim
 * credential is usable only for this session, in this tenant/project, for this
 * audience, against this exact service — never "the agent is trusted here".
 */
// domain-view: parsed derived type; wire form is SessionBindingRecord in data-models/auth_md.proto.
export interface SessionBinding {
	readonly sessionId: SessionId;
	readonly tenantId: TenantId;
	readonly projectId: ProjectId;
	readonly audience: Audience;
	readonly service: HttpsUrl;
}

export interface SessionBindingInput {
	readonly sessionId: string;
	readonly tenantId: string;
	readonly projectId: string;
	readonly audience: string;
	readonly service: string;
}

export function parseSessionBinding(
	input: SessionBindingInput,
): SessionBinding {
	return Object.freeze({
		sessionId: requireNonEmptyString(input.sessionId, "sessionId") as SessionId,
		tenantId: requireNonEmptyString(input.tenantId, "tenantId") as TenantId,
		projectId: requireNonEmptyString(input.projectId, "projectId") as ProjectId,
		audience: requireNonEmptyString(input.audience, "audience") as Audience,
		service: parseHttpsUrl(input.service, "service"),
	});
}

export function sessionBindingsMatch(
	left: SessionBinding,
	right: SessionBinding,
): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.tenantId === right.tenantId &&
		left.projectId === right.projectId &&
		left.audience === right.audience &&
		left.service === right.service
	);
}

/** Which of the four binding dimensions disagree (for fail-closed diagnostics). */
export function sessionBindingMismatches(
	expected: SessionBinding,
	actual: SessionBinding,
): readonly string[] {
	const fields: readonly (keyof SessionBinding)[] = [
		"sessionId",
		"tenantId",
		"projectId",
		"audience",
		"service",
	];
	return Object.freeze(
		fields.filter((field) => expected[field] !== actual[field]),
	);
}

export function scopesSubsetOf(
	candidate: readonly Scope[],
	allowed: readonly Scope[],
): boolean {
	const allowedSet = new Set<string>(allowed);
	return candidate.every((scope) => allowedSet.has(scope));
}

export function scopesAddedBy(
	candidate: readonly Scope[],
	baseline: readonly Scope[],
): readonly Scope[] {
	const baselineSet = new Set<string>(baseline);
	return Object.freeze(candidate.filter((scope) => !baselineSet.has(scope)));
}
