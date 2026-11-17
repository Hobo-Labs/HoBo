import {
	create,
	fromBinary,
	fromJson,
	type JsonValue,
	toBinary,
	toJson,
} from "@bufbuild/protobuf";
import {
	CredentialAuditRecordSchema,
	type CredentialGrantAudit as WireGrant,
	type CredentialAuditTimelineEntry as WireTimelineEntry,
} from "../_generated/cloud_pb.js";
import type {
	CredentialAuditRow,
	CredentialAuditTimelineEntry,
	CredentialGrantAudit,
} from "./credential-audit.js";

function uint32(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff)
		throw new TypeError(
			`CredentialAudit: ${field} must be an unsigned 32-bit integer`,
		);
	return value;
}

export function encodeCredentialAuditRow(row: CredentialAuditRow): Uint8Array {
	if (!row.correlationId)
		throw new TypeError("CredentialAudit: correlationId is required");
	if (row.tenant === "")
		throw new TypeError("CredentialAudit: tenant must not be empty");
	const grants = Object.entries(row.grants).map(([id, grant]) => {
		if (!id || id !== grant.grantId)
			throw new TypeError("CredentialAudit: grant id does not match its key");
		if (
			grant.status !== "granted" &&
			grant.status !== "used" &&
			grant.status !== "revoked"
		)
			throw new TypeError("CredentialAudit: invalid grant status");
		for (const key of [
			"svidSubject",
			"tokenRef",
			"grantedAt",
			"usedAt",
			"revokedAt",
			"revokedReason",
		] as const)
			if (grant[key] === "")
				throw new TypeError(`CredentialAudit: grant.${key} must not be empty`);
		if (
			grant.scope &&
			(!grant.scope.port || !grant.scope.resource || !grant.scope.action)
		)
			throw new TypeError("CredentialAudit: invalid scope");
		uint32(grant.useCount, "grant.useCount");
		return grant;
	});
	for (const entry of row.timeline) {
		uint32(entry.seq, "timeline.seq");
		if (!entry.type)
			throw new TypeError("CredentialAudit: timeline type is required");
		for (const key of [
			"grantId",
			"eventId",
			"streamId",
			"time",
			"actorKind",
			"actorId",
			"tool",
			"subject",
			"reason",
			"name",
			"ref",
			"code",
			"ticketId",
			"target",
			"channel",
		] as const)
			if (entry[key] === "")
				throw new TypeError(
					`CredentialAudit: timeline.${key} must not be empty`,
				);
		if (
			entry.effect !== undefined &&
			entry.effect !== "allow" &&
			entry.effect !== "deny"
		)
			throw new TypeError("CredentialAudit: invalid effect");
	}
	return toBinary(
		CredentialAuditRecordSchema,
		create(CredentialAuditRecordSchema, {
			correlationId: row.correlationId,
			tenant: row.tenant ?? "",
			grants,
			identityIds: row.identityIds,
			sessionIds: row.sessionIds,
			connectionIds: row.connectionIds,
			configNames: row.configNames,
			secretValueRefs: row.secretValueRefs,
			migrationIds: row.migrationIds,
			timeline: row.timeline,
			grantCount: uint32(row.grantCount, "grantCount"),
			useCount: uint32(row.useCount, "useCount"),
			revokeCount: uint32(row.revokeCount, "revokeCount"),
			configResolveCount: uint32(row.configResolveCount, "configResolveCount"),
			secretAccessCount: uint32(row.secretAccessCount, "secretAccessCount"),
			migrationEventCount: uint32(
				row.migrationEventCount,
				"migrationEventCount",
			),
		}),
	);
}

function decodeGrant(wire: WireGrant): CredentialGrantAudit {
	if (
		!wire.grantId ||
		(wire.status !== "granted" &&
			wire.status !== "used" &&
			wire.status !== "revoked")
	)
		throw new TypeError("CredentialAudit: invalid grant");
	const grant: CredentialGrantAudit = {
		grantId: wire.grantId,
		status: wire.status,
		useCount: wire.useCount,
	};
	if (wire.svidSubject) grant.svidSubject = wire.svidSubject;
	if (wire.tokenRef) grant.tokenRef = wire.tokenRef;
	if (wire.grantedAt) grant.grantedAt = wire.grantedAt;
	if (wire.usedAt) grant.usedAt = wire.usedAt;
	if (wire.revokedAt) grant.revokedAt = wire.revokedAt;
	if (wire.revokedReason) grant.revokedReason = wire.revokedReason;
	if (wire.scope) {
		if (!wire.scope.port || !wire.scope.resource || !wire.scope.action)
			throw new TypeError("CredentialAudit: invalid scope");
		grant.scope = {
			port: wire.scope.port,
			resource: wire.scope.resource,
			action: wire.scope.action,
		};
	}
	return grant;
}

function decodeTimeline(wire: WireTimelineEntry): CredentialAuditTimelineEntry {
	if (!wire.type)
		throw new TypeError("CredentialAudit: timeline type is required");
	const entry: CredentialAuditTimelineEntry = {
		seq: wire.seq,
		type: wire.type,
	};
	for (const key of [
		"grantId",
		"eventId",
		"streamId",
		"time",
		"actorKind",
		"actorId",
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
		if (wire[key]) entry[key] = wire[key];
	}
	if (wire.effect) {
		if (wire.effect !== "allow" && wire.effect !== "deny")
			throw new TypeError("CredentialAudit: invalid effect");
		entry.effect = wire.effect;
	}
	return entry;
}

export function decodeCredentialAuditRow(
	bytes: Uint8Array,
): CredentialAuditRow {
	const wire = fromBinary(CredentialAuditRecordSchema, bytes);
	if (!wire.correlationId)
		throw new TypeError("CredentialAudit: correlationId is required");
	const grants: CredentialAuditRow["grants"] = {};
	for (const value of wire.grants) {
		const grant = decodeGrant(value);
		if (Object.hasOwn(grants, grant.grantId))
			throw new TypeError("CredentialAudit: duplicate grant id");
		Object.defineProperty(grants, grant.grantId, {
			value: grant,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	const row: CredentialAuditRow = {
		correlationId: wire.correlationId,
		grants,
		identityIds: [...wire.identityIds],
		sessionIds: [...wire.sessionIds],
		connectionIds: [...wire.connectionIds],
		configNames: [...wire.configNames],
		secretValueRefs: [...wire.secretValueRefs],
		migrationIds: [...wire.migrationIds],
		timeline: wire.timeline.map(decodeTimeline),
		grantCount: wire.grantCount,
		useCount: wire.useCount,
		revokeCount: wire.revokeCount,
		configResolveCount: wire.configResolveCount,
		secretAccessCount: wire.secretAccessCount,
		migrationEventCount: wire.migrationEventCount,
	};
	if (wire.tenant) row.tenant = wire.tenant;
	return row;
}

export function credentialAuditRowToJson(row: CredentialAuditRow): JsonValue {
	return toJson(
		CredentialAuditRecordSchema,
		fromBinary(CredentialAuditRecordSchema, encodeCredentialAuditRow(row)),
	);
}

export function credentialAuditRowFromJson(
	value: JsonValue,
): CredentialAuditRow {
	return decodeCredentialAuditRow(
		toBinary(
			CredentialAuditRecordSchema,
			fromJson(CredentialAuditRecordSchema, value),
		),
	);
}
