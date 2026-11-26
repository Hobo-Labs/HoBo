import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "./json.js";
import { STATION_SCHEMA_VERSION } from "./types.js";

// public-contract: wire schema / event catalog constant.
export const STATION_EVENT_SCHEMA = "hobo.station-events/v1" as const;

// public-contract: never-compact security-audit retention for station identity / rail activation.
export const STATION_AUDIT_RETENTION = Object.freeze({
	class: "security-audit",
	neverCompact: true,
	streamPolicy: "retain-station-rail-connection-audit",
});

export const STATION_EVENTS = Object.freeze({
	Created: "station.Created",
	Configured: "station.Configured",
	Closed: "station.Closed",
	IdentityRotated: "station.IdentityRotated",
	RailPublished: "rail.Published",
	RailApproved: "rail.Approved",
	RailActivated: "rail.Activated",
	RailDeactivated: "rail.Deactivated",
	RailRetired: "rail.Retired",
} as const);

export type StationEventType =
	(typeof STATION_EVENTS)[keyof typeof STATION_EVENTS];

const STATION_EVENT_TYPES = new Set<string>(Object.values(STATION_EVENTS));

function isStationEventType(value: string): value is StationEventType {
	return STATION_EVENT_TYPES.has(value);
}

export function parseStationEvent<T>(input: T): StationEvent {
	const value = isJsonString(input)
		? parseJsonValue(input)
		: cloneAsJson(input);
	if (!isJsonObject(value)) {
		throw new Error("station event must be an object");
	}
	if (
		!isJsonString(value.id) ||
		!isJsonString(value.type) ||
		!isStationEventType(value.type) ||
		!isJsonString(value.stationId) ||
		!isJsonNumber(value.seq) ||
		!isJsonString(value.time)
	) {
		throw new Error("station event is missing required identity fields");
	}
	const data = isJsonObject(value.data) ? value.data : {};
	return Object.freeze({
		id: value.id,
		type: value.type,
		schemaVersion: STATION_EVENT_SCHEMA,
		stationId: value.stationId,
		seq: value.seq,
		time: value.time,
		retention: STATION_AUDIT_RETENTION,
		data,
	});
}

export type StationEvent = Readonly<{
	id: string;
	type: StationEventType;
	schemaVersion: typeof STATION_EVENT_SCHEMA;
	stationId: string;
	seq: number;
	time: string;
	retention: typeof STATION_AUDIT_RETENTION;
	data: JsonObject;
}>;

export function stationEvent(
	type: StationEventType,
	stationId: string,
	seq: number,
	data: JsonObject,
	time?: string,
): StationEvent {
	return Object.freeze({
		id: `evt-${type}-${stationId}-${seq}`,
		type,
		schemaVersion: STATION_EVENT_SCHEMA,
		stationId,
		seq,
		time: time ?? new Date().toISOString(),
		retention: STATION_AUDIT_RETENTION,
		data: Object.freeze({ ...data, stationSchema: STATION_SCHEMA_VERSION }),
	});
}
