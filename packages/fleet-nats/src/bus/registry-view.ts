/**
 * The verifying `RegistryView` over the `fleet-registry` and `fleet-views`
 * buckets (§7.4). Every record is verified against the pinned trust record
 * before it is decoded; one past its `not_after`, for another tenant, stored
 * under another member's or fleet's key, or with a lower `record_sequence`
 * (`revision` for fleets) than this view has returned for that key is
 * refused. Reads are live: there is no cache to catch up.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type Clock,
	FLEET_RECORD_CONTEXT,
	FLEET_VIEW_CONTEXT,
	type FleetContext,
	type FleetId,
	type FleetLog,
	type FleetRecord,
	FleetRecordSchema,
	type FleetView,
	FleetViewSchema,
	KeyPurpose,
	MEMBER_RECORD_CONTEXT,
	type MemberId,
	type MemberRecord,
	MemberRecordSchema,
	type PublicKeyRef,
	type RegistryView,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { acceptTrust, parsePublicJwk, verifyEnvelope } from "@hobo/fleet/keys";
import { BUCKETS, keys } from "./names.js";
import type { BusWire } from "./wire.js";

/** Most records one list read takes in. */
export const REGISTRY_LIST_LIMIT = 100_000;

/** Holds the trust record every registry read is verified against. */
export interface TrustPin {
	record(): TrustRecord;
	envelope(): WitnessedEnvelope | undefined;
	/** A trust envelope read from the bus (`bus`) or published by this process (`own`); the pin decides whether to move. */
	offer(next: WitnessedEnvelope, source: "bus" | "own"): void;
}

/** A device's pin: moves only by the §7.4 rule (`acceptTrust`). */
export function devicePin(pinned: WitnessedEnvelope, log: FleetLog): TrustPin {
	const first = acceptTrust(undefined, pinned);
	if (!first.ok)
		throw new Error(
			`the pinned trust record is unusable: ${first.error.message}`,
		);
	let record = first.value;
	let envelope = pinned;
	return {
		record: () => record,
		envelope: () => envelope,
		offer(next) {
			const accepted = acceptTrust(record, next);
			if (accepted.ok) {
				record = accepted.value;
				envelope = next;
			} else if (accepted.error.detail?.rule !== "sequence")
				log("hobo_fleet_bus_status", {
					trust: "refused",
					reason: accepted.error.message,
				});
		},
	};
}

/**
 * The authority's pin: the trust record the authority itself last published
 * with `putTrust` in this process (its own write, so taken as written), else
 * the one its `trust` callback answers. A record read from the bus only fills
 * `trustEnvelope()` until the authority publishes one.
 */
export function authorityPin(trust: () => TrustRecord): TrustPin {
	let published:
		| { record: TrustRecord; envelope: WitnessedEnvelope }
		| undefined;
	let read: WitnessedEnvelope | undefined;
	return {
		record: () => published?.record ?? trust(),
		envelope: () => published?.envelope ?? read,
		offer(next, source) {
			if (source === "bus") {
				read = next;
				return;
			}
			const payload = next.authority?.payload;
			const record =
				payload === undefined
					? undefined
					: decodeAs(() => fromBinary(TrustRecordSchema, payload));
			if (record !== undefined) published = { record, envelope: next };
		},
	};
}

function decodeEnvelope(bytes: Uint8Array): SignedEnvelope | undefined {
	try {
		return fromBinary(SignedEnvelopeSchema, bytes);
	} catch {
		return undefined;
	}
}

export function decodeWitnessed(
	bytes: Uint8Array,
): WitnessedEnvelope | undefined {
	try {
		return fromBinary(WitnessedEnvelopeSchema, bytes);
	} catch {
		return undefined;
	}
}

/** The payload of `bytes` if it is an envelope under `context` signed by an authority key of `trust`. */
export function authorityPayload(
	bytes: Uint8Array,
	context: FleetContext,
	trust: TrustRecord,
): Uint8Array | undefined {
	const envelope = decodeEnvelope(bytes);
	if (envelope === undefined) return undefined;
	const key = trust.authorityKeys.find(
		(candidate) =>
			candidate.keyId === envelope.keyId &&
			candidate.purpose === KeyPurpose.AUTHORITY,
	);
	return key !== undefined && verifiedBy(envelope, context, key)
		? envelope.payload
		: undefined;
}

/**
 * §7.1 encodes an AUTHORITY key's value as the raw key, base64url. A value
 * written as RFC 7517 JSON (as `runBusConformance` writes it) names the same
 * key, so it is accepted too; the signature is checked either way.
 */
function verifiedBy(
	envelope: SignedEnvelope,
	context: FleetContext,
	key: PublicKeyRef,
): boolean {
	if (verifyEnvelope(envelope, context, key)) return true;
	const jwk = parsePublicJwk(key.value);
	return (
		jwk.ok &&
		envelope.keyId === key.keyId &&
		envelope.algorithm === key.algorithm &&
		verifyEnvelope(envelope, context, jwk.value)
	);
}

function decodeAs<T>(decode: () => T): T | undefined {
	try {
		return decode();
	} catch {
		return undefined;
	}
}

function current(notAfter: string, now: Clock): boolean {
	const at = Date.parse(notAfter);
	return Number.isFinite(at) && at > now();
}

export function createRegistryView(
	input: Readonly<{ wire: BusWire; pin: TrustPin; now: Clock }>,
): RegistryView {
	const { wire, pin, now } = input;
	const highest = new Map<string, number>();

	/** Refuses a sequence lower than the highest returned for `key`; remembers the new highest. */
	const fresh = (key: string, sequence: number): boolean => {
		const seen = highest.get(key) ?? 0;
		if (sequence < seen) return false;
		highest.set(key, sequence);
		return true;
	};

	const refreshTrust = async () => {
		const bytes = await wire.kvGet(BUCKETS.registry, keys.trust);
		const envelope = bytes === undefined ? undefined : decodeWitnessed(bytes);
		if (envelope !== undefined) pin.offer(envelope, "bus");
	};

	const memberOf = (
		bytes: Uint8Array,
		id?: MemberId,
	): MemberRecord | undefined => {
		const trust = pin.record();
		const payload = authorityPayload(bytes, MEMBER_RECORD_CONTEXT, trust);
		if (payload === undefined) return undefined;
		const record = decodeAs(() => fromBinary(MemberRecordSchema, payload));
		if (record === undefined) return undefined;
		if (id !== undefined && record.memberId !== id) return undefined;
		if (record.tenant !== trust.tenant || !current(record.notAfter, now))
			return undefined;
		return fresh(`member.${record.memberId}`, record.recordSequence)
			? record
			: undefined;
	};

	const fleetOf = (
		bytes: Uint8Array,
		id?: FleetId,
	): FleetRecord | undefined => {
		const trust = pin.record();
		const payload = authorityPayload(bytes, FLEET_RECORD_CONTEXT, trust);
		if (payload === undefined) return undefined;
		const record = decodeAs(() => fromBinary(FleetRecordSchema, payload));
		if (record === undefined) return undefined;
		if (id !== undefined && record.fleetId !== id) return undefined;
		if (record.tenant !== trust.tenant || !current(record.notAfter, now))
			return undefined;
		return fresh(`fleet.${record.fleetId}`, record.revision)
			? record
			: undefined;
	};

	const list = async <T>(
		prefix: string,
		open: (bytes: Uint8Array) => T | undefined,
	): Promise<readonly T[]> => {
		const { entries } = await wire.kvEntries(
			BUCKETS.registry,
			prefix,
			REGISTRY_LIST_LIMIT,
		);
		const out: T[] = [];
		for (const entry of entries) {
			const record = open(entry.value);
			if (record !== undefined) out.push(record);
		}
		return out;
	};

	const members = () => list("member.", (bytes) => memberOf(bytes));

	return {
		async member(id) {
			const bytes = await wire.kvGet(BUCKETS.registry, keys.member(id));
			return bytes === undefined ? undefined : memberOf(bytes, id);
		},
		async fleet(id) {
			const bytes = await wire.kvGet(BUCKETS.registry, keys.fleet(id));
			return bytes === undefined ? undefined : fleetOf(bytes, id);
		},
		async membersOf(id) {
			return (await members()).filter((record) =>
				record.memberships.some((membership) => membership.fleet === id),
			);
		},
		fleets: () => list("fleet.", (bytes) => fleetOf(bytes)),
		members,
		async view(id): Promise<FleetView | undefined> {
			const bytes = await wire.kvGet(BUCKETS.views, keys.fleet(id));
			if (bytes === undefined) return undefined;
			const payload = authorityPayload(bytes, FLEET_VIEW_CONTEXT, pin.record());
			if (payload === undefined) return undefined;
			const view = decodeAs(() => fromBinary(FleetViewSchema, payload));
			if (
				view === undefined ||
				view.fleet !== id ||
				!current(view.notAfter, now)
			)
				return undefined;
			return view;
		},
		trust: () => pin.record(),
		trustEnvelope: () => pin.envelope(),
		async caughtUp() {
			await refreshTrust();
		},
	};
}
