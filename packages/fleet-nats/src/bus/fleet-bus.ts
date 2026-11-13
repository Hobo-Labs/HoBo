/**
 * The ports of `FleetBus` and `AuthorityBus` (§7.3) over a `BusWire`.
 *
 * Envelopes travel as their protobuf binary form, exactly as signed; this
 * module never re-serialises a payload. Ids read back from a subject or a key
 * are parsed with the `@hobo/fleet` constructors, and a message whose subject
 * does not parse is dropped rather than handed on.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AUDIT_CHECKPOINT_CONTEXT,
	type AuditEntry,
	AuditEntrySchema,
	type AuditLog,
	type AuthorityBus,
	type BusStart,
	type ClaimLedger,
	type Clock,
	type ControlChannel,
	type EventChannel,
	type FleetBus,
	type FleetId,
	type KeyedEnvelope,
	type MemberId,
	type ObservationBoard,
	type OfferFeed,
	type OrderChannel,
	parseFleetId,
	parseMemberId,
	parseWorkDigest,
	type RegistryPublisher,
	type RegistryView,
	type RelayChannel,
	type ReplayStore,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type SubmissionFeed,
	type Subscription,
	TRUST_RECORD_CONTEXT,
	WitnessedEnvelopeSchema,
	type WorkDigest,
} from "@hobo/fleet";
import {
	AUDIT_SUBJECTS,
	BUCKETS,
	isToken,
	keys,
	STREAMS,
	type StreamName,
	subjects,
	tokensAfter,
} from "./names.js";
import type { TrustPin } from "./registry-view.js";
import type { BusWire, WireMessage } from "./wire.js";

const encode = (envelope: SignedEnvelope) =>
	toBinary(SignedEnvelopeSchema, envelope);

function decode(bytes: Uint8Array): SignedEnvelope | undefined {
	try {
		return fromBinary(SignedEnvelopeSchema, bytes);
	} catch {
		return undefined;
	}
}

function attempt<T>(parse: () => T): T | undefined {
	try {
		return parse();
	} catch {
		return undefined;
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function token(value: string, field: string): string {
	if (!isToken(value)) throw new Error(`${field} must be one subject token`);
	return value;
}

async function store(
	wire: BusWire,
	stream: StreamName,
	subject: string,
	data: Uint8Array,
): Promise<void> {
	const result = await wire.streamPublish(stream, subject, data);
	if (result !== "stored")
		throw new Error(`${stream} refused a message on ${subject}`);
}

/** Consumes `filter` on `stream`, decoding each message and passing on those `pick` accepts. */
function envelopes<T>(
	wire: BusWire,
	stream: StreamName,
	filter: string,
	from: BusStart,
	pick: (message: WireMessage, envelope: SignedEnvelope) => T | undefined,
	handler: (
		picked: T,
		envelope: SignedEnvelope,
		sequence: number,
	) => Promise<void>,
): Subscription {
	return wire.consume(stream, filter, from, async (message) => {
		const envelope = decode(message.data);
		if (envelope === undefined) return;
		const picked = pick(message, envelope);
		if (picked !== undefined) await handler(picked, envelope, message.sequence);
	});
}

function claimLedger(wire: BusWire): ClaimLedger {
	return {
		async claim(claim, fleet, digest) {
			const result = await wire.streamPublish(
				STREAMS.claims,
				subjects.claim(fleet, digest),
				encode(claim),
			);
			return result === "stored" ? "claimed" : "held";
		},
		async holder(fleet, digest) {
			const last = await wire.streamLast(
				STREAMS.claims,
				subjects.claim(fleet, digest),
			);
			return last === undefined ? undefined : decode(last.data);
		},
		subscribe(fleets, from, handler) {
			const wanted = new Set<string>(fleets);
			return envelopes(
				wire,
				STREAMS.claims,
				subjects.claims,
				from,
				(message) => {
					const parts = tokensAfter(message.subject, 2, 2);
					if (parts === undefined || !wanted.has(parts[0] ?? ""))
						return undefined;
					const fleet = attempt(() => parseFleetId(parts[0] ?? ""));
					const digest = attempt(() => parseWorkDigest(parts[1] ?? ""));
					return fleet === undefined || digest === undefined
						? undefined
						: { fleet, digest };
				},
				(at: { fleet: FleetId; digest: WorkDigest }, claim, sequence) =>
					handler(claim, at.fleet, at.digest, sequence),
			);
		},
		async remove(fleet, digest) {
			const last = await wire.streamLast(
				STREAMS.claims,
				subjects.claim(fleet, digest),
			);
			if (last !== undefined)
				await wire.streamDelete(STREAMS.claims, last.sequence);
		},
	};
}

/** A stream keyed by fleet: offers and submissions. */
function fleetFeed(
	wire: BusWire,
	stream: StreamName,
	subjectOf: (fleet: FleetId) => string,
	filter: string,
): OfferFeed & SubmissionFeed {
	return {
		publish: (envelope, fleet) =>
			store(wire, stream, subjectOf(fleet), encode(envelope)),
		subscribe(fleets, from, handler) {
			const wanted = new Set<string>(fleets);
			return envelopes(
				wire,
				stream,
				filter,
				from,
				(message) => {
					const parts = tokensAfter(message.subject, 2, 1);
					return parts !== undefined && wanted.has(parts[0] ?? "")
						? true
						: undefined;
				},
				(_fleet, envelope, sequence) => handler(envelope, sequence),
			);
		},
	};
}

function orderChannel(wire: BusWire): OrderChannel {
	return {
		deliver: (order, to) =>
			store(wire, STREAMS.orders, subjects.order(to), encode(order)),
		subscribe: (self, from, handler) =>
			envelopes(
				wire,
				STREAMS.orders,
				subjects.order(self),
				from,
				() => true,
				(_self, order, sequence) => handler(order, sequence),
			),
		observeAll: (from, handler) =>
			envelopes(
				wire,
				STREAMS.orders,
				subjects.orders,
				from,
				(message) => {
					const parts = tokensAfter(message.subject, 2, 1);
					return parts === undefined
						? undefined
						: attempt(() => parseMemberId(parts[0] ?? ""));
				},
				(to: MemberId, order, sequence) => handler(order, to, sequence),
			),
	};
}

function eventChannel(wire: BusWire): EventChannel {
	return {
		publish: (event, from, kind) =>
			store(
				wire,
				STREAMS.events,
				subjects.event(from, token(kind, "kind")),
				encode(event),
			),
		subscribe(kinds, from, handler) {
			const wanted = new Set(kinds);
			return envelopes(
				wire,
				STREAMS.events,
				subjects.events,
				from,
				(message) => {
					const parts = tokensAfter(message.subject, 2, 2);
					if (parts === undefined || !wanted.has(parts[1] ?? ""))
						return undefined;
					const member = attempt(() => parseMemberId(parts[0] ?? ""));
					return member === undefined
						? undefined
						: { member, kind: parts[1] ?? "" };
				},
				(at: { member: MemberId; kind: string }, event, sequence) =>
					handler(event, at.member, at.kind, sequence),
			);
		},
	};
}

function controlChannel(wire: BusWire): ControlChannel {
	return {
		send: (control, to) =>
			store(wire, STREAMS.control, subjects.control(to), encode(control)),
		subscribe: (self, from, handler) =>
			envelopes(
				wire,
				STREAMS.control,
				subjects.control(self),
				from,
				() => true,
				(_self, control, sequence) => handler(control, sequence),
			),
	};
}

function relayChannel(wire: BusWire): RelayChannel {
	return {
		send: (to, sessionId, frame) =>
			wire.publish(subjects.relay(to, token(sessionId, "sessionId")), frame),
		subscribe: (self, handler) =>
			wire.subscribe(subjects.relayOf(self), async (subject, data) => {
				const parts = tokensAfter(subject, 3, 1);
				if (parts !== undefined) await handler(parts[0] ?? "", data);
			}),
	};
}

function observationBoard(wire: BusWire): ObservationBoard {
	return {
		publish: (observation, observer, member) =>
			wire.kvPut(
				BUCKETS.observations,
				keys.observation(observer, member),
				encode(observation),
			),
		async read(limit) {
			const { entries, capped } = await wire.kvEntries(
				BUCKETS.observations,
				"",
				limit,
			);
			const observations: KeyedEnvelope[] = [];
			for (const entry of entries) {
				const [observer, member, ...rest] = entry.key.split(".");
				if (rest.length > 0) continue;
				const observerId = attempt(() => parseMemberId(observer ?? ""));
				const memberId = attempt(() => parseMemberId(member ?? ""));
				const envelope = decode(entry.value);
				if (observerId && memberId && envelope)
					observations.push({ observerId, memberId, envelope });
			}
			return { observations, capped };
		},
	};
}

/** What a device holds, over `wire`, reading the registry through `registry`. */
export function busOverWire(wire: BusWire, registry: RegistryView): FleetBus {
	const feeds = {
		offers: fleetFeed(wire, STREAMS.offers, subjects.offer, subjects.offers),
		submissions: fleetFeed(
			wire,
			STREAMS.submissions,
			subjects.submission,
			subjects.submissions,
		),
	};
	return {
		registry,
		observations: observationBoard(wire),
		claims: claimLedger(wire),
		offers: feeds.offers,
		submissions: feeds.submissions,
		orders: orderChannel(wire),
		events: eventChannel(wire),
		control: controlChannel(wire),
		relay: relayChannel(wire),
		status: () => wire.status(),
		close: () => wire.close(),
	};
}

function registryPublisher(wire: BusWire, pin: TrustPin): RegistryPublisher {
	return {
		putMember: (record, id) =>
			wire.kvPut(BUCKETS.registry, keys.member(id), encode(record)),
		putFleet: (record, id) =>
			wire.kvPut(BUCKETS.registry, keys.fleet(id), encode(record)),
		putView: (view, id) =>
			wire.kvPut(BUCKETS.views, keys.fleet(id), encode(view)),
		async putTrust(trust) {
			await wire.kvPut(
				BUCKETS.registry,
				keys.trust,
				toBinary(WitnessedEnvelopeSchema, trust),
			);
			pin.offer(trust, "own");
		},
	};
}

function replayStore(wire: BusWire, now: Clock): ReplayStore {
	return {
		async firstUse(scope, id, expiresAtMs) {
			const ttlMs = expiresAtMs - now();
			if (ttlMs <= 0) return false;
			return wire.kvCreate(
				BUCKETS.replay,
				keys.replay(scope, id),
				new Uint8Array([1]),
				ttlMs,
			);
		},
	};
}

function auditLog(wire: BusWire): AuditLog {
	/** Pairs each witness co-signature under `context` with the authority envelope on `subject` carrying the same payload. */
	const witnessed = (
		context: string,
		subject: string,
		handler: Parameters<AuditLog["onWitnessed"]>[0],
	): Subscription =>
		wire.consume(
			STREAMS.audit,
			AUDIT_SUBJECTS.witness,
			"start",
			async (message) => {
				const witness = decode(message.data);
				if (witness === undefined || witness.context !== context) return;
				for (const candidate of await wire.streamRead(STREAMS.audit, subject)) {
					const authority = decode(candidate.data);
					if (
						authority !== undefined &&
						sameBytes(authority.payload, witness.payload)
					) {
						await handler(
							create(WitnessedEnvelopeSchema, { authority, witness }),
						);
						return;
					}
				}
			},
		);
	return {
		append: (entry) =>
			store(
				wire,
				STREAMS.audit,
				AUDIT_SUBJECTS.entry,
				toBinary(AuditEntrySchema, entry),
			),
		appendCheckpoint: (checkpoint) =>
			store(wire, STREAMS.audit, AUDIT_SUBJECTS.checkpoint, encode(checkpoint)),
		async entries(fromSequence, toSequence) {
			const out: AuditEntry[] = [];
			for (const message of await wire.streamRead(
				STREAMS.audit,
				AUDIT_SUBJECTS.entry,
			)) {
				const entry = attempt(() => fromBinary(AuditEntrySchema, message.data));
				if (
					entry &&
					entry.sequence >= fromSequence &&
					entry.sequence <= toSequence
				)
					out.push(entry);
			}
			return out.sort((a, b) => a.sequence - b.sequence);
		},
		onWitnessed: (handler) =>
			witnessed(AUDIT_CHECKPOINT_CONTEXT, AUDIT_SUBJECTS.checkpoint, handler),
		proposeTrust: (record) =>
			store(wire, STREAMS.audit, AUDIT_SUBJECTS.trust, encode(record)),
		onTrustProposed: (handler) =>
			envelopes(
				wire,
				STREAMS.audit,
				AUDIT_SUBJECTS.trust,
				"start",
				() => true,
				(_picked, record) => handler(record),
			),
		onTrustWitnessed: (handler) =>
			witnessed(TRUST_RECORD_CONTEXT, AUDIT_SUBJECTS.trust, handler),
	};
}

/** What the authority holds: the device ports plus the registry publisher, the audit log and the replay store. */
export function authorityBusOverWire(
	wire: BusWire,
	registry: RegistryView,
	pin: TrustPin,
	now: Clock,
): AuthorityBus {
	return {
		...busOverWire(wire, registry),
		publisher: registryPublisher(wire, pin),
		audit: auditLog(wire),
		replay: replayStore(wire, now),
	};
}
