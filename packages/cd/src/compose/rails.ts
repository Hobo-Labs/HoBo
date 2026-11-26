/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this module is the parse boundary for untrusted journal payloads (Station rail.* event bodies); every member is narrowed structurally here before it reaches a typed RailCatalogEntry. */
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
import { emitMetrics } from "../telemetry/advisory.js";
import { composeRefusal } from "./errors.js";

// STATION_EVENTS in @hobo/stations; strings, so the journal is the contract).
export const RAIL_EVENT_TYPES = Object.freeze({
	published: "rail.Published",
	approved: "rail.Approved",
	activated: "rail.Activated",
	deactivated: "rail.Deactivated",
	retired: "rail.Retired",
} as const);

export const RAIL_READER_METRICS = Object.freeze({
	deliveryInvalid: "hobo.cd.compose.rail_delivery_invalid",
});

export type RailStatus = "published" | "approved" | "active" | "retired";

export type RailCatalogEntry = Readonly<{
	railId: string;
	railDigest: Digest;
	stationId: string;
	status: RailStatus;
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
	return BigInt(cursor) as EventPosition;
}

export function createJournalRailEventReader(
	d: Readonly<{ store: DurableEventStore }>,
): RailEventReader {
	return async function* readRailEvents(after, signal) {
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
		if (d.telemetry)
			emitMetrics(d.telemetry, [
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
			]);
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
				return entry
					? toRecord(entry)
					: create(RailDeliveryRecordSchema, { railDigest: enforced });
			}
			const camp = await d.topology.camp(campId);
			return camp ? forStation(camp.stationId) : undefined;
		},
	});
}
