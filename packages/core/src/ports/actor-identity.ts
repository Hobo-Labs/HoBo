/**
 * Logical durable-actor identity. Resolver-neutral: Rivet compound keys,
 * native lease keys, and Trail export records all parse through here.
 */

import { createHash } from "node:crypto";
import { CoreParseError } from "../errors.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

// public-contract: compound-key prefix every actor resolver must share.
export const ACTOR_IDENTITY_PREFIX = "hobo";
export const MAX_ACTOR_KEY_SEGMENTS = 8;
export const MAX_ACTOR_KEY_SEGMENT_BYTES = 128;
export const MAX_ACTOR_TYPE_BYTES = 64;

export type LogicalTenantId = string & { readonly __brand: "LogicalTenantId" };
export type ActorTypeId = string & { readonly __brand: "ActorTypeId" };
export type ActorKeySegment = string & { readonly __brand: "ActorKeySegment" };
export type CommandDigest = string & { readonly __brand: "CommandDigest" };

export interface LogicalActorIdentity {
	readonly tenantId: LogicalTenantId;
	readonly projectId: string;
	readonly actorTypeId: ActorTypeId;
	readonly keySegments: readonly ActorKeySegment[];
	readonly schemaVersion: number;
	readonly lane?: string;
}

export interface ActorCommandDigestInput {
	readonly identity: LogicalActorIdentity;
	readonly commandType: string;
	readonly commandId: string;
	readonly payload: JsonValue;
	readonly expectedRevision: number;
	readonly policyEpoch?: string;
}

export class ActorIdentityParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_ACTOR_IDENTITY_PARSE", path, expected, received, message);
		this.name = "ActorIdentityParseError";
	}
}

const IDENT = /^[A-Za-z0-9._:-]+$/u;

function parseBoundedIdent(
	value: JsonValue | undefined,
	path: string,
	maxBytes: number,
): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new ActorIdentityParseError(path, "non-empty ident", value);
	}
	const normalized = value.normalize("NFC");
	if (normalized !== value) {
		throw new ActorIdentityParseError(
			path,
			"NFC-normalized ident",
			value,
			"unicode must be NFC before crossing the actor-identity boundary",
		);
	}
	if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
		throw new ActorIdentityParseError(path, `ident ≤ ${maxBytes} bytes`, value);
	}
	if (!IDENT.test(normalized)) {
		throw new ActorIdentityParseError(path, "ident [A-Za-z0-9._:-]", value);
	}
	if (normalized.includes("..") || normalized.includes("//")) {
		throw new ActorIdentityParseError(
			path,
			"ident without path traversal",
			value,
		);
	}
	return normalized;
}

export function parseLogicalActorIdentity(
	input: JsonValue | undefined,
): LogicalActorIdentity {
	if (!isJsonObject(input) || input === null || Array.isArray(input)) {
		throw new ActorIdentityParseError("identity", "object", input);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const record = input as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const tenantId = parseBoundedIdent(
		record.tenantId ?? record.tenant_id,
		"tenantId",
		MAX_ACTOR_TYPE_BYTES,
	) as LogicalTenantId;
	const projectId = parseBoundedIdent(
		record.projectId ?? record.project_id ?? "default",
		"projectId",
		MAX_ACTOR_TYPE_BYTES,
	);
	// SAFETY: assertion required at this I/O or test boundary.
	const actorTypeId = parseBoundedIdent(
		record.actorTypeId ?? record.actor_type_id,
		"actorTypeId",
		MAX_ACTOR_TYPE_BYTES,
	) as ActorTypeId;
	const rawSegments = record.keySegments ?? record.key_segments;
	if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
		throw new ActorIdentityParseError(
			"keySegments",
			"non-empty string array",
			rawSegments,
		);
	}
	if (rawSegments.length > MAX_ACTOR_KEY_SEGMENTS) {
		throw new ActorIdentityParseError(
			"keySegments",
			`1..${MAX_ACTOR_KEY_SEGMENTS} segments`,
			rawSegments,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const keySegments = rawSegments.map((segment, index) =>
		parseBoundedIdent(
			segment,
			`keySegments.${index}`,
			MAX_ACTOR_KEY_SEGMENT_BYTES,
		),
	) as ActorKeySegment[];
	const schemaVersionRaw = record.schemaVersion ?? record.schema_version ?? 1;
	if (
		!isJsonNumber(schemaVersionRaw) ||
		!Number.isSafeInteger(schemaVersionRaw) ||
		schemaVersionRaw < 1
	) {
		throw new ActorIdentityParseError(
			"schemaVersion",
			"positive integer",
			schemaVersionRaw,
		);
	}
	const laneRaw = record.lane;
	const lane =
		laneRaw === undefined
			? undefined
			: parseBoundedIdent(laneRaw, "lane", MAX_ACTOR_TYPE_BYTES);

	return Object.freeze({
		tenantId,
		projectId,
		actorTypeId,
		keySegments: Object.freeze(keySegments),
		schemaVersion: schemaVersionRaw,
		...(lane !== undefined ? { lane } : undefined),
	});
}

/**
 * Rivet-facing compound array key. Never delimiter-concatenated.
 * Tenant/project are server-bound; callers must not treat the array as authz.
 */
export function actorCompoundKey(
	identity: LogicalActorIdentity,
): readonly string[] {
	return Object.freeze([
		ACTOR_IDENTITY_PREFIX,
		identity.tenantId,
		identity.projectId,
		identity.actorTypeId,
		...identity.keySegments,
	]);
}

export function parseActorCompoundKey(
	value: JsonValue | undefined,
): LogicalActorIdentity {
	if (!Array.isArray(value) || value.length < 5) {
		throw new ActorIdentityParseError(
			"compoundKey",
			`[hobo, tenant, project, type, ...key]`,
			value,
		);
	}
	const [prefix, tenantId, projectId, actorTypeId, ...keySegments] = value;
	if (prefix !== ACTOR_IDENTITY_PREFIX) {
		throw new ActorIdentityParseError(
			"compoundKey.0",
			ACTOR_IDENTITY_PREFIX,
			prefix,
		);
	}
	return parseLogicalActorIdentity(
		cloneAsJson({
			tenantId,
			projectId,
			actorTypeId,
			keySegments,
		}),
	);
}

function canonicalJson(value: JsonValue | undefined): string {
	if (value === null || !isJsonObject(value)) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const record = value as JsonObject;
	const keys = Object.keys(record).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export function actorCommandDigest(
	input: ActorCommandDigestInput,
): CommandDigest {
	const commandType = parseBoundedIdent(input.commandType, "commandType", 128);
	const commandId = parseBoundedIdent(input.commandId, "commandId", 128);
	if (
		!isJsonNumber(input.expectedRevision) ||
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 0
	) {
		throw new ActorIdentityParseError(
			"expectedRevision",
			"non-negative integer",
			input.expectedRevision,
		);
	}
	const material = canonicalJson(
		cloneAsJson({
			identity: {
				tenantId: input.identity.tenantId,
				projectId: input.identity.projectId,
				actorTypeId: input.identity.actorTypeId,
				keySegments: input.identity.keySegments,
				schemaVersion: input.identity.schemaVersion,
				lane: input.identity.lane ?? "",
			},
			commandType,
			commandId,
			payload: input.payload,
			expectedRevision: input.expectedRevision,
			policyEpoch: input.policyEpoch ?? "",
		}),
	);
	// SAFETY: assertion required at this I/O or test boundary.
	return createHash("sha256").update(material).digest("hex") as CommandDigest;
}
