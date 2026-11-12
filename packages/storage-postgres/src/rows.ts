import {
	type EventEnvelope,
	EventStoreError,
	type JsonObject,
	type JsonValue,
	parseEventEnvelope,
} from "@hobo/core";
import { isJsonObject } from "./parse.js";
import { optionalText, type PgRow, int4, text } from "./pg.js";

export const JSON_CODEC = "json-v1";

/** Columns every event read selects, in this order. */
export const EVENT_COLUMNS = `global_position, stream_id, seq, id, type, v, ts, actor, tenant,
  project, causation_id, correlation_id, lane, payload_codec, data, metadata_codec, meta`;

export function decodeJsonColumn(
	row: PgRow,
	column: string,
	codecColumn: string | undefined,
): JsonValue {
	if (codecColumn !== undefined) {
		const codec = text(row, codecColumn);
		if (codec !== JSON_CODEC) {
			throw new EventStoreError(
				"UNSUPPORTED_CODEC",
				`unsupported codec "${codec}" for ${column}`,
			);
		}
	}
	try {
		// SAFETY: the column holds JSON text this store wrote; a parse failure is reported below.
		return JSON.parse(text(row, column)) as JsonValue;
	} catch {
		throw new EventStoreError(
			"INTEGRITY_FAILURE",
			`column ${column} does not hold valid JSON`,
		);
	}
}

/** Decode one `events` row into a parsed, frozen-safe envelope. */
export function rowToEnvelope(row: PgRow): EventEnvelope {
	const metaValue = decodeJsonColumn(row, "meta", "metadata_codec");
	const meta: JsonObject = isJsonObject(metaValue) ? metaValue : {};
	return parseEventEnvelope({
		id: text(row, "id"),
		type: text(row, "type"),
		v: int4(row, "v"),
		streamId: text(row, "stream_id"),
		seq: int4(row, "seq"),
		ts: text(row, "ts"),
		actor: decodeJsonColumn(row, "actor", undefined),
		tenant: text(row, "tenant"),
		project: optionalText(row, "project"),
		causationId: optionalText(row, "causation_id"),
		correlationId: optionalText(row, "correlation_id"),
		lane: optionalText(row, "lane"),
		data: decodeJsonColumn(row, "data", "payload_codec"),
		meta,
	});
}
