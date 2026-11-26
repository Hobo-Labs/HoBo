import { asJsonObject, type JsonObject } from "./json.js";

export const IDENTITY_EVENT_SCHEMA_VERSION = "hobo.identity-events/v1";

export const CREDENTIAL_AUDIT_RETENTION = Object.freeze({
	class: "security-audit",
	neverCompact: true,
	streamPolicy: "retain-token-identity-session-audit",
});

export type IdentityEvent = Readonly<{
	id: string;
	type: "identity.Issued" | "identity.Rotated";
	schemaVersion: typeof IDENTITY_EVENT_SCHEMA_VERSION;
	tenant: string;
	seq: number;
	time: string;
	actor: Readonly<{ kind: string; id: string }>;
	correlationId: string;
	causationId: string;
	retention: typeof CREDENTIAL_AUDIT_RETENTION;
	data: JsonObject;
}>;

export function createIdentityIssuedEvent(input: {
	identityId: string;
	subject: string;
	svidRef: string;
	scope: readonly Readonly<{
		port: string;
		resource: string;
		verbs: readonly string[];
	}>[];
	expiresAt: string;
	tenant: string;
	seq?: number;
	time?: string;
}): IdentityEvent {
	return {
		id: `evt-identity-issued-${input.identityId}`,
		type: "identity.Issued",
		schemaVersion: IDENTITY_EVENT_SCHEMA_VERSION,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/identity" },
		correlationId: `corr-${input.identityId}`,
		causationId: `cmd-issue-${input.identityId}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: asJsonObject({
			identityId: input.identityId,
			subject: input.subject,
			svidRef: input.svidRef,
			scope: input.scope,
			expiresAt: input.expiresAt,
		}),
	};
}

export function createIdentityRotatedEvent(input: {
	identityId: string;
	previousIdentityId: string;
	subject: string;
	svidRef: string;
	expiresAt: string;
	tenant: string;
	seq?: number;
	time?: string;
}): IdentityEvent {
	return {
		id: `evt-identity-rotated-${input.identityId}`,
		type: "identity.Rotated",
		schemaVersion: IDENTITY_EVENT_SCHEMA_VERSION,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/identity" },
		correlationId: `corr-${input.identityId}`,
		causationId: `cmd-rotate-${input.identityId}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: {
			identityId: input.identityId,
			previousIdentityId: input.previousIdentityId,
			subject: input.subject,
			svidRef: input.svidRef,
			expiresAt: input.expiresAt,
		},
	};
}

export function validateIdentityEvent(event: IdentityEvent): void {
	if (event.schemaVersion !== IDENTITY_EVENT_SCHEMA_VERSION) {
		throw new Error("identity event schema version mismatch");
	}
	if (event.type === "identity.Issued") {
		for (const field of [
			"identityId",
			"subject",
			"svidRef",
			"scope",
			"expiresAt",
		] as const) {
			if (event.data[field] === undefined) {
				throw new Error(`identity.Issued missing ${field}`);
			}
		}
	}
	if (event.type === "identity.Rotated") {
		for (const field of [
			"identityId",
			"previousIdentityId",
			"subject",
			"svidRef",
			"expiresAt",
		] as const) {
			if (event.data[field] === undefined) {
				throw new Error(`identity.Rotated missing ${field}`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Token-broker events (S2-04)
//
// The token broker mints per-deploy, scoped, TTL'd tokens bound to an SVID and a
// (port, resource, action) scope. Its events share the exact envelope and
// never-compact CREDENTIAL_AUDIT_RETENTION of the identity events above so the
// credential-audit projection (S3-04) can fold both families off one stream.
// ---------------------------------------------------------------------------

export const TOKEN_EVENT_SCHEMA_VERSION = "hobo.token-events/v1";

export type TokenEvent = Readonly<{
	id: string;
	type: "token.Granted" | "token.Used" | "token.Revoked";
	schemaVersion: typeof TOKEN_EVENT_SCHEMA_VERSION;
	tenant: string;
	seq: number;
	time: string;
	actor: Readonly<{ kind: string; id: string }>;
	correlationId: string;
	causationId: string;
	retention: typeof CREDENTIAL_AUDIT_RETENTION;
	data: JsonObject;
}>;

export type TokenScope = Readonly<{
	port: string;
	resource: string;
	action: string;
}>;

export function createTokenGrantedEvent(input: {
	grantId: string;
	svidSubject: string;
	svidIdentityId: string;
	tokenRef: string;
	scope: TokenScope;
	expiresAt: string;
	tenant: string;
	seq?: number;
	time?: string;
	/** When issued via a first-class Connection. */
	connectionId?: string;
	credentialSource?: string;
}): TokenEvent {
	return {
		id: `evt-token-granted-${input.grantId}`,
		type: "token.Granted",
		schemaVersion: TOKEN_EVENT_SCHEMA_VERSION,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/token-broker" },
		correlationId: `corr-${input.grantId}`,
		causationId: `cmd-grant-${input.grantId}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: {
			grantId: input.grantId,
			svidSubject: input.svidSubject,
			svidIdentityId: input.svidIdentityId,
			tokenRef: input.tokenRef,
			scope: input.scope,
			expiresAt: input.expiresAt,
			...(input.connectionId !== undefined
				? { connectionId: input.connectionId }
				: undefined),
			...(input.credentialSource !== undefined
				? { credentialSource: input.credentialSource }
				: undefined),
		},
	};
}

export function createTokenUsedEvent(input: {
	grantId: string;
	svidSubject: string;
	tokenRef: string;
	scope: TokenScope;
	tenant: string;
	seq?: number;
	time?: string;
}): TokenEvent {
	return {
		id: `evt-token-used-${input.grantId}-${input.seq ?? 0}`,
		type: "token.Used",
		schemaVersion: TOKEN_EVENT_SCHEMA_VERSION,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/token-broker" },
		correlationId: `corr-${input.grantId}`,
		causationId: `cmd-use-${input.grantId}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: {
			grantId: input.grantId,
			svidSubject: input.svidSubject,
			tokenRef: input.tokenRef,
			scope: input.scope,
		},
	};
}

export function createTokenRevokedEvent(input: {
	grantId: string;
	svidSubject: string;
	tokenRef: string;
	reason: string;
	tenant: string;
	seq?: number;
	time?: string;
}): TokenEvent {
	return {
		id: `evt-token-revoked-${input.grantId}`,
		type: "token.Revoked",
		schemaVersion: TOKEN_EVENT_SCHEMA_VERSION,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/token-broker" },
		correlationId: `corr-${input.grantId}`,
		causationId: `cmd-revoke-${input.grantId}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: {
			grantId: input.grantId,
			svidSubject: input.svidSubject,
			tokenRef: input.tokenRef,
			reason: input.reason,
		},
	};
}

export function validateTokenEvent(event: TokenEvent): void {
	if (event.schemaVersion !== TOKEN_EVENT_SCHEMA_VERSION) {
		throw new Error("token event schema version mismatch");
	}
	if (event.retention.neverCompact !== true) {
		throw new Error(
			"token event must carry never-compact credential-audit retention",
		);
	}
	if (event.type === "token.Granted") {
		for (const field of [
			"grantId",
			"svidSubject",
			"tokenRef",
			"scope",
			"expiresAt",
		] as const) {
			if (event.data[field] === undefined) {
				throw new Error(`token.Granted missing ${field}`);
			}
		}
	}
}
