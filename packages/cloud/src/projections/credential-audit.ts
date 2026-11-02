import type { EventEnvelope } from "@hobo/core";
import { defineProjection, type Projection } from "@hobo/data";

// The CredentialAudit projection (S3-04 — ai-native-agent-auth.md §6.2/§6.8). It
// folds the identity/token/session event families into a queryable audit of
// grant → use → revoke, correlated by `correlationId`, so "which agent reached
// which resource as which user, when" is always answerable. It is a read-model
// fold (rebuildable-from-zero — the log is authoritative), and its streams are
// NEVER compacted (NFR-018 retention floor): a compaction pass over an audit
// stream drops nothing, so pre-floor events survive for the full retention window.

// The never-compact retention descriptor. Duplicated locally (identical to
// @hobo/identity's CREDENTIAL_AUDIT_RETENTION) so the read-model does not need an
// inward cloud → identity dependency edge — cloud depends only on
// core/bindles/data/events.
export const CREDENTIAL_AUDIT_RETENTION = Object.freeze({
	class: "security-audit",
	neverCompact: true,
	streamPolicy: "retain-token-identity-session-audit",
});

// NFR-018 retention floor: audit facts are retained at least this long. Seven
// years (2555 days) mirrors the credential-audit-projection technical proof.
export const CREDENTIAL_AUDIT_RETENTION_FLOOR_DAYS = 2555;
export const CREDENTIAL_AUDIT_RETENTION_FLOOR_MS =
	CREDENTIAL_AUDIT_RETENTION_FLOOR_DAYS * 24 * 60 * 60 * 1000;

// The identity/token/session event types the audit folds (data-plane.md event
// catalog). The prefixes classify a stream as a never-compact audit stream.
export const CREDENTIAL_AUDIT_EVENTS = Object.freeze({
	IdentityIssued: "identity.Issued",
	IdentityRotated: "identity.Rotated",
	/** Continuous identity migration plane (never-compact). */
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
	/** ADR-0027 secretless-first config resolution (refs only). */
	ConfigResolved: "config.Resolved",
	/** ADR-0027 residual secret access (version-id; never plaintext). */
	SecretAccessed: "secret.Accessed",
} as const);

export const CREDENTIAL_AUDIT_EVENT_PREFIXES = Object.freeze([
	"identity.",
	"token.",
	"session.",
	"connection.",
	"config.",
	"secret.",
]);

export function isCredentialAuditEvent(event: EventEnvelope): boolean {
	return CREDENTIAL_AUDIT_EVENT_PREFIXES.some((prefix) =>
		event.type.startsWith(prefix),
	);
}

export type CredentialGrantStatus = "granted" | "used" | "revoked";

// The audited (port, resource, action) scope; wire form in cloud.proto.
// domain-view: parse-don't-validate derived type of CredentialAuditScope.
export interface CredentialAuditScope {
	port: string;
	resource: string;
	action: string;
}

// The per-grant lifecycle fold (grant -> use -> revoke); wire form in cloud.proto.
// domain-view: parse-don't-validate derived type of CredentialGrantAudit.
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

// An ordered step in a correlation's credential timeline; wire form in cloud.proto.
// domain-view: parse-don't-validate derived type of CredentialAuditTimelineEntry.
export interface CredentialAuditTimelineEntry {
	seq: number;
	type: string;
	grantId?: string;
}

// domain-view: the CredentialAudit read-model row, one per correlationId. Its
// wire form is CredentialAuditRecord in data-models/cloud.proto.
export interface CredentialAuditRow {
	correlationId: string;
	grants: Record<string, CredentialGrantAudit>;
	identityIds: string[];
	sessionIds: string[];
	/** First-class Connection ids observed on this correlation chain. */
	connectionIds: string[];
	/** Config field names resolved on this correlation (refs only). */
	configNames: string[];
	/** Secret refs accessed on this correlation (never values). */
	secretValueRefs: string[];
	/** Continuous identity migration ids observed on this correlation. */
	migrationIds: string[];
	timeline: CredentialAuditTimelineEntry[];
	grantCount: number;
	useCount: number;
	revokeCount: number;
	/** Count of config.Resolved / secret.Accessed events (audit). */
	configResolveCount: number;
	secretAccessCount: number;
	/** Count of identity.Migration* events folded. */
	migrationEventCount: number;
}

function correlationKey(event: EventEnvelope): string {
	// SAFETY: `const data = event.data as` is required at this I/O or test boundary.
	const data = event.data as
		| { correlationId?: string; grantId?: string }
		| undefined;
	return (
		event.correlationId ??
		data?.correlationId ??
		data?.grantId ??
		event.streamId
	);
}

function base(
	row: CredentialAuditRow | undefined,
	correlationId: string,
): CredentialAuditRow {
	return row
		? {
				...row,
				grants: { ...row.grants },
				identityIds: [...row.identityIds],
				sessionIds: [...row.sessionIds],
				connectionIds: [...(row.connectionIds ?? [])],
				configNames: [...(row.configNames ?? [])],
				secretValueRefs: [...(row.secretValueRefs ?? [])],
				migrationIds: [...(row.migrationIds ?? [])],
				timeline: [...row.timeline],
			}
		: {
				correlationId,
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

function noteConnection(
	row: CredentialAuditRow,
	connectionId: string | undefined,
): void {
	if (!connectionId) return;
	if (!row.connectionIds.includes(connectionId)) {
		row.connectionIds = [...row.connectionIds, connectionId];
	}
}

function noteMigration(
	row: CredentialAuditRow,
	migrationId: string | undefined,
): void {
	if (!migrationId) return;
	if (!row.migrationIds.includes(migrationId)) {
		row.migrationIds = [...row.migrationIds, migrationId];
	}
	row.migrationEventCount = (row.migrationEventCount ?? 0) + 1;
}

function foldMigrationEvent(
	row: CredentialAuditRow | undefined,
	event: EventEnvelope,
): CredentialAuditRow {
	// SAFETY: `const data = event.data as { migrationId?: string };` is required at this I/O or test boundary.
	const data = event.data as { migrationId?: string };
	const next = base(row, correlationKey(event));
	noteMigration(next, data.migrationId);
	next.timeline = [...next.timeline, { seq: event.seq, type: event.type }];
	return next;
}

function grant(row: CredentialAuditRow, grantId: string): CredentialGrantAudit {
	const existing = row.grants[grantId];
	return existing
		? { ...existing }
		: { grantId, status: "granted", useCount: 0 };
}

export const credentialAuditProjection: Projection<CredentialAuditRow> =
	defineProjection<CredentialAuditRow>({
		name: "credential-audit",
		key: correlationKey,
		on: {
			[CREDENTIAL_AUDIT_EVENTS.IdentityIssued]: (row, event) => {
				// SAFETY: `const data = event.data as { identityId: string };` is required at this I/O or test boundary.
				const data = event.data as { identityId: string };
				const next = base(row, correlationKey(event));
				if (!next.identityIds.includes(data.identityId)) {
					next.identityIds = [...next.identityIds, data.identityId];
				}
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.IdentityRotated]: (row, event) => {
				// SAFETY: `const data = event.data as { identityId: string };` is required at this I/O or test boundary.
				const data = event.data as { identityId: string };
				const next = base(row, correlationKey(event));
				if (!next.identityIds.includes(data.identityId)) {
					next.identityIds = [...next.identityIds, data.identityId];
				}
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.MigrationStarted]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.DualLinked]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.ShadowVerified]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.DualConsistencyChecked]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.MigrationProgressed]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.Migrated]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.MigrationCutover]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.MigrationAborted]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.MigrationCompensated]: (row, event) =>
				foldMigrationEvent(row, event),
			[CREDENTIAL_AUDIT_EVENTS.TokenGranted]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					grantId: string;
					svidSubject?: string;
					tokenRef?: string;
					scope?: CredentialAuditScope;
					connectionId?: string;
				};
				const next = base(row, correlationKey(event));
				const g = grant(next, data.grantId);
				g.status = "granted";
				g.grantedAt = event.ts;
				if (data.svidSubject !== undefined) g.svidSubject = data.svidSubject;
				if (data.tokenRef !== undefined) g.tokenRef = data.tokenRef;
				if (data.scope !== undefined) g.scope = data.scope;
				next.grants[data.grantId] = g;
				next.grantCount += 1;
				noteConnection(next, data.connectionId);
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type, grantId: data.grantId },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.ConnectionCreated]: (row, event) => {
				// SAFETY: `const data = event.data as { connectionId: string };` is required at this I/O or test boundary.
				const data = event.data as { connectionId: string };
				const next = base(row, correlationKey(event));
				noteConnection(next, data.connectionId);
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.ConnectionAuthorized]: (row, event) => {
				// SAFETY: `const data = event.data as { connectionId: string };` is required at this I/O or test boundary.
				const data = event.data as { connectionId: string };
				const next = base(row, correlationKey(event));
				noteConnection(next, data.connectionId);
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.ConnectionTokenIssued]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					connectionId: string;
					grantId?: string;
				};
				const next = base(row, correlationKey(event));
				noteConnection(next, data.connectionId);
				next.timeline = [
					...next.timeline,
					{
						seq: event.seq,
						type: event.type,
						...(data.grantId !== undefined ? { grantId: data.grantId } : undefined),
					},
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.ConnectionRevoked]: (row, event) => {
				// SAFETY: `const data = event.data as { connectionId: string };` is required at this I/O or test boundary.
				const data = event.data as { connectionId: string };
				const next = base(row, correlationKey(event));
				noteConnection(next, data.connectionId);
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.ConnectionNeedsReauth]: (row, event) => {
				// SAFETY: `const data = event.data as { connectionId: string };` is required at this I/O or test boundary.
				const data = event.data as { connectionId: string };
				const next = base(row, correlationKey(event));
				noteConnection(next, data.connectionId);
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.TokenUsed]: (row, event) => {
				// SAFETY: `const data = event.data as { grantId: string };` is required at this I/O or test boundary.
				const data = event.data as { grantId: string };
				const next = base(row, correlationKey(event));
				const g = grant(next, data.grantId);
				// A use before a grant is folded as an anomaly-tolerant "used" status;
				// the timeline preserves ordering for the security reviewer either way.
				if (g.status !== "revoked") g.status = "used";
				g.usedAt = event.ts;
				g.useCount += 1;
				next.grants[data.grantId] = g;
				next.useCount += 1;
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type, grantId: data.grantId },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.TokenRevoked]: (row, event) => {
				// SAFETY: `const data = event.data as { grantId: string; reason?: string };` is required at this I/O or test boundary.
				const data = event.data as { grantId: string; reason?: string };
				const next = base(row, correlationKey(event));
				const g = grant(next, data.grantId);
				g.status = "revoked";
				g.revokedAt = event.ts;
				if (data.reason !== undefined) g.revokedReason = data.reason;
				next.grants[data.grantId] = g;
				next.revokeCount += 1;
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type, grantId: data.grantId },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.SessionStarted]: (row, event) => {
				// SAFETY: `const data = event.data as { sessionId: string };` is required at this I/O or test boundary.
				const data = event.data as { sessionId: string };
				const next = base(row, correlationKey(event));
				if (!next.sessionIds.includes(data.sessionId)) {
					next.sessionIds = [...next.sessionIds, data.sessionId];
				}
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.SessionRevoked]: (row, event) => {
				// SAFETY: `const data = event.data as { sessionId: string };` is required at this I/O or test boundary.
				const data = event.data as { sessionId: string };
				const next = base(row, correlationKey(event));
				if (!next.sessionIds.includes(data.sessionId)) {
					next.sessionIds = [...next.sessionIds, data.sessionId];
				}
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.ConfigResolved]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					name?: string;
					valueRef?: string;
					source?: string;
					redacted?: boolean;
				};
				const next = base(row, correlationKey(event));
				if (data.name && !next.configNames.includes(data.name)) {
					next.configNames = [...next.configNames, data.name];
				}
				next.configResolveCount += 1;
				next.timeline = [
					...next.timeline,
					{ seq: event.seq, type: event.type },
				];
				return next;
			},
			[CREDENTIAL_AUDIT_EVENTS.SecretAccessed]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					name?: string;
					valueRef?: string;
					versionId?: string;
					grantId?: string;
					plaintextPresent?: boolean;
				};
				// Fail closed in fold if an event claims plaintext (conformance).
				if (data.plaintextPresent === true) {
					throw new Error(
						"CredentialAudit: secret.Accessed claimed plaintextPresent",
					);
				}
				const next = base(row, correlationKey(event));
				if (data.valueRef && !next.secretValueRefs.includes(data.valueRef)) {
					next.secretValueRefs = [...next.secretValueRefs, data.valueRef];
				}
				next.secretAccessCount += 1;
				next.timeline = [
					...next.timeline,
					{
						seq: event.seq,
						type: event.type,
						...(data.grantId !== undefined ? { grantId: data.grantId } : undefined),
					},
				];
				return next;
			},
		},
	});

export interface CompactionResult {
	retained: EventEnvelope[];
	droppedCount: number;
	// True when no credential-audit event was removed (NFR-018 never-compact).
	auditPreserved: boolean;
}

/**
 * A compaction pass over a stream that respects the never-compact retention floor
 * (NFR-018). Credential-audit events (identity/token/session families) are never
 * dropped; only non-audit events older than the retention floor are compactable.
 * A test can therefore prove pre-floor audit events survive a compaction pass.
 */
export function compactCredentialAuditStream(
	events: readonly EventEnvelope[],
	options: { now?: number; retentionFloorMs?: number } = {},
): CompactionResult {
	const now = options.now ?? Date.now();
	const floorMs =
		options.retentionFloorMs ?? CREDENTIAL_AUDIT_RETENTION_FLOOR_MS;
	const auditTotal = events.filter(isCredentialAuditEvent).length;

	const retained = events.filter((event) => {
		if (isCredentialAuditEvent(event)) return true; // never compacted
		return now - Date.parse(event.ts) <= floorMs;
	});

	const auditRetained = retained.filter(isCredentialAuditEvent).length;
	return {
		retained,
		droppedCount: events.length - retained.length,
		auditPreserved: auditRetained === auditTotal,
	};
}
