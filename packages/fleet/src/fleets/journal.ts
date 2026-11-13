/**
 * The fleet streams of §7.5 and their fold (L32, private to the lane).
 *
 * Stream `fleet-fleet-<FleetId>` holds `fleet.FleetDefined` (revision 1) and
 * `fleet.FleetPolicyChanged` (every later revision). Every event's `data`
 * carries (D57; this shape is frozen from the first writer, which is this
 * lane):
 *
 * - `subject`: the registry key the event changes, `fleet.<FleetId>`;
 * - `subjectSequence` and `revision`: the fleet record's `revision` after the
 *   event (the `AuditEntry.subject_sequence` it produced);
 * - `record`: the protobuf JSON of the whole `FleetRecord` after the event,
 *   without `issued_at` and `not_after` (the signer adds those), so a
 *   projection replays the registry by taking the last `record` of each stream.
 */
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import type {
	EventEnvelope,
	EventInput,
	EventPosition,
	JsonObject,
} from "@hobo/core";
import { type FleetRecord, FleetRecordSchema } from "../_generated/fleet_pb.js";
import type { FleetEventType } from "../events.js";
import { type FleetId, parseFleetId } from "../ids.js";
import { type FleetDeps, isJsonObject, pbJson } from "./support.js";

const FLEET_STREAM = "fleet-fleet-";

export function fleetStream(id: FleetId): string {
	return `${FLEET_STREAM}${id}`;
}

export function fleetSubject(id: FleetId): string {
	return `fleet.${id}`;
}

/** The record as it is journalled: no signing-time fields. */
export function journalled(record: FleetRecord): FleetRecord {
	return create(FleetRecordSchema, { ...record, issuedAt: "", notAfter: "" });
}

/** A fleet event: the record after it, which already carries its new revision. */
export function fleetEvent(
	type: Extract<
		FleetEventType,
		"fleet.FleetDefined" | "fleet.FleetPolicyChanged"
	>,
	record: FleetRecord,
): EventInput<JsonObject> {
	const id = parseFleetId(record.fleetId, "fleet_id");
	return {
		type,
		data: {
			subject: fleetSubject(id),
			subjectSequence: record.revision,
			revision: record.revision,
			record: pbJson(toJson(FleetRecordSchema, journalled(record))),
		},
	};
}

export type FleetState = Readonly<{ seq: number; record: FleetRecord }>;

/** Every fleet of the tenant, folded from the journal; rebuilt by replay. */
export type FleetIndex = ReadonlyMap<FleetId, FleetState>;

/** Applies one journal event; deterministic, so replay gives live state. */
function applyEvent(
	index: Map<FleetId, FleetState>,
	event: EventEnvelope,
): void {
	if (!event.streamId.startsWith(FLEET_STREAM)) return;
	if (
		event.type !== "fleet.FleetDefined" &&
		event.type !== "fleet.FleetPolicyChanged"
	)
		return;
	let id: FleetId;
	try {
		id = parseFleetId(event.streamId.slice(FLEET_STREAM.length));
	} catch {
		return;
	}
	const value = isJsonObject(event.data) ? event.data.record : undefined;
	if (!isJsonObject(value)) return;
	index.set(id, {
		seq: event.seq,
		record: fromJson(FleetRecordSchema, value, { ignoreUnknownFields: true }),
	});
}

/** A reader of the fleet streams that remembers where it got to. */
export type FleetJournal = Readonly<{ catchUp(): Promise<FleetIndex> }>;

export function createFleetJournal(
	deps: Pick<FleetDeps, "store">,
): FleetJournal {
	const index = new Map<FleetId, FleetState>();
	let position: EventPosition | undefined;
	let reading: Promise<FleetIndex> | undefined;
	const once = async (): Promise<FleetIndex> => {
		const options = position === undefined ? {} : { after: position };
		for await (const positioned of deps.store.readAll(options)) {
			applyEvent(index, positioned.event);
			position = positioned.position;
		}
		return index;
	};
	return {
		catchUp() {
			// One reader at a time; a caller arriving mid-read waits for it and reads again.
			const run = (reading ?? Promise.resolve(index)).then(once);
			reading = run.catch(() => index);
			return run;
		},
	};
}
