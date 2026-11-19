import type { DataClassification } from "@hobo/core";
import type { CanonicalRecord, DatasetSchema } from "./canonical.js";
import { parseCanonicalRecord } from "./canonical.js";
import { DataCoreError } from "./errors.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: the schema id a change envelope is published under.
export const CHANGE_ENVELOPE_CONTRACT = "hobo.change-envelope/v1";

export const CHANGE_OPS = ["upsert", "delete"] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export type Position = string;

// domain-view: parsed mutation; wire form is RecordMutation in data-models/data_core.proto.
export interface RecordMutation {
	readonly tenant: string;
	readonly key: string;
	readonly op: ChangeOp;
	readonly record?: CanonicalRecord;
}

// domain-view: parsed envelope, constructible through parseChangeEnvelope or an engine's capture port; wire form is ChangeEnvelope in data-models/data_core.proto.
export interface ChangeEnvelope extends RecordMutation {
	readonly contract: typeof CHANGE_ENVELOPE_CONTRACT;
	readonly dataset: string;
	readonly position: Position;
	readonly schemaVersion: number;
	readonly classification?: DataClassification;
}

function invalid(message: string, field: string): never {
	throw new DataCoreError("INVALID_ENVELOPE", message, { detail: { field } });
}

function isChangeOp(value: string): value is ChangeOp {
	return (CHANGE_OPS as readonly string[]).includes(value);
}

export function upsertMutation(
	tenant: string,
	key: string,
	record: CanonicalRecord,
): RecordMutation {
	return Object.freeze({ tenant, key, op: "upsert", record });
}

export function deleteMutation(tenant: string, key: string): RecordMutation {
	return Object.freeze({ tenant, key, op: "delete" });
}

export function envelopeOf(
	schema: DatasetSchema,
	mutation: RecordMutation,
	position: Position,
): ChangeEnvelope {
	return Object.freeze({
		contract: CHANGE_ENVELOPE_CONTRACT,
		dataset: schema.name,
		position,
		schemaVersion: schema.version,
		tenant: mutation.tenant,
		key: mutation.key,
		op: mutation.op,
		...(mutation.record === undefined
			? undefined
			: { record: mutation.record }),
	});
}

export function parseChangeEnvelope(
	schema: DatasetSchema,
	value: JsonValue | undefined,
): ChangeEnvelope {
	if (!isJsonObject(value)) invalid("envelope must be an object", "envelope");
	if (value.dataset !== schema.name) {
		invalid(
			`envelope is for a different dataset than ${schema.name}`,
			"dataset",
		);
	}
	const { position, key, op, tenant, schemaVersion } = value;
	if (!isJsonString(position) || position === "") {
		invalid("position must be a non-empty string", "position");
	}
	if (!isJsonString(key) || key === "") {
		invalid("key must be a non-empty string", "key");
	}
	if (!isJsonString(op) || !isChangeOp(op)) {
		invalid("op must be upsert or delete", "op");
	}
	if (!isJsonString(tenant)) invalid("tenant must be a string", "tenant");
	if (!isJsonNumber(schemaVersion) || !Number.isInteger(schemaVersion)) {
		invalid("schemaVersion must be an integer", "schemaVersion");
	}
	if (op === "upsert" && value.record === undefined) {
		invalid("an upsert carries a record", "record");
	}
	if (op === "delete" && value.record !== undefined) {
		invalid("a delete carries no record", "record");
	}
	return Object.freeze({
		contract: CHANGE_ENVELOPE_CONTRACT,
		dataset: schema.name,
		position,
		schemaVersion,
		tenant,
		key,
		op,
		...(op === "upsert"
			? { record: parseCanonicalRecord(schema, value.record) }
			: undefined),
	});
}

export function envelopeToJson(envelope: ChangeEnvelope): JsonObject {
	return {
		contract: envelope.contract,
		dataset: envelope.dataset,
		position: envelope.position,
		schemaVersion: envelope.schemaVersion,
		tenant: envelope.tenant,
		key: envelope.key,
		op: envelope.op,
		...(envelope.record === undefined
			? undefined
			: { record: envelope.record }),
	};
}
