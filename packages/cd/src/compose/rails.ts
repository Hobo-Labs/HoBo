// Rail readers composed from the journal (WP18, plan 0024, D20/D24).
//
// - `createJournalRailCatalog` folds the Station Rail events (`rail.*`) into
//   the Rails known per content digest and the active Rail per Station.
// - `createJournalRailEventReader` is the frozen `RailEventReader` the
//   HOBO_RAIL subscription driver reads: approved / active / retired facts,
//   forward from a position cursor.
// - `createRailDeliveryReader` parses a Rail's opaque `delivery` object as
//   `RailDeliveryRecord` (parse, don't validate) and resolves a Camp's
//   governing Rail: its enforced binding, else its Station's active Rail.
//
// An unparsable `delivery` object binds nothing (no Camp sets, so Placement
// sees no candidates): the conservative reading. It is reported through
// telemetry with code `rail-delivery-invalid`, never silently.
import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import type { DurableEventStore, EventPosition, JsonObject } from "@hobo/core";
import {
	type RailDeliveryRecord,
	RailDeliveryRecordSchema,
} from "../_generated/cd_pb.js";
import type {
	CampId,
	CampPolicy,
	Digest,
	Outcome,
	RailDeliveryReader,
	RailEventReader,
	TelemetrySink,
	TopologyReader,
} from "../ports.js";
import { composeRefusal } from "./errors.js";

// public-contract: the Station Rail event types the readers fold (mirrors
// STATION_EVENTS in @hobo/stations; strings, so the journal is the contract).
export const RAIL_EVENT_TYPES = Object.freeze({
	published: "rail.Published",
	approved: "rail.Approved",
	activated: "rail.Activated",
	deactivated: "rail.Deactivated",
	retired: "rail.Retired",
} as const);

// public-contract: metric names the rail readers emit.
export const RAIL_READER_METRICS = Object.freeze({
	deliveryInvalid: "hobo.cd.compose.rail_delivery_invalid",
});

export type RailStatus = "published" | "approved" | "active" | "retired";

export type RailCatalogEntry = Readonly<{
	railId: string;
	railDigest: Digest;
	stationId: string;
	status: RailStatus;
	/** The Rail's opaque `delivery` object, verbatim; absent when it has none. */
	delivery?: JsonObject;
}>;

export interface RailCatalog {
	active(stationId: string): Promise<RailCatalogEntry | undefined>;
	byDigest(railDigest: string): Promise<RailCatalogEntry | undefined>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isDigest(value: unknown): value is Digest {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

type Mutable = {
	railId: string;
	railDigest: Digest;
	stationId: string;
	status: RailStatus;
	delivery?: JsonObject;
};

type Fold = {
	after: EventPosition | undefined;
	byDigest: Map<string, Mutable>;
	activeByStation: Map<string, string>;
};

function freeze(entry: Mutable): RailCatalogEntry {
	return Object.freeze({ ...entry });
}

/** Apply one Station Rail event to the fold. Unknown or malformed events are skipped. */
function applyRailEvent(fold: Fold, type: string, data: unknown): void {
	if (!isObject(data)) return;
	const hash = text(data.contentHash);
	switch (type) {
		case RAIL_EVENT_TYPES.published:
		case RAIL_EVENT_TYPES.approved: {
			const rail = isObject(data.rail) ? data.rail : undefined;
			const digest = text(rail?.contentHash) ?? hash;
			const railId = text(rail?.id) ?? text(data.railId);
			const stationId = text(rail?.stationId) ?? text(data.stationId);
			if (!isDigest(digest) || !railId || !stationId) return;
			const known = fold.byDigest.get(digest);
			const status: RailStatus =
				type === RAIL_EVENT_TYPES.approved
					? known?.status === "active"
						? "active"
						: "approved"
					: (known?.status ?? "published");
			const delivery = isObject(rail?.delivery)
				? // SAFETY: Rail bodies are JSON (parsed by @hobo/stations).
					(rail.delivery as JsonObject)
				: known?.delivery;
			fold.byDigest.set(digest, {
				railId,
				railDigest: digest,
				stationId,
				status,
				...(delivery !== undefined ? { delivery } : undefined),
			});
			return;
		}
		case RAIL_EVENT_TYPES.activated: {
			const entry = hash ? fold.byDigest.get(hash) : undefined;
			if (!entry) return;
			const previous = fold.activeByStation.get(entry.stationId);
			if (previous && previous !== entry.railDigest) {
				const old = fold.byDigest.get(previous);
				if (old && old.status === "active") old.status = "approved";
			}
			entry.status = "active";
			fold.activeByStation.set(entry.stationId, entry.railDigest);
			return;
		}
		case RAIL_EVENT_TYPES.deactivated: {
			const entry = hash ? fold.byDigest.get(hash) : undefined;
			if (!entry) return;
			if (entry.status === "active") entry.status = "approved";
			if (fold.activeByStation.get(entry.stationId) === entry.railDigest)
				fold.activeByStation.delete(entry.stationId);
			return;
		}
		case RAIL_EVENT_TYPES.retired: {
			const entry = hash ? fold.byDigest.get(hash) : undefined;
			if (!entry) return;
			entry.status = "retired";
			if (fold.activeByStation.get(entry.stationId) === entry.railDigest)
				fold.activeByStation.delete(entry.stationId);
			return;
		}
		default:
			return;
	}
}

const RAIL_TYPES = new Set<string>(Object.values(RAIL_EVENT_TYPES));

/** Incremental fold of the Station Rail events from the journal. */
export function createJournalRailCatalog(
	d: Readonly<{ store: DurableEventStore }>,
): RailCatalog {
	const fold: Fold = {
		after: undefined,
		byDigest: new Map(),
		activeByStation: new Map(),
	};
	let catchingUp: Promise<void> | undefined;
	async function catchUp(): Promise<void> {
		for await (const { position, event } of d.store.readAll(
			fold.after === undefined ? {} : { after: fold.after },
		)) {
			fold.after = position;
			if (RAIL_TYPES.has(event.type))
				applyRailEvent(fold, event.type, event.data);
		}
	}
	async function current(): Promise<void> {
		// One catch-up at a time; concurrent readers share it.
		catchingUp ??= catchUp().finally(() => {
			catchingUp = undefined;
		});
		await catchingUp;
	}
	return Object.freeze({
		async active(stationId: string) {
			await current();
			const digest = fold.activeByStation.get(stationId);
			const entry = digest ? fold.byDigest.get(digest) : undefined;
			return entry ? freeze(entry) : undefined;
		},
		async byDigest(railDigest: string) {
			await current();
			const entry = fold.byDigest.get(railDigest);
			return entry ? freeze(entry) : undefined;
		},
	});
}

function parsePosition(cursor: string | undefined): EventPosition | undefined {
	if (cursor === undefined || cursor === "") return undefined;
	if (!/^\d+$/.test(cursor)) return undefined;
	// SAFETY: a decimal journal position written by this reader.
	return BigInt(cursor) as EventPosition;
}

/**
 * The frozen RailEventReader over the journal. The cursor is the decimal
 * journal position; approvals, activations and retirements are reported with
 * the Rail id and Station the Rail body names.
 */
export function createJournalRailEventReader(
	d: Readonly<{ store: DurableEventStore }>,
): RailEventReader {
	return async function* readRailEvents(after, signal) {
		// The fold must see every Rail body, including those before the
		// cursor, to name the Rail and Station of an activation or retirement.
		const fold: Fold = {
			after: undefined,
			byDigest: new Map(),
			activeByStation: new Map(),
		};
		const start = parsePosition(after);
		for await (const { position, event } of d.store.readAll({})) {
			if (signal.aborted) return;
			if (!RAIL_TYPES.has(event.type)) continue;
			applyRailEvent(fold, event.type, event.data);
			if (start !== undefined && position <= start) continue;
			const status =
				event.type === RAIL_EVENT_TYPES.approved
					? "approved"
					: event.type === RAIL_EVENT_TYPES.activated
						? "active"
						: event.type === RAIL_EVENT_TYPES.retired
							? "retired"
							: undefined;
			if (status === undefined) continue;
			const data = isObject(event.data) ? event.data : {};
			const rail = isObject(data.rail) ? data.rail : undefined;
			const digest = text(rail?.contentHash) ?? text(data.contentHash);
			const entry = digest ? fold.byDigest.get(digest) : undefined;
			if (!entry) continue;
			yield Object.freeze({
				cursor: position.toString(),
				railId: entry.railId,
				railDigest: entry.railDigest,
				status,
				stationId: entry.stationId,
			});
		}
	};
}

/** Parse a Rail's opaque `delivery` object as RailDeliveryRecord. */
export function parseRailDelivery(
	railDigest: Digest,
	delivery: JsonObject | undefined,
): Outcome<RailDeliveryRecord> {
	if (delivery === undefined) {
		return {
			ok: true,
			value: create(RailDeliveryRecordSchema, { railDigest }),
		};
	}
	try {
		// SAFETY: JsonObject is a structural subset of protobuf's JsonValue.
		const parsed = fromJson(RailDeliveryRecordSchema, delivery as JsonValue);
		return { ok: true, value: { ...parsed, railDigest } };
	} catch (error) {
		return composeRefusal(
			"rail-delivery-invalid",
			error instanceof Error ? error.message : String(error),
			railDigest,
		);
	}
}

/**
 * The frozen RailDeliveryReader: a Camp's enforced binding first, else its
 * Station's active Rail (D24: an unbound Camp keeps today's behavior).
 */
export function createRailDeliveryReader(
	d: Readonly<{
		catalog: RailCatalog;
		campPolicy: CampPolicy;
		topology: TopologyReader;
		telemetry?: TelemetrySink;
		now: () => number;
	}>,
): RailDeliveryReader {
	function toRecord(
		entry: RailCatalogEntry | undefined,
	): RailDeliveryRecord | undefined {
		if (!entry) return undefined;
		const parsed = parseRailDelivery(entry.railDigest, entry.delivery);
		if (parsed.ok) return parsed.value;
		d.telemetry
			?.metrics([
				{
					name: RAIL_READER_METRICS.deliveryInvalid,
					kind: "counter",
					value: 1,
					unit: "1",
					atMs: d.now(),
					attributes: {
						"hobo.rail.digest": entry.railDigest,
						"hobo.station.id": entry.stationId,
					},
				},
			])
			.catch(() => {
				// Telemetry is best-effort.
			});
		// Binds nothing: no Camp sets, failover off, enrollment by grants.
		return create(RailDeliveryRecordSchema, { railDigest: entry.railDigest });
	}
	async function forStation(stationId: string) {
		return toRecord(await d.catalog.active(stationId));
	}
	return Object.freeze({
		forStation,
		async forCamp(campId: CampId) {
			const binding = await d.campPolicy.binding(campId);
			const enforced = binding?.enforcedRailDigest;
			if (enforced) {
				const entry = await d.catalog.byDigest(enforced);
				// An enforced Rail the journal does not know binds nothing; it
				// never falls back to the Station's Rail (fail closed).
				return entry
					? toRecord(entry)
					: create(RailDeliveryRecordSchema, { railDigest: enforced });
			}
			const camp = await d.topology.camp(campId);
			return camp ? forStation(camp.stationId) : undefined;
		},
	});
}
