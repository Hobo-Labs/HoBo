/**
 * First-class Connection event family (durable broker-owned aggregate).
 * Shares never-compact credential-audit retention with token/identity events.
 */

import { CREDENTIAL_AUDIT_RETENTION } from "./events.js";
import { asJsonObject, isJsonString, type JsonObject } from "./json.js";

// public-contract: connection event envelope schema version.
export const CONNECTION_EVENT_SCHEMA_VERSION = "hobo.connection-events/v1";

// public-contract: wire schema / event catalog constant.
export const CONNECTION_EVENTS = {
	Created: "connection.Created",
	AuthorizationStarted: "connection.AuthorizationStarted",
	Authorized: "connection.Authorized",
	TokenIssued: "connection.TokenIssued",
	HealthChanged: "connection.HealthChanged",
	NeedsReauth: "connection.NeedsReauth",
	Rotated: "connection.Rotated",
	Revoked: "connection.Revoked",
} as const;

export type ConnectionEventType =
	(typeof CONNECTION_EVENTS)[keyof typeof CONNECTION_EVENTS];

export type ConnectionFlow =
	| "oidc-federation"
	| "oauth2-xaa"
	| "oauth2-obo"
	| "device-code"
	| "api-key"
	| "app-install";

export type ConnectionStatus =
	| "pending"
	| "active"
	| "needs-reauth"
	| "revoked"
	| "expired";

export type ConnectionPrincipalRef = Readonly<{
	kind: "user" | "agent" | "service" | "system";
	id: string;
}>;

export type ConnectionEvent = Readonly<{
	id: string;
	type: ConnectionEventType;
	schemaVersion: typeof CONNECTION_EVENT_SCHEMA_VERSION;
	tenant: string;
	seq: number;
	time: string;
	actor: Readonly<{ kind: string; id: string }>;
	correlationId: string;
	causationId: string;
	retention: typeof CREDENTIAL_AUDIT_RETENTION;
	data: JsonObject;
}>;

function baseEvent<T>(
	type: ConnectionEventType,
	input: {
		connectionId: string;
		tenant: string;
		seq?: number;
		time?: string;
		causationId?: string;
		actorId?: string;
		data: T;
	},
): ConnectionEvent {
	const time = input.time ?? new Date().toISOString();
	return Object.freeze({
		id: `evt-${type.replace(".", "-").toLowerCase()}-${input.connectionId}-${input.seq ?? 0}`,
		type,
		schemaVersion: CONNECTION_EVENT_SCHEMA_VERSION,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time,
		actor: {
			kind: "service",
			id: input.actorId ?? "yard/token-broker",
		},
		correlationId: `corr-connection-${input.connectionId}`,
		causationId:
			input.causationId ?? `cmd-connection-${input.connectionId}-${type}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: asJsonObject({
			connectionId: input.connectionId,
			...input.data,
		}),
	});
}

export function createConnectionCreatedEvent(input: {
	connectionId: string;
	alias?: string;
	provider: string;
	flow: ConnectionFlow;
	subject: ConnectionPrincipalRef;
	tenant: string;
	createdBy: ConnectionPrincipalRef;
	requestedScopes: readonly string[];
	/** Station ownership (required). */
	stationId: string;
	seq?: number;
	time?: string;
}): ConnectionEvent {
	if (!isJsonString(input.stationId) || input.stationId.length === 0) {
		throw new TypeError("connection.Created requires stationId");
	}
	return baseEvent(CONNECTION_EVENTS.Created, {
		connectionId: input.connectionId,
		tenant: input.tenant,
		seq: input.seq,
		time: input.time,
		data: {
			...(input.alias !== undefined ? { alias: input.alias } : undefined),
			provider: input.provider,
			flow: input.flow,
			subject: input.subject,
			createdBy: input.createdBy,
			requestedScopes: Object.freeze([...input.requestedScopes]),
			status: "pending" satisfies ConnectionStatus,
			stationId: input.stationId,
		},
	});
}

export function createConnectionAuthorizationStartedEvent(input: {
	connectionId: string;
	tenant: string;
	flow: ConnectionFlow;
	seq?: number;
	time?: string;
}): ConnectionEvent {
	return baseEvent(CONNECTION_EVENTS.AuthorizationStarted, {
		connectionId: input.connectionId,
		tenant: input.tenant,
		seq: input.seq,
		time: input.time,
		data: { flow: input.flow, status: "pending" },
	});
}

export function createConnectionAuthorizedEvent(input: {
	connectionId: string;
	tenant: string;
	grantedScopes: readonly string[];
	installationId?: string;
	subject: ConnectionPrincipalRef;
	credentialRef: string;
	seq?: number;
	time?: string;
}): ConnectionEvent {
	return baseEvent(CONNECTION_EVENTS.Authorized, {
		connectionId: input.connectionId,
		tenant: input.tenant,
		seq: input.seq,
		time: input.time,
		data: {
			grantedScopes: Object.freeze([...input.grantedScopes]),
			...(input.installationId !== undefined
				? { installationId: input.installationId }
				: undefined),
			subject: input.subject,
			// Opaque vault reference only — never the secret.
			credentialRef: input.credentialRef,
			status: "active" satisfies ConnectionStatus,
		},
	});
}

export function createConnectionTokenIssuedEvent(input: {
	connectionId: string;
	tenant: string;
	grantId: string;
	tokenRef: string;
	scopes: readonly string[];
	expiresAt: string;
	seq?: number;
	time?: string;
}): ConnectionEvent {
	return baseEvent(CONNECTION_EVENTS.TokenIssued, {
		connectionId: input.connectionId,
		tenant: input.tenant,
		seq: input.seq,
		time: input.time,
		data: {
			grantId: input.grantId,
			tokenRef: input.tokenRef,
			scopes: Object.freeze([...input.scopes]),
			expiresAt: input.expiresAt,
		},
	});
}

export function createConnectionHealthChangedEvent(input: {
	connectionId: string;
	tenant: string;
	status: ConnectionStatus;
	reason?: string;
	seq?: number;
	time?: string;
}): ConnectionEvent {
	return baseEvent(
		input.status === "needs-reauth"
			? CONNECTION_EVENTS.NeedsReauth
			: CONNECTION_EVENTS.HealthChanged,
		{
			connectionId: input.connectionId,
			tenant: input.tenant,
			seq: input.seq,
			time: input.time,
			data: {
				status: input.status,
				...(input.reason !== undefined ? { reason: input.reason } : undefined),
			},
		},
	);
}

export function createConnectionRotatedEvent(input: {
	connectionId: string;
	tenant: string;
	previousCredentialRef: string;
	credentialRef: string;
	seq?: number;
	time?: string;
}): ConnectionEvent {
	return baseEvent(CONNECTION_EVENTS.Rotated, {
		connectionId: input.connectionId,
		tenant: input.tenant,
		seq: input.seq,
		time: input.time,
		data: {
			previousCredentialRef: input.previousCredentialRef,
			credentialRef: input.credentialRef,
			status: "active" satisfies ConnectionStatus,
		},
	});
}

export function createConnectionRevokedEvent(input: {
	connectionId: string;
	tenant: string;
	reason: string;
	seq?: number;
	time?: string;
}): ConnectionEvent {
	return baseEvent(CONNECTION_EVENTS.Revoked, {
		connectionId: input.connectionId,
		tenant: input.tenant,
		seq: input.seq,
		time: input.time,
		data: {
			reason: input.reason,
			status: "revoked" satisfies ConnectionStatus,
		},
	});
}

export function validateConnectionEvent(event: ConnectionEvent): void {
	if (event.schemaVersion !== CONNECTION_EVENT_SCHEMA_VERSION) {
		throw new Error("connection event schema version mismatch");
	}
	if (event.retention.neverCompact !== true) {
		throw new Error(
			"connection event must carry never-compact credential-audit retention",
		);
	}
	if (!isJsonString(event.data.connectionId)) {
		throw new Error("connection event missing connectionId");
	}
}

export function isConnectionEventType(
	type: string,
): type is ConnectionEventType {
	// SAFETY: assertion to `ject.values(CONNECTION_EVENTS) as string[]).` is required at this boundary.
	return (Object.values(CONNECTION_EVENTS) as string[]).includes(type);
}
