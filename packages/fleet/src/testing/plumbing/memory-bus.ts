/**
 * `createMemoryBus`: the in-memory `AuthorityBus` every lane tests against
 * (design §11.2 step 5, §7.3). Plumbing of the contract commit: maps over an
 * injected clock, holding no decision of its own.
 *
 * - Streams keep order and sequence numbers; every `subscribe` honours its
 *   `BusStart`. Maximum ages are those of the §6.7 table: submissions 24 h,
 *   offers 15 min, claims 120 s, orders 15 min, events 30 days, control 1 h.
 * - The claim ledger refuses a second writer for one `(fleet, digest)` until
 *   the first claim ages out (120 s) or a dispatcher removes it (E5).
 * - Observations are kept per `<observer>.<member>` key, latest only, for 60 s.
 * - The replay store answers `firstUse` until each id's own expiry.
 * - Its `RegistryView` DECODES ENVELOPES WITHOUT VERIFYING THEIR SIGNATURES:
 *   it is for tests only. It still refuses a record whose context or key does
 *   not match, a record past its `not_after` (against the injected clock), and
 *   one whose `record_sequence` (member), `revision` (fleet) or `sequence`
 *   (trust) is lower than the highest it has returned for that key: the two
 *   freshness assertions of `runBusConformance`.
 */
import { clone, create, fromBinary, type Message } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import {
	type AuditEntry,
	AuditEntrySchema,
	type FleetRecord,
	FleetRecordSchema,
	FleetViewSchema,
	type MemberRecord,
	MemberRecordSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "../../_generated/fleet_pb.js";
import {
	FLEET_RECORD_CONTEXT,
	FLEET_VIEW_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	TRUST_RECORD_CONTEXT,
} from "../../contexts.js";
import type { FleetId, MemberId, WorkDigest } from "../../ids.js";
import type {
	AuditLog,
	AuthorityBus,
	BusStart,
	Clock,
	KeyedEnvelope,
	RegistryView,
	Subscription,
} from "../../ports.js";
import {
	createDeliveryQueue,
	createMemoryStream,
	type DeliveryQueue,
	type MemoryStream,
} from "./stream.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The limits of the §6.7 streams and buckets. */
const LIMITS = {
	observationTtlMs: 60 * SECOND,
	submissionsMaxAgeMs: 24 * HOUR,
	offersMaxAgeMs: 15 * MINUTE,
	claimsMaxAgeMs: 120 * SECOND,
	ordersMaxAgeMs: 15 * MINUTE,
	eventsMaxAgeMs: 30 * 24 * HOUR,
	controlMaxAgeMs: HOUR,
} as const;

type ClaimMessage = Readonly<{
	claim: SignedEnvelope;
	fleet: FleetId;
	digest: WorkDigest;
}>;
type FleetMessage = Readonly<{ envelope: SignedEnvelope; fleet: FleetId }>;
type MemberMessage = Readonly<{ envelope: SignedEnvelope; member: MemberId }>;
type EventMessage = Readonly<{
	event: SignedEnvelope;
	from: MemberId;
	kind: string;
}>;
type CoSignature = Readonly<{
	cosignature: SignedEnvelope;
	of: "checkpoint" | "trust";
}>;

/** The witness's publish path of the memory bus, keyed by bus. Private to the plumbing. */
const WITNESS_PATHS = new WeakMap<
	AuthorityBus,
	(cosignature: SignedEnvelope, of: "checkpoint" | "trust") => Promise<void>
>();

/**
 * Plumbing-private: publish a witness co-signature on the memory bus's
 * `fleet.audit.witness` subject. The bus pairs it with the checkpoint or
 * proposed trust record carrying the same payload bytes and hands the
 * resulting `WitnessedEnvelope` to `onWitnessed` or `onTrustWitnessed`.
 * Not re-exported: `AuthorityBus` has no witness publish path (§7.3).
 */
export async function publishWitnessCosignature(
	bus: AuthorityBus,
	cosignature: SignedEnvelope,
	of: "checkpoint" | "trust",
): Promise<void> {
	const path = WITNESS_PATHS.get(bus);
	if (path === undefined)
		throw new Error("not a bus created by createMemoryBus");
	await path(cosignature, of);
}

/** In-memory `AuthorityBus` over an injected clock; its `RegistryView` skips signatures but checks `not_after` and record sequences. Tests only. */
export function createMemoryBus(now: Clock): AuthorityBus {
	let state: "connected" | "closed" = "connected";
	const closers: (() => void)[] = [];
	const track = <T>(stream: MemoryStream<T>): MemoryStream<T> => {
		closers.push(() => stream.close());
		return stream;
	};
	const open = () => {
		if (state === "closed") throw new Error("the memory bus is closed");
	};

	// ── Registry ───────────────────────────────────────────────────────────
	const memberValues = new Map<string, SignedEnvelope>();
	const fleetValues = new Map<string, SignedEnvelope>();
	const viewValues = new Map<string, SignedEnvelope>();
	let trustValue: WitnessedEnvelope | undefined;
	const highestReturned = new Map<string, number>();
	let lastTrust:
		| Readonly<{ record: TrustRecord; envelope: WitnessedEnvelope }>
		| undefined;

	const fresh = <T>(
		key: string,
		record: T | undefined,
		notAfter: (value: T) => string,
		sequence: (value: T) => number,
	): T | undefined => {
		if (record === undefined) return undefined;
		const expiry = Date.parse(notAfter(record));
		if (Number.isNaN(expiry) || now() > expiry) return undefined;
		const highest = highestReturned.get(key) ?? 0;
		if (sequence(record) < highest) return undefined;
		highestReturned.set(key, sequence(record));
		return record;
	};

	const readMember = (key: string, envelope: SignedEnvelope | undefined) => {
		const record = decodeUnder(
			envelope,
			MEMBER_RECORD_CONTEXT,
			MemberRecordSchema,
		);
		if (record === undefined || `member.${record.memberId}` !== key)
			return undefined;
		return fresh<MemberRecord>(
			key,
			record,
			(value) => value.notAfter,
			(value) => value.recordSequence,
		);
	};
	const readFleet = (key: string, envelope: SignedEnvelope | undefined) => {
		const record = decodeUnder(
			envelope,
			FLEET_RECORD_CONTEXT,
			FleetRecordSchema,
		);
		if (record === undefined || `fleet.${record.fleetId}` !== key)
			return undefined;
		return fresh<FleetRecord>(
			key,
			record,
			(value) => value.notAfter,
			(value) => value.revision,
		);
	};
	const currentTrust = () => {
		if (trustValue === undefined) return lastTrust;
		const record = decodeUnder(
			trustValue.authority,
			TRUST_RECORD_CONTEXT,
			TrustRecordSchema,
		);
		if (
			record !== undefined &&
			record.sequence >= (lastTrust?.record.sequence ?? 0)
		)
			lastTrust = { record, envelope: trustValue };
		return lastTrust;
	};

	const registry: RegistryView = {
		async member(id) {
			const key = `member.${id}`;
			return readMember(key, memberValues.get(key));
		},
		async fleet(id) {
			const key = `fleet.${id}`;
			return readFleet(key, fleetValues.get(key));
		},
		async membersOf(id) {
			const all = await registry.members();
			return all.filter((member) =>
				member.memberships.some((membership) => membership.fleet === id),
			);
		},
		async fleets() {
			const out: FleetRecord[] = [];
			for (const [key, envelope] of fleetValues) {
				const record = readFleet(key, envelope);
				if (record !== undefined) out.push(record);
			}
			return out;
		},
		async members() {
			const out: MemberRecord[] = [];
			for (const [key, envelope] of memberValues) {
				const record = readMember(key, envelope);
				if (record !== undefined) out.push(record);
			}
			return out;
		},
		async view(id) {
			const view = decodeUnder(
				viewValues.get(id),
				FLEET_VIEW_CONTEXT,
				FleetViewSchema,
			);
			if (view === undefined || view.fleet !== id) return undefined;
			const expiry = Date.parse(view.notAfter);
			if (Number.isNaN(expiry) || now() > expiry) return undefined;
			return view;
		},
		trust() {
			const trust = currentTrust();
			// No trust published yet: an empty record names no key, so every verification against it fails closed.
			return trust === undefined
				? fromBinary(TrustRecordSchema, new Uint8Array())
				: clone(TrustRecordSchema, trust.record);
		},
		trustEnvelope() {
			const trust = currentTrust();
			return trust === undefined
				? undefined
				: clone(WitnessedEnvelopeSchema, trust.envelope);
		},
		async caughtUp() {},
	};

	// ── Observations ───────────────────────────────────────────────────────
	const observations = new Map<
		string,
		KeyedEnvelope & Readonly<{ at: number }>
	>();
	const liveObservations = () => {
		const cutoff = now() - LIMITS.observationTtlMs;
		for (const [key, entry] of observations) {
			if (entry.at <= cutoff) observations.delete(key);
		}
		return [...observations.values()];
	};

	// ── Claims ─────────────────────────────────────────────────────────────
	const claimStream = track(
		createMemoryStream<ClaimMessage>(now, LIMITS.claimsMaxAgeMs),
	);
	const claimKey = (fleet: FleetId, digest: WorkDigest) => `${fleet}.${digest}`;
	const claimHeld = (fleet: FleetId, digest: WorkDigest) =>
		claimStream
			.retained()
			.find(
				(entry) =>
					claimKey(entry.value.fleet, entry.value.digest) ===
					claimKey(fleet, digest),
			);

	// ── Streams ────────────────────────────────────────────────────────────
	const offerStream = track(
		createMemoryStream<FleetMessage>(now, LIMITS.offersMaxAgeMs),
	);
	const submissionStream = track(
		createMemoryStream<FleetMessage>(now, LIMITS.submissionsMaxAgeMs),
	);
	const orderStream = track(
		createMemoryStream<MemberMessage>(now, LIMITS.ordersMaxAgeMs),
	);
	const eventStream = track(
		createMemoryStream<EventMessage>(now, LIMITS.eventsMaxAgeMs),
	);
	const controlStream = track(
		createMemoryStream<MemberMessage>(now, LIMITS.controlMaxAgeMs),
	);
	const fleetFeed = (stream: MemoryStream<FleetMessage>) => ({
		async publish(envelope: SignedEnvelope, fleet: FleetId) {
			open();
			stream.publish({
				envelope: clone(SignedEnvelopeSchema, envelope),
				fleet,
			});
		},
		subscribe(
			fleets: readonly FleetId[],
			from: BusStart,
			handler: (envelope: SignedEnvelope, sequence: number) => Promise<void>,
		): Subscription {
			return stream.subscribe(
				from,
				(message) => fleets.includes(message.fleet),
				(entry) =>
					handler(
						clone(SignedEnvelopeSchema, entry.value.envelope),
						entry.sequence,
					),
			);
		},
	});

	// ── Relay (plain publish-subscribe, no stream) ────────────────────────
	const relaySubscribers = new Set<
		Readonly<{
			self: MemberId;
			handler: (sessionId: string, frame: Uint8Array) => Promise<void>;
			queue: DeliveryQueue;
		}>
	>();

	// ── Audit ──────────────────────────────────────────────────────────────
	const auditEntries: AuditEntry[] = [];
	const checkpoints: SignedEnvelope[] = [];
	const proposedTrust = track(
		createMemoryStream<SignedEnvelope>(now, undefined),
	);
	const witnessedCheckpoints = track(
		createMemoryStream<WitnessedEnvelope>(now, undefined),
	);
	const witnessedTrust = track(
		createMemoryStream<WitnessedEnvelope>(now, undefined),
	);
	let pendingCosignatures: CoSignature[] = [];
	const pair = () => {
		const waiting = pendingCosignatures;
		pendingCosignatures = [];
		for (const pending of waiting) {
			const candidates =
				pending.of === "checkpoint"
					? checkpoints
					: proposedTrust.retained().map((entry) => entry.value);
			const authority = candidates.find((candidate) =>
				sameBytes(candidate.payload, pending.cosignature.payload),
			);
			if (authority === undefined) {
				pendingCosignatures.push(pending);
				continue;
			}
			const witnessed = create(WitnessedEnvelopeSchema, {
				authority,
				witness: pending.cosignature,
			});
			(pending.of === "checkpoint"
				? witnessedCheckpoints
				: witnessedTrust
			).publish(witnessed);
		}
	};
	const fromStart = <T>(
		stream: MemoryStream<T>,
		handler: (value: T) => Promise<void>,
	): Subscription =>
		stream.subscribe(
			"start",
			() => true,
			(entry) => handler(entry.value),
		);

	const audit: AuditLog = {
		async append(entry) {
			open();
			auditEntries.push(clone(AuditEntrySchema, entry));
		},
		async appendCheckpoint(checkpoint) {
			open();
			checkpoints.push(clone(SignedEnvelopeSchema, checkpoint));
			pair();
		},
		async entries(fromSequence, toSequence) {
			return auditEntries
				.filter(
					(entry) =>
						entry.sequence >= fromSequence && entry.sequence <= toSequence,
				)
				.sort((a, b) => a.sequence - b.sequence)
				.map((entry) => clone(AuditEntrySchema, entry));
		},
		onWitnessed(handler) {
			return fromStart(witnessedCheckpoints, (value) =>
				handler(clone(WitnessedEnvelopeSchema, value)),
			);
		},
		async proposeTrust(record) {
			open();
			proposedTrust.publish(clone(SignedEnvelopeSchema, record));
			pair();
		},
		onTrustProposed(handler) {
			return fromStart(proposedTrust, (value) =>
				handler(clone(SignedEnvelopeSchema, value)),
			);
		},
		onTrustWitnessed(handler) {
			return fromStart(witnessedTrust, (value) =>
				handler(clone(WitnessedEnvelopeSchema, value)),
			);
		},
	};

	// ── Replay ─────────────────────────────────────────────────────────────
	const seen = new Map<string, number>();

	const bus: AuthorityBus = {
		registry,
		observations: {
			async publish(observation, observer, member) {
				open();
				const key = `${observer}.${member}`;
				observations.delete(key);
				observations.set(key, {
					observerId: observer,
					memberId: member,
					envelope: clone(SignedEnvelopeSchema, observation),
					at: now(),
				});
			},
			async read(limit) {
				const live = liveObservations();
				return {
					observations: live.slice(0, Math.max(0, limit)).map((entry) => ({
						observerId: entry.observerId,
						memberId: entry.memberId,
						envelope: clone(SignedEnvelopeSchema, entry.envelope),
					})),
					capped: live.length > limit,
				};
			},
		},
		claims: {
			async claim(claim, fleet, digest) {
				open();
				if (claimHeld(fleet, digest) !== undefined) return "held";
				claimStream.publish({
					claim: clone(SignedEnvelopeSchema, claim),
					fleet,
					digest,
				});
				return "claimed";
			},
			async holder(fleet, digest) {
				const held = claimHeld(fleet, digest);
				return held === undefined
					? undefined
					: clone(SignedEnvelopeSchema, held.value.claim);
			},
			subscribe(fleets, from, handler) {
				return claimStream.subscribe(
					from,
					(message) => fleets.includes(message.fleet),
					(entry) =>
						handler(
							clone(SignedEnvelopeSchema, entry.value.claim),
							entry.value.fleet,
							entry.value.digest,
							entry.sequence,
						),
				);
			},
			async remove(fleet, digest) {
				open();
				claimStream.remove(
					(message) =>
						claimKey(message.fleet, message.digest) === claimKey(fleet, digest),
				);
			},
		},
		offers: fleetFeed(offerStream),
		submissions: fleetFeed(submissionStream),
		orders: {
			async deliver(order, to) {
				open();
				orderStream.publish({
					envelope: clone(SignedEnvelopeSchema, order),
					member: to,
				});
			},
			subscribe(self, from, handler) {
				return orderStream.subscribe(
					from,
					(message) => message.member === self,
					(entry) =>
						handler(
							clone(SignedEnvelopeSchema, entry.value.envelope),
							entry.sequence,
						),
				);
			},
			observeAll(from, handler) {
				return orderStream.subscribe(
					from,
					() => true,
					(entry) =>
						handler(
							clone(SignedEnvelopeSchema, entry.value.envelope),
							entry.value.member,
							entry.sequence,
						),
				);
			},
		},
		events: {
			async publish(event, from, kind) {
				open();
				eventStream.publish({
					event: clone(SignedEnvelopeSchema, event),
					from,
					kind,
				});
			},
			subscribe(kinds, from, handler) {
				return eventStream.subscribe(
					from,
					(message) => kinds.includes(message.kind),
					(entry) =>
						handler(
							clone(SignedEnvelopeSchema, entry.value.event),
							entry.value.from,
							entry.value.kind,
							entry.sequence,
						),
				);
			},
		},
		control: {
			async send(control, to) {
				open();
				controlStream.publish({
					envelope: clone(SignedEnvelopeSchema, control),
					member: to,
				});
			},
			subscribe(self, from, handler) {
				return controlStream.subscribe(
					from,
					(message) => message.member === self,
					(entry) =>
						handler(
							clone(SignedEnvelopeSchema, entry.value.envelope),
							entry.sequence,
						),
				);
			},
		},
		relay: {
			async send(to, sessionId, frame) {
				open();
				for (const subscriber of relaySubscribers) {
					if (subscriber.self !== to) continue;
					const copy = frame.slice();
					subscriber.queue.push(() => subscriber.handler(sessionId, copy));
				}
			},
			subscribe(self, handler) {
				const subscriber = { self, handler, queue: createDeliveryQueue() };
				relaySubscribers.add(subscriber);
				return {
					async stop() {
						relaySubscribers.delete(subscriber);
						subscriber.queue.stop();
					},
				};
			},
		},
		status() {
			return state;
		},
		async close() {
			state = "closed";
			for (const closeStream of closers) closeStream();
			for (const subscriber of relaySubscribers) subscriber.queue.stop();
			relaySubscribers.clear();
		},
		publisher: {
			async putMember(record, id) {
				open();
				memberValues.set(`member.${id}`, clone(SignedEnvelopeSchema, record));
			},
			async putFleet(record, id) {
				open();
				fleetValues.set(`fleet.${id}`, clone(SignedEnvelopeSchema, record));
			},
			async putView(view, id) {
				open();
				viewValues.set(id, clone(SignedEnvelopeSchema, view));
			},
			async putTrust(trust) {
				open();
				trustValue = clone(WitnessedEnvelopeSchema, trust);
			},
		},
		audit,
		replay: {
			async firstUse(scope, id, expiresAtMs) {
				const key = `${scope}.${id}`;
				const until = seen.get(key);
				if (until !== undefined && until > now()) return false;
				seen.set(key, expiresAtMs);
				return true;
			},
		},
	};

	WITNESS_PATHS.set(bus, async (cosignature, of) => {
		open();
		pendingCosignatures.push({
			cosignature: clone(SignedEnvelopeSchema, cosignature),
			of,
		});
		pair();
	});
	return bus;
}

/** Decodes an envelope's payload under its expected context, without verifying the signature. */
function decodeUnder<T extends Message>(
	envelope: SignedEnvelope | undefined,
	context: string,
	schema: GenMessage<T>,
): T | undefined {
	if (envelope === undefined || envelope.context !== context) return undefined;
	try {
		return fromBinary(schema, envelope.payload);
	} catch {
		return undefined;
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
