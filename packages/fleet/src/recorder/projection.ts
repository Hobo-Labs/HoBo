/**
 * The registry projection (design §6.14, §7.5): rebuilds member and fleet
 * records from the journal (`readAll`), signs them with `issued_at` and a
 * `not_after` 30 minutes later, publishes them to `fleet-registry`, re-signs
 * every 10 minutes (and always before `not_after`) with `record_sequence` and
 * `revision` unchanged, so the witness ignores a re-sign (D45); builds, signs
 * and publishes each fleet's view every 30 seconds; and emits
 * `fleet.member.active` member-hours (D40).
 *
 * Records come from the events' `data.record` (protobuf JSON of the record
 * without its signing-time fields) and their sequence from the record itself
 * (D57): `record_sequence` for a member, `revision` for a fleet, falling back
 * to `data.subjectSequence` and `meta.subjectSequence` when the record does
 * not carry it. Every value is rebuilt by replay; nothing is read back from
 * the buckets, so deleting them and rebuilding gives the same records and
 * sequences.
 *
 * The projection wakes on every journal append, so a fleet record is on the
 * bus before the first enrollment into it, and `caughtUp()` resolves once
 * every change journalled so far is published.
 */
import { createHash } from "node:crypto";
import { create, fromJson, toBinary } from "@bufbuild/protobuf";
import {
	createUsageEvent,
	type EventEnvelope,
	type EventPosition,
	type JsonObject,
} from "@hobo/core";
import {
	type FleetRecord,
	FleetRecordSchema,
	FleetViewSchema,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	type Observation,
	type ReliabilitySamples,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import {
	FLEET_RECORD_CONTEXT,
	FLEET_VIEW_CONTEXT,
	MEMBER_RECORD_CONTEXT,
} from "../contexts.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseMemberId,
} from "../ids.js";
import { signEnvelope } from "../keys/index.js";
import { acceptObservation, fleetView } from "../observation/index.js";
import type { AuthorityDeps, KeyedEnvelope } from "../ports.js";
import { isJsonNumber, isJsonObject, objectOf } from "./json.js";

export type ProjectionDeps = Pick<
	AuthorityDeps,
	| "tenant"
	| "store"
	| "bus"
	| "recordSigner"
	| "incarnation"
	| "metering"
	| "now"
	| "log"
> &
	Readonly<{ reliability(): ReadonlyMap<MemberId, ReliabilitySamples> }>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MEMBER_STREAM = "fleet-member-";
const FLEET_STREAM = "fleet-fleet-";
/** A record is valid for at most 30 minutes after it is signed (§7.1). */
const RECORD_TTL_MS = 30 * MINUTE;
/** Records are re-signed every 10 minutes (§6.14). */
const RESIGN_EVERY_MS = 10 * MINUTE;
/** A record is re-signed at the latest this long before its not_after. */
const RESIGN_MARGIN_MS = 2 * MINUTE;
/** Fleet views are built and published every 30 seconds (§6.8). */
const VIEW_EVERY_MS = 30_000;
/** At most this many observations are read for one round of views. */
const OBSERVATION_LIMIT = 16_384;

type Published = Readonly<{
	sequence: number;
	issuedAtMs: number;
	notAfterMs: number;
}>;
type Entry<T> = {
	record: T;
	sequence: number;
	published: Published | undefined;
};
type Accepted = Readonly<{
	digest: string;
	observation: Observation | undefined;
	issuedAtMs: number | undefined;
}>;

function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function positive(value: JsonObject[string] | undefined): number {
	return isJsonNumber(value) && Number.isSafeInteger(value) && value > 0
		? value
		: 0;
}

/** The record's sequence after the event: the record's own, else the event's subject sequence. */
function sequenceOf(own: number, data: JsonObject, event: EventEnvelope) {
	return (
		own ||
		positive(data.subjectSequence) ||
		positive(objectOf(event.meta).subjectSequence)
	);
}

function recordJson(data: JsonObject): JsonObject | undefined {
	const value = data.record;
	return isJsonObject(value) ? value : undefined;
}

export function projection(deps: ProjectionDeps) {
	const members = new Map<MemberId, Entry<MemberRecord>>();
	const fleets = new Map<FleetId, Entry<FleetRecord>>();
	const accepted = new Map<string, Accepted>();
	let position: EventPosition | undefined;
	let chain: Promise<void> = Promise.resolve();
	let lastViewsMs: number | undefined;
	let lastTickMs: number | undefined;
	let activeAtLastTick: readonly MemberId[] = [];
	const hours = new Map<number, Map<MemberId, number>>();

	// ── The fold ───────────────────────────────────────────────────────────

	function applyMember(event: EventEnvelope, data: JsonObject): void {
		const json = recordJson(data);
		if (json === undefined) return;
		let id: MemberId;
		try {
			id = parseMemberId(event.streamId.slice(MEMBER_STREAM.length));
		} catch {
			return;
		}
		const record = fromJson(MemberRecordSchema, json, {
			ignoreUnknownFields: true,
		});
		if (record.memberId !== id) return;
		const sequence = sequenceOf(record.recordSequence, data, event);
		const before = members.get(id);
		if (before !== undefined && sequence < before.sequence) return;
		record.recordSequence = sequence;
		members.set(id, { record, sequence, published: before?.published });
	}

	function applyFleet(event: EventEnvelope, data: JsonObject): void {
		const json = recordJson(data);
		if (json === undefined) return;
		let id: FleetId;
		try {
			id = parseFleetId(event.streamId.slice(FLEET_STREAM.length));
		} catch {
			return;
		}
		const record = fromJson(FleetRecordSchema, json, {
			ignoreUnknownFields: true,
		});
		if (record.fleetId !== id) return;
		const before = fleets.get(id);
		// A writer that names no revision still advances it once per content change.
		const sequence =
			sequenceOf(record.revision, data, event) || (before?.sequence ?? 0) + 1;
		if (before !== undefined && sequence < before.sequence) return;
		record.revision = sequence;
		fleets.set(id, { record, sequence, published: before?.published });
	}

	function apply(event: EventEnvelope): void {
		const data = objectOf(event.data);
		if (event.streamId.startsWith(MEMBER_STREAM)) applyMember(event, data);
		else if (event.streamId.startsWith(FLEET_STREAM)) applyFleet(event, data);
	}

	async function catchUp(): Promise<void> {
		const options = position === undefined ? {} : { after: position };
		for await (const positioned of deps.store.readAll(options)) {
			apply(positioned.event);
			position = positioned.position;
		}
	}

	// ── Publishing ─────────────────────────────────────────────────────────

	function due(
		entry: Entry<MemberRecord> | Entry<FleetRecord>,
		nowMs: number,
		resign: boolean,
	): boolean {
		const published = entry.published;
		if (published === undefined || published.sequence !== entry.sequence)
			return true;
		if (published.notAfterMs - nowMs <= RESIGN_MARGIN_MS) return true;
		return resign && nowMs - published.issuedAtMs >= RESIGN_EVERY_MS;
	}

	async function put(
		kind: "member" | "fleet",
		id: string,
		write: () => Promise<void>,
	): Promise<boolean> {
		try {
			await write();
			return true;
		} catch (error) {
			// The next tick tries again; the journal is the truth.
			deps.log("hobo_fleet_bus_status", {
				projection: "publish-failed",
				kind,
				id,
				message: error instanceof Error ? error.message : "unknown",
			});
			return false;
		}
	}

	async function publishRecords(resign: boolean): Promise<void> {
		const nowMs = deps.now();
		const issuedAt = new Date(nowMs).toISOString();
		const notAfterMs = nowMs + RECORD_TTL_MS;
		const notAfter = new Date(notAfterMs).toISOString();
		// Fleets first: an enrollment into a fleet reads its record.
		for (const [id, entry] of fleets) {
			if (!due(entry, nowMs, resign)) continue;
			const signed = create(FleetRecordSchema, {
				...entry.record,
				issuedAt,
				notAfter,
			});
			const envelope = await signEnvelope(
				deps.recordSigner,
				FLEET_RECORD_CONTEXT,
				toBinary(FleetRecordSchema, signed),
			);
			if (
				await put("fleet", id, () => deps.bus.publisher.putFleet(envelope, id))
			)
				entry.published = {
					sequence: entry.sequence,
					issuedAtMs: nowMs,
					notAfterMs,
				};
		}
		for (const [id, entry] of members) {
			if (!due(entry, nowMs, resign)) continue;
			const signed = create(MemberRecordSchema, {
				...entry.record,
				authorityIncarnation: deps.incarnation,
				issuedAt,
				notAfter,
			});
			const envelope = await signEnvelope(
				deps.recordSigner,
				MEMBER_RECORD_CONTEXT,
				toBinary(MemberRecordSchema, signed),
			);
			if (
				await put("member", id, () =>
					deps.bus.publisher.putMember(envelope, id),
				)
			)
				entry.published = {
					sequence: entry.sequence,
					issuedAtMs: nowMs,
					notAfterMs,
				};
		}
	}

	// ── Views ──────────────────────────────────────────────────────────────

	/** The verified observations on the board; each new value is accepted (or refused) once. */
	async function observations(nowMs: number): Promise<Observation[]> {
		const board = await deps.bus.observations.read(OBSERVATION_LIMIT);
		const out: Observation[] = [];
		const seen = new Set<string>();
		for (const keyed of board.observations) {
			const key = `${keyed.observerId}.${keyed.memberId}`;
			seen.add(key);
			const digest = sha256Hex(keyed.envelope.signature);
			const before = accepted.get(key);
			if (before?.digest === digest) {
				if (before.observation !== undefined) out.push(before.observation);
				continue;
			}
			const next = await accept(keyed, before?.issuedAtMs, nowMs, digest);
			accepted.set(key, next);
			if (next.observation !== undefined) out.push(next.observation);
		}
		for (const key of accepted.keys()) if (!seen.has(key)) accepted.delete(key);
		return out;
	}

	async function accept(
		keyed: KeyedEnvelope,
		lastIssuedAtMs: number | undefined,
		nowMs: number,
		digest: string,
	): Promise<Accepted> {
		const result = await acceptObservation(
			keyed,
			deps.bus.registry,
			lastIssuedAtMs,
			nowMs,
		);
		if (!result.ok) {
			deps.log("hobo_fleet_observation_rejected", {
				observer: keyed.observerId,
				member: keyed.memberId,
				reason: result.error.detail?.reason ?? result.error.code,
			});
			return { digest, observation: undefined, issuedAtMs: lastIssuedAtMs };
		}
		return {
			digest,
			observation: result.value,
			issuedAtMs: Date.parse(result.value.issuedAt),
		};
	}

	async function publishViews(nowMs: number): Promise<void> {
		if (lastViewsMs !== undefined && nowMs - lastViewsMs < VIEW_EVERY_MS)
			return;
		lastViewsMs = nowMs;
		const seen = await observations(nowMs);
		const records = [...members.values()].map((entry) => entry.record);
		const reliability = deps.reliability();
		for (const [id, entry] of fleets) {
			const view = fleetView(entry.record, records, seen, reliability, nowMs);
			const envelope: SignedEnvelope = await signEnvelope(
				deps.recordSigner,
				FLEET_VIEW_CONTEXT,
				toBinary(FleetViewSchema, view),
			);
			await put("fleet", id, () => deps.bus.publisher.putView(envelope, id));
		}
	}

	// ── Member-hours ───────────────────────────────────────────────────────

	function addActive(member: MemberId, fromMs: number, toMs: number): void {
		for (
			let hourStart = Math.floor(fromMs / HOUR) * HOUR;
			hourStart < toMs;
			hourStart += HOUR
		) {
			const overlap =
				Math.min(toMs, hourStart + HOUR) - Math.max(fromMs, hourStart);
			if (overlap <= 0) continue;
			const bucket = hours.get(hourStart) ?? new Map<MemberId, number>();
			bucket.set(member, (bucket.get(member) ?? 0) + overlap);
			hours.set(hourStart, bucket);
		}
	}

	/**
	 * Member-hours: the time each member was ACTIVE, as seen at each tick,
	 * emitted once per member when its hour has passed. Hours that passed
	 * before this projection's first tick are not emitted again: the instance
	 * that saw them emitted them. `usageKey` names the (tenant, member, hour)
	 * so a sink can drop the copy a second replica would send.
	 */
	async function meterMembers(nowMs: number): Promise<void> {
		if (lastTickMs !== undefined && nowMs > lastTickMs)
			for (const member of activeAtLastTick)
				addActive(member, lastTickMs, nowMs);
		const ended = [...hours.keys()]
			.filter((hourStart) => hourStart + HOUR <= nowMs)
			.sort((a, b) => a - b);
		for (const hourStart of ended) {
			const bucket = hours.get(hourStart);
			hours.delete(hourStart);
			const hour = new Date(hourStart).toISOString();
			for (const [member, ms] of bucket ?? []) {
				await deps.metering.emit(
					createUsageEvent({
						tenantId: deps.tenant,
						eventType: "fleet.member.active",
						resource: member,
						quantity: ms / HOUR,
						unit: "hour",
						timestamp: new Date(hourStart + HOUR).toISOString(),
						metadata: {
							hour,
							usageKey: sha256Hex(
								`fleet.member.active\u0000${deps.tenant}\u0000${member}\u0000${hour}`,
							).slice(0, 32),
						},
					}),
				);
			}
		}
		if (lastTickMs === undefined || nowMs > lastTickMs) lastTickMs = nowMs;
		activeAtLastTick = [...members]
			.filter(([, entry]) => entry.record.state === MemberState.ACTIVE)
			.map(([id]) => id);
	}

	// ── Scheduling ─────────────────────────────────────────────────────────

	function serial(task: () => Promise<void>): Promise<void> {
		const run = chain.then(task);
		chain = run.catch(() => {});
		return run;
	}

	function caughtUp(): Promise<void> {
		return serial(async () => {
			await catchUp();
			await publishRecords(false);
		});
	}

	// Wake on every append, so a new fleet or member is published at once.
	deps.store.subscribe({}, () => {
		void caughtUp().catch(() => {});
	});

	return {
		tick(): Promise<void> {
			return serial(async () => {
				await catchUp();
				await publishRecords(true);
				const nowMs = deps.now();
				await publishViews(nowMs);
				await meterMembers(nowMs);
			});
		},
		caughtUp,
	};
}
