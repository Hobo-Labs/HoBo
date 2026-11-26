/**
 * Continuous identity migration event family (never-compact credential audit).
 * ADR continuous identity migration plane.
 */

import { CREDENTIAL_AUDIT_RETENTION } from "./events.js";
import { asJsonObject, type JsonObject } from "./json.js";

// public-contract: identity migration event schema version.
export const IDENTITY_MIGRATION_EVENT_SCHEMA =
	"hobo.identity-migration-events/v1" as const;

export const IDENTITY_MIGRATION_EVENTS = Object.freeze({
	MigrationStarted: "identity.MigrationStarted",
	DualLinked: "identity.DualLinked",
	ShadowVerified: "identity.ShadowVerified",
	DualConsistencyChecked: "identity.DualConsistencyChecked",
	MigrationProgressed: "identity.MigrationProgressed",
	Migrated: "identity.Migrated",
	MigrationCutover: "identity.MigrationCutover",
	MigrationAborted: "identity.MigrationAborted",
	MigrationCompensated: "identity.MigrationCompensated",
} as const);

export type IdentityMigrationEventType =
	(typeof IDENTITY_MIGRATION_EVENTS)[keyof typeof IDENTITY_MIGRATION_EVENTS];

export type IdentityMigrationEvent = Readonly<{
	id: string;
	type: IdentityMigrationEventType;
	schemaVersion: typeof IDENTITY_MIGRATION_EVENT_SCHEMA;
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
	type: IdentityMigrationEventType,
	input: {
		tenant: string;
		migrationId: string;
		seq?: number;
		time?: string;
		causationId?: string;
		data: T;
	},
): IdentityMigrationEvent {
	const seq = input.seq ?? 0;
	return Object.freeze({
		id: `evt-${type}-${input.migrationId}-${seq}`,
		type,
		schemaVersion: IDENTITY_MIGRATION_EVENT_SCHEMA,
		tenant: input.tenant,
		seq,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/identity-migration" },
		correlationId: `corr-migration-${input.migrationId}`,
		causationId: input.causationId ?? `cmd-migration-${input.migrationId}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: asJsonObject({
			migrationId: input.migrationId,
			...input.data,
		}),
	});
}

export function createMigrationStartedEvent(input: {
	migrationId: string;
	tenant: string;
	sourceAdapter: string;
	targetAdapter: string;
	reason:
		| "adapter-change"
		| "residency"
		| "spectrum"
		| "policy"
		| "schema"
		| "yard-move";
	mappingSpecHash: string;
	matchDecisionId?: string;
	mode: "jit" | "shadow" | "background";
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.MigrationStarted, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: {
			sourceAdapter: input.sourceAdapter,
			targetAdapter: input.targetAdapter,
			reason: input.reason,
			mappingSpecHash: input.mappingSpecHash,
			mode: input.mode,
			...(input.matchDecisionId !== undefined
				? { matchDecisionId: input.matchDecisionId }
				: undefined),
		},
	});
}

export function createDualLinkedEvent(input: {
	migrationId: string;
	tenant: string;
	principalRef: string;
	sourceSubject: string;
	targetSubject: string;
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.DualLinked, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: {
			principalRef: input.principalRef,
			// Subjects are opaque refs only — never raw secrets.
			sourceSubjectRef: input.sourceSubject,
			targetSubjectRef: input.targetSubject,
		},
	});
}

export function createShadowVerifiedEvent(input: {
	migrationId: string;
	tenant: string;
	principalRef: string;
	ok: boolean;
	divergedClaims?: readonly string[];
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.ShadowVerified, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: asJsonObject({
			principalRef: input.principalRef,
			ok: input.ok,
			...(input.divergedClaims !== undefined
				? { divergedClaims: [...input.divergedClaims] }
				: undefined),
		}),
	});
}

export function createDualConsistencyCheckedEvent(input: {
	migrationId: string;
	tenant: string;
	ok: boolean;
	checked: number;
	failed: number;
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.DualConsistencyChecked, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: {
			ok: input.ok,
			checked: input.checked,
			failed: input.failed,
		},
	});
}

export function createMigrationProgressedEvent(input: {
	migrationId: string;
	tenant: string;
	rampPercent: number;
	linkedPrincipals: number;
	cohortFlagId?: string;
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.MigrationProgressed, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: {
			rampPercent: input.rampPercent,
			linkedPrincipals: input.linkedPrincipals,
			...(input.cohortFlagId !== undefined
				? { cohortFlagId: input.cohortFlagId }
				: undefined),
		},
	});
}

export function createMigratedEvent(input: {
	migrationId: string;
	tenant: string;
	principalRef: string;
	targetAdapter: string;
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.Migrated, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: {
			principalRef: input.principalRef,
			targetAdapter: input.targetAdapter,
		},
	});
}

export function createMigrationCutoverEvent(input: {
	migrationId: string;
	tenant: string;
	linkedPrincipals: number;
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.MigrationCutover, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: { linkedPrincipals: input.linkedPrincipals },
	});
}

export function createMigrationAbortedEvent(input: {
	migrationId: string;
	tenant: string;
	reason: string;
	code: string;
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.MigrationAborted, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: { reason: input.reason, code: input.code },
	});
}

export function createMigrationCompensatedEvent(input: {
	migrationId: string;
	tenant: string;
	reason: string;
	restoredAdapter: string;
	seq?: number;
	time?: string;
}): IdentityMigrationEvent {
	return baseEvent(IDENTITY_MIGRATION_EVENTS.MigrationCompensated, {
		tenant: input.tenant,
		migrationId: input.migrationId,
		seq: input.seq,
		time: input.time,
		data: {
			reason: input.reason,
			restoredAdapter: input.restoredAdapter,
		},
	});
}

export function validateIdentityMigrationEvent(
	event: IdentityMigrationEvent,
): void {
	if (event.schemaVersion !== IDENTITY_MIGRATION_EVENT_SCHEMA) {
		throw new Error("identity migration event schema version mismatch");
	}
	if (event.retention.neverCompact !== true) {
		throw new Error(
			"identity migration event must carry never-compact credential-audit retention",
		);
	}
	if (event.data.migrationId === undefined) {
		throw new Error(`${event.type} missing migrationId`);
	}
}

export function isIdentityMigrationEventType(type: string): boolean {
	// SAFETY: assertion to `ject.values(IDENTITY_MIGRATION_EVENTS) as string[]).` is required at this boundary.
	return (Object.values(IDENTITY_MIGRATION_EVENTS) as string[]).includes(type);
}
