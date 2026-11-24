import type { EventEnvelope } from "@hobo/core";
import {
	defineProjection,
	type Projection,
	type ProjectionSnapshot,
} from "@hobo/data";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

export const CREDENTIAL_AUDIT_RETENTION = Object.freeze({
	class: "security-audit",
	neverCompact: true,
	streamPolicy: "retain-token-identity-session-audit",
});

export const CREDENTIAL_AUDIT_RETENTION_FLOOR_DAYS = 2555;
export const CREDENTIAL_AUDIT_RETENTION_FLOOR_MS =
	CREDENTIAL_AUDIT_RETENTION_FLOOR_DAYS * 24 * 60 * 60 * 1000;

export const CREDENTIAL_AUDIT_EVENTS = Object.freeze({
	IdentityIssued: "identity.Issued",
	IdentityRotated: "identity.Rotated",
	MigrationStarted: "identity.MigrationStarted",
	DualLinked: "identity.DualLinked",
	ShadowVerified: "identity.ShadowVerified",
	DualConsistencyChecked: "identity.DualConsistencyChecked",
	MigrationProgressed: "identity.MigrationProgressed",
	Migrated: "identity.Migrated",
	MigrationCutover: "identity.MigrationCutover",
	MigrationAborted: "identity.MigrationAborted",
	MigrationCompensated: "identity.MigrationCompensated",
	TokenGranted: "token.Granted",
	TokenUsed: "token.Used",
	TokenRevoked: "token.Revoked",
	SessionStarted: "session.Started",
	SessionRevoked: "session.Revoked",
	ConnectionCreated: "connection.Created",
	ConnectionAuthorized: "connection.Authorized",
	ConnectionTokenIssued: "connection.TokenIssued",
	ConnectionRevoked: "connection.Revoked",
	ConnectionNeedsReauth: "connection.NeedsReauth",
	ConfigResolved: "config.Resolved",
	SecretAccessed: "secret.Accessed",
	ToolCallDecided: "mcp.ToolCallDecided",
	ToolCallThrottled: "mcp.ToolCallThrottled",
	CaptureOpened: "secret.CaptureOpened",
	CaptureWriteStarted: "secret.CaptureWriteStarted",
	CaptureWriteUncertain: "secret.CaptureWriteUncertain",
	CaptureWriterSessionEnded: "secret.CaptureWriterSessionEnded",
	CaptureWriterSessionUncertain: "secret.CaptureWriterSessionUncertain",
	CaptureStored: "secret.CaptureStored",
	CaptureAuthorized: "secret.CaptureAuthorized",
	CaptureRejected: "secret.CaptureRejected",
	CaptureRefused: "secret.CaptureRefused",
	CaptureExpired: "secret.CaptureExpired",
	CaptureClosed: "secret.CaptureClosed",
} as const);

export const CREDENTIAL_AUDIT_EVENT_PREFIXES = Object.freeze([
	"identity.",
	"token.",
	"session.",
	"connection.",
	"config.",
	"secret.",
	"mcp.",
]);

export function isCredentialAuditEvent(event: EventEnvelope): boolean {
	return CREDENTIAL_AUDIT_EVENT_PREFIXES.some((prefix) =>
		event.type.startsWith(prefix),
	);
}

export type CredentialGrantStatus = "granted" | "used" | "revoked";

export interface CredentialAuditScope {
	port: string;
	resource: string;
	action: string;
}

export interface CredentialGrantAudit {
	grantId: string;
	svidSubject?: string;
	scope?: CredentialAuditScope;
	tokenRef?: string;
	status: CredentialGrantStatus;
	grantedAt?: string;
	usedAt?: string;
	revokedAt?: string;
	revokedReason?: string;
	useCount: number;
}

export interface CredentialAuditTimelineEntry {
	seq: number;
	type: string;
	grantId?: string;
	eventId?: string;
	streamId?: string;
	time?: string;
	actorKind?: string;
	actorId?: string;
	tool?: string;
	subject?: string;
	effect?: "allow" | "deny";
	reason?: string;
	name?: string;
	ref?: string;
	code?: string;
	ticketId?: string;
	target?: string;
	channel?: string;
}

export interface CredentialAuditRow {
	tenant?: string;
	correlationId: string;
	grants: Record<string, CredentialGrantAudit>;
	identityIds: string[];
	sessionIds: string[];
	connectionIds: string[];
	configNames: string[];
	secretValueRefs: string[];
	migrationIds: string[];
	timeline: CredentialAuditTimelineEntry[];
	grantCount: number;
	useCount: number;
	revokeCount: number;
	configResolveCount: number;
	secretAccessCount: number;
	migrationEventCount: number;
}

function eventData(event: EventEnvelope): JsonObject {
	return isJsonObject(event.data) ? event.data : {};
}

function optionalString(data: JsonObject, key: string): string | undefined {
	const value = data[key];
	return isJsonString(value) ? value : undefined;
}

function requiredString(data: JsonObject, key: string): string {
	const value = optionalString(data, key);
	if (value === undefined)
		throw new TypeError(`CredentialAudit: ${key} must be a string`);
	return value;
}

function correlationId(event: EventEnvelope): string {
	const data = eventData(event);
	return (
		event.correlationId ??
		optionalString(data, "correlationId") ??
		optionalString(data, "grantId") ??
		event.streamId
	);
}

function auditKey(tenant: string, correlation: string): string {
	return JSON.stringify([tenant, correlation]);
}

function base(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	if (row)
		return {
			...row,
			grants: { ...row.grants },
			identityIds: [...row.identityIds],
			sessionIds: [...row.sessionIds],
			connectionIds: [...(row.connectionIds ?? [])],
			configNames: [...(row.configNames ?? [])],
			secretValueRefs: [...(row.secretValueRefs ?? [])],
			migrationIds: [...(row.migrationIds ?? [])],
			timeline: [...row.timeline],
		};
	return {
		tenant: event.tenant,
		correlationId: correlationId(event),
		grants: {},
		identityIds: [],
		sessionIds: [],
		connectionIds: [],
		configNames: [],
		secretValueRefs: [],
		migrationIds: [],
		timeline: [],
		grantCount: 0,
		useCount: 0,
		revokeCount: 0,
		configResolveCount: 0,
		secretAccessCount: 0,
		migrationEventCount: 0,
	};
}

function appendTimeline(
	row: CredentialAuditRow,
	event: EventEnvelope,
	grantId?: string,
): void {
	const entry: CredentialAuditTimelineEntry = {
		seq: event.seq,
		type: event.type,
	};
	if (grantId !== undefined) entry.grantId = grantId;
	row.timeline.push(entry);
}

function addUnique(values: string[], value: string | undefined): void {
	if (value && !values.includes(value)) values.push(value);
}

function foldIdentity(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const next = base(row, event);
	addUnique(next.identityIds, optionalString(eventData(event), "identityId"));
	appendTimeline(next, event);
	return next;
}

function foldSession(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const next = base(row, event);
	addUnique(next.sessionIds, optionalString(eventData(event), "sessionId"));
	appendTimeline(next, event);
	return next;
}

function foldConnection(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const data = eventData(event);
	const next = base(row, event);
	addUnique(next.connectionIds, optionalString(data, "connectionId"));
	const grantId =
		event.type === CREDENTIAL_AUDIT_EVENTS.ConnectionTokenIssued
			? optionalString(data, "grantId")
			: undefined;
	appendTimeline(next, event, grantId);
	return next;
}

function foldMigration(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const next = base(row, event);
	const migrationId = optionalString(eventData(event), "migrationId");
	if (migrationId) {
		addUnique(next.migrationIds, migrationId);
		next.migrationEventCount += 1;
	}
	appendTimeline(next, event);
	return next;
}

function parseScope(
	value: JsonValue | undefined,
): CredentialAuditScope | undefined {
	if (value === undefined) return undefined;
	if (!isJsonObject(value))
		throw new TypeError("CredentialAudit: scope must be an object");
	return {
		port: requiredString(value, "port"),
		resource: requiredString(value, "resource"),
		action: requiredString(value, "action"),
	};
}

function foldToken(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const data = eventData(event);
	const grantId = requiredString(data, "grantId");
	const next = base(row, event);
	const existing = Object.hasOwn(next.grants, grantId)
		? next.grants[grantId]
		: undefined;
	const grant: CredentialGrantAudit = existing
		? { ...existing }
		: { grantId, status: "granted", useCount: 0 };
	if (event.type === CREDENTIAL_AUDIT_EVENTS.TokenGranted) {
		grant.status = "granted";
		grant.grantedAt = event.ts;
		const subject = optionalString(data, "svidSubject");
		const tokenRef = optionalString(data, "tokenRef");
		const scope = parseScope(data.scope);
		if (subject !== undefined) grant.svidSubject = subject;
		if (tokenRef !== undefined) grant.tokenRef = tokenRef;
		if (scope !== undefined) grant.scope = scope;
		addUnique(next.connectionIds, optionalString(data, "connectionId"));
		next.grantCount += 1;
	} else if (event.type === CREDENTIAL_AUDIT_EVENTS.TokenUsed) {
		if (grant.status !== "revoked") grant.status = "used";
		grant.usedAt = event.ts;
		grant.useCount += 1;
		next.useCount += 1;
	} else {
		grant.status = "revoked";
		grant.revokedAt = event.ts;
		const reason = optionalString(data, "reason");
		if (reason !== undefined) grant.revokedReason = reason;
		next.revokeCount += 1;
	}
	Object.defineProperty(next.grants, grantId, {
		value: grant,
		enumerable: true,
		writable: true,
		configurable: true,
	});
	appendTimeline(next, event, grantId);
	return next;
}

function foldConfig(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const next = base(row, event);
	addUnique(next.configNames, optionalString(eventData(event), "name"));
	next.configResolveCount += 1;
	appendTimeline(next, event);
	return next;
}

function foldSecretAccess(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const data = eventData(event);
	if (data.plaintextPresent === true)
		throw new Error(
			"CredentialAudit: secret.Accessed claimed plaintextPresent",
		);
	const next = base(row, event);
	addUnique(next.secretValueRefs, optionalString(data, "valueRef"));
	next.secretAccessCount += 1;
	appendTimeline(next, event, optionalString(data, "grantId"));
	return next;
}

function foldControlEvent(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	const data = eventData(event);
	for (const key of ["value", "plaintext", "secret", "ciphertext", "token"]) {
		if (Object.hasOwn(data, key))
			throw new TypeError(
				"CredentialAudit: control event contains secret material",
			);
	}
	const next = base(row, event);
	const entry: CredentialAuditTimelineEntry = {
		seq: event.seq,
		type: event.type,
		eventId: event.id,
		streamId: event.streamId,
		time: optionalString(event.meta ?? {}, "sourceTime") ?? event.ts,
		actorKind: event.actor.kind,
		actorId: event.actor.id,
	};
	for (const key of [
		"tool",
		"subject",
		"reason",
		"name",
		"ref",
		"code",
		"ticketId",
		"target",
		"channel",
	] as const) {
		const value = optionalString(data, key);
		if (value !== undefined) entry[key] = value;
	}
	const effect = optionalString(data, "effect");
	if (effect !== undefined) {
		if (effect !== "allow" && effect !== "deny")
			throw new TypeError("CredentialAudit: invalid tool decision");
		entry.effect = effect;
	}
	if (
		event.type === CREDENTIAL_AUDIT_EVENTS.ToolCallDecided &&
		(entry.tool === undefined ||
			entry.subject === undefined ||
			(entry.effect !== "allow" && entry.effect !== "deny"))
	)
		throw new TypeError("CredentialAudit: invalid tool decision");
	if (
		event.type === CREDENTIAL_AUDIT_EVENTS.ToolCallThrottled &&
		(entry.tool === undefined || entry.subject === undefined)
	)
		throw new TypeError("CredentialAudit: invalid tool throttle");
	next.timeline.push(entry);
	return next;
}

const projection = defineProjection<CredentialAuditRow>({
	name: "credential-audit",
	key: (event) => auditKey(event.tenant, correlationId(event)),
	on: {
		[CREDENTIAL_AUDIT_EVENTS.IdentityIssued]: foldIdentity,
		[CREDENTIAL_AUDIT_EVENTS.IdentityRotated]: foldIdentity,
		[CREDENTIAL_AUDIT_EVENTS.SessionStarted]: foldSession,
		[CREDENTIAL_AUDIT_EVENTS.SessionRevoked]: foldSession,
		[CREDENTIAL_AUDIT_EVENTS.ConnectionCreated]: foldConnection,
		[CREDENTIAL_AUDIT_EVENTS.ConnectionAuthorized]: foldConnection,
		[CREDENTIAL_AUDIT_EVENTS.ConnectionTokenIssued]: foldConnection,
		[CREDENTIAL_AUDIT_EVENTS.ConnectionRevoked]: foldConnection,
		[CREDENTIAL_AUDIT_EVENTS.ConnectionNeedsReauth]: foldConnection,
		[CREDENTIAL_AUDIT_EVENTS.MigrationStarted]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.DualLinked]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.ShadowVerified]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.DualConsistencyChecked]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.MigrationProgressed]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.Migrated]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.MigrationCutover]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.MigrationAborted]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.MigrationCompensated]: foldMigration,
		[CREDENTIAL_AUDIT_EVENTS.TokenGranted]: foldToken,
		[CREDENTIAL_AUDIT_EVENTS.TokenUsed]: foldToken,
		[CREDENTIAL_AUDIT_EVENTS.TokenRevoked]: foldToken,
		[CREDENTIAL_AUDIT_EVENTS.ConfigResolved]: foldConfig,
		[CREDENTIAL_AUDIT_EVENTS.SecretAccessed]: foldSecretAccess,
		[CREDENTIAL_AUDIT_EVENTS.ToolCallDecided]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.ToolCallThrottled]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureOpened]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureWriteStarted]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureWriteUncertain]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureWriterSessionEnded]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureWriterSessionUncertain]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureStored]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureAuthorized]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureRejected]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureRefused]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureExpired]: foldControlEvent,
		[CREDENTIAL_AUDIT_EVENTS.CaptureClosed]: foldControlEvent,
	},
});

export const credentialAuditProjection: Projection<CredentialAuditRow> = {
	...projection,
	get(snapshot, correlation) {
		const matches = Object.values(snapshot.rows).filter(
			(row) => row.correlationId === correlation,
		);
		return matches.length === 1 ? matches[0] : undefined;
	},
};

export function getCredentialAuditRow(
	snapshot: ProjectionSnapshot<CredentialAuditRow>,
	tenant: string,
	correlation: string,
): CredentialAuditRow | undefined {
	return snapshot.rows[auditKey(tenant, correlation)];
}

export interface CompactionResult {
	retained: EventEnvelope[];
	droppedCount: number;
	auditPreserved: boolean;
}

export function compactCredentialAuditStream(
	events: readonly EventEnvelope[],
	options: { now?: number; retentionFloorMs?: number } = {},
): CompactionResult {
	const now = options.now ?? Date.now();
	const floorMs =
		options.retentionFloorMs ?? CREDENTIAL_AUDIT_RETENTION_FLOOR_MS;
	const auditTotal = events.filter(isCredentialAuditEvent).length;
	const retained = events.filter(
		(event) =>
			isCredentialAuditEvent(event) || now - Date.parse(event.ts) <= floorMs,
	);
	return {
		retained,
		droppedCount: events.length - retained.length,
		auditPreserved:
			retained.filter(isCredentialAuditEvent).length === auditTotal,
	};
}
