/**
 * The enrollment streams of §7.5 and their fold (L02, private to the lane).
 *
 * Streams: `fleet-token-<sha256>`, `fleet-thumbprint-<thumbprint>`,
 * `fleet-member-<MemberId>`. Every event the lane appends carries, in `data`:
 *
 * - `subject`: the registry key the event changes (`member.<MemberId>`), else
 *   the stream id;
 * - `subjectSequence`: the member record's `record_sequence` after the event
 *   when the event changes the record, else 0 (the `AuditEntry` fields of the
 *   same names, §7.1);
 * - `record`: for a record-changing event, the protobuf JSON of the whole
 *   `MemberRecord` after the event, without `issued_at`, `not_after` and
 *   `authority_incarnation` (the signer adds those), so a projection replays
 *   the registry by taking the last `record` of each stream.
 *
 * Nothing secret is ever written: tokens only as their SHA-256, refresh
 * nonces only as their SHA-256, credentials only as the ticket id.
 */
import { create, fromBinary, fromJson, toJson } from "@bufbuild/protobuf";
import type { EventEnvelope, EventInput, JsonObject } from "@hobo/core";
import {
	type BootstrapTokenRecord,
	BootstrapTokenRecordSchema,
	type MemberRecord,
	MemberRecordSchema,
	TrustRecordSchema,
} from "../_generated/fleet_pb.js";
import { FLEET_TRUST_STREAM, type FleetEventType } from "../events.js";
import { type MemberId, parseMemberId } from "../ids.js";
import {
	type FieldValue,
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	pbJson,
} from "./json.js";

const MEMBER_STREAM = "fleet-member-";
const TOKEN_STREAM = "fleet-token-";
const THUMBPRINT_STREAM = "fleet-thumbprint-";

export function memberStream(id: MemberId): string {
	return `${MEMBER_STREAM}${id}`;
}
export function tokenStream(hash: string): string {
	return `${TOKEN_STREAM}${hash}`;
}
export function thumbprintStream(thumbprint: string): string {
	return `${THUMBPRINT_STREAM}${thumbprint}`;
}
export function memberSubject(id: MemberId): string {
	return `member.${id}`;
}

/** Events that change the member record, and so the registry (§6.14). */
const RECORD_EVENTS: ReadonlySet<FleetEventType> = new Set<FleetEventType>([
	"fleet.EnrollmentRequested",
	"fleet.MemberDeclared",
	"fleet.KeyApproved",
	"fleet.EnrollmentAccepted",
	"fleet.EnrollmentRejected",
	"fleet.MemberActivated",
	"fleet.MembershipAssigned",
	"fleet.KeysRotated",
	"fleet.IdentityKeyRotated",
	"fleet.MemberSuspended",
	"fleet.MemberResumed",
	"fleet.MemberLocked",
	"fleet.MemberUnlocked",
	"fleet.MemberRevoked",
]);

export function changesRecord(type: FleetEventType): boolean {
	return RECORD_EVENTS.has(type);
}

/** The record as it is journalled: no signing-time fields. */
function journalled(record: MemberRecord): MemberRecord {
	return create(MemberRecordSchema, {
		...record,
		issuedAt: "",
		notAfter: "",
		authorityIncarnation: 0,
	});
}

/** A record-changing member event: the record after it, with the next record_sequence. */
export function memberEvent(
	type: FleetEventType,
	record: MemberRecord,
	extra: Readonly<Record<string, FieldValue>> = {},
): EventInput<JsonObject> {
	const id = parseMemberId(record.memberId);
	return {
		type,
		data: {
			...extra,
			subject: memberSubject(id),
			subjectSequence: record.recordSequence,
			record: pbJson(toJson(MemberRecordSchema, journalled(record))),
		},
	};
}

/** A member-stream event that leaves the record as it is (CredentialsIssued, ViolationReported). */
export function memberFact(
	type: FleetEventType,
	id: MemberId,
	extra: Readonly<Record<string, FieldValue>>,
): EventInput<JsonObject> {
	return {
		type,
		data: { ...extra, subject: memberSubject(id), subjectSequence: 0 },
	};
}

/** A token- or thumbprint-stream event. */
export function streamFact(
	type: FleetEventType,
	stream: string,
	extra: Readonly<Record<string, FieldValue>>,
): EventInput<JsonObject> {
	return { type, data: { ...extra, subject: stream, subjectSequence: 0 } };
}

export function tokenIssued(
	record: BootstrapTokenRecord,
	ownerAliases: readonly string[],
): EventInput<JsonObject> {
	return streamFact("fleet.TokenIssued", tokenStream(record.tokenHash), {
		tokenHash: record.tokenHash,
		record: pbJson(toJson(BootstrapTokenRecordSchema, record)),
		ownerAliases: [...ownerAliases],
	});
}

// ── The fold ───────────────────────────────────────────────────────────────

/** The last refresh the authority answered (§6.5): generation it handed out and the nonce's digest. */
export type LastAnswer = Readonly<{ generation: number; nonceDigest: string }>;

export type MemberState = Readonly<{
	seq: number;
	record: MemberRecord;
	generation: number;
	last: LastAnswer | undefined;
	tokenHash: string;
	tokenExpiresAtMs: number | undefined;
	violations: readonly Readonly<{ at: string; kind: string }>[];
}>;

export type TokenState = Readonly<{
	seq: number;
	record: BootstrapTokenRecord;
	ownerAliases: readonly string[];
	revoked: boolean;
	consumedThumbprint: string;
}>;

export type ThumbprintState = Readonly<{ seq: number; memberId: MemberId }>;

/** Everything the lane folds from its streams. One per authority instance; rebuilt by replay. */
export type MembershipIndex = {
	readonly members: Map<MemberId, MemberState>;
	readonly tokens: Map<string, TokenState>;
	readonly thumbprints: Map<string, ThumbprintState>;
	/**
	 * When each authority incarnation after the first began (epoch ms): the
	 * `issued_at` of the earliest journalled `fleet.TrustRotated` record that
	 * names it, counted only when it raised the incarnation (it is above 1, the
	 * genesis incarnation, or above a record journalled before it).
	 */
	readonly incarnations: Map<number, number>;
	/** The lowest incarnation any journalled trust record has named. */
	lowestIncarnation: number | undefined;
};

/** The genesis trust record's incarnation (the ceremony and every fixture start at 1). */
const GENESIS_INCARNATION = 1;

export function emptyIndex(): MembershipIndex {
	return {
		members: new Map(),
		tokens: new Map(),
		thumbprints: new Map(),
		incarnations: new Map(),
		lowestIncarnation: undefined,
	};
}

function text(data: JsonObject, field: string): string {
	const value = data[field];
	return isJsonString(value) ? value : "";
}

function count(data: JsonObject, field: string): number {
	const value = data[field];
	return isJsonNumber(value) ? value : 0;
}

function texts(data: JsonObject, field: string): string[] {
	const value = data[field];
	return isJsonArray(value) ? value.filter((item) => isJsonString(item)) : [];
}

function recordOf(data: JsonObject): MemberRecord | undefined {
	const value = data.record;
	if (!isJsonObject(value)) return undefined;
	return fromJson(MemberRecordSchema, value, { ignoreUnknownFields: true });
}

/** Applies one journal event to the index. Deterministic: replay gives live state. */
export function applyEvent(index: MembershipIndex, event: EventEnvelope): void {
	const data = isJsonObject(event.data) ? event.data : {};
	if (event.streamId.startsWith(MEMBER_STREAM)) {
		applyMember(index, event, data);
		return;
	}
	if (event.streamId.startsWith(TOKEN_STREAM)) {
		applyToken(index, event, data);
		return;
	}
	if (event.streamId === FLEET_TRUST_STREAM) {
		if (event.type === "fleet.TrustRotated") applyTrust(index, data);
		return;
	}
	if (event.streamId.startsWith(THUMBPRINT_STREAM)) {
		const thumbprint = event.streamId.slice(THUMBPRINT_STREAM.length);
		const member = text(data, "memberId");
		if (event.type === "fleet.ThumbprintBound" && member.length > 0)
			index.thumbprints.set(thumbprint, {
				seq: event.seq,
				memberId: parseMemberId(member),
			});
	}
}

function applyTrust(index: MembershipIndex, data: JsonObject): void {
	const encoded = data.record;
	if (!isJsonString(encoded)) return;
	let incarnation: number;
	let issuedAtMs: number;
	try {
		const record = fromBinary(
			TrustRecordSchema,
			new Uint8Array(Buffer.from(encoded, "base64")),
		);
		incarnation = record.authorityIncarnation;
		issuedAtMs = Date.parse(record.issuedAt);
	} catch {
		return;
	}
	const lowest = index.lowestIncarnation;
	const raised =
		incarnation > GENESIS_INCARNATION ||
		(lowest !== undefined && incarnation > lowest);
	if (
		raised &&
		!index.incarnations.has(incarnation) &&
		!Number.isNaN(issuedAtMs)
	)
		index.incarnations.set(incarnation, issuedAtMs);
	if (lowest === undefined || incarnation < lowest)
		index.lowestIncarnation = incarnation;
}

function applyMember(
	index: MembershipIndex,
	event: EventEnvelope,
	data: JsonObject,
): void {
	let id: MemberId;
	try {
		id = parseMemberId(event.streamId.slice(MEMBER_STREAM.length));
	} catch {
		return;
	}
	const previous = index.members.get(id);
	const record = recordOf(data) ?? previous?.record;
	if (record === undefined) return;
	let generation = previous?.generation ?? 0;
	let last = previous?.last;
	let violations = previous?.violations ?? [];
	let tokenHash = previous?.tokenHash ?? "";
	let tokenExpiresAtMs = previous?.tokenExpiresAtMs;
	switch (event.type) {
		case "fleet.EnrollmentRequested": {
			tokenHash = text(data, "tokenHash");
			const expires = Date.parse(text(data, "tokenExpiresAt"));
			tokenExpiresAtMs = Number.isNaN(expires) ? undefined : expires;
			break;
		}
		case "fleet.MemberActivated":
		case "fleet.MemberUnlocked":
			generation = 0;
			last = undefined;
			break;
		case "fleet.CredentialsIssued":
			generation = count(data, "generation");
			last = { generation, nonceDigest: text(data, "nonceDigest") };
			break;
		case "fleet.ViolationReported":
			violations = [...violations, { at: event.ts, kind: text(data, "kind") }];
			break;
		default:
			break;
	}
	index.members.set(id, {
		seq: event.seq,
		record,
		generation,
		last,
		tokenHash,
		tokenExpiresAtMs,
		violations,
	});
}

function applyToken(
	index: MembershipIndex,
	event: EventEnvelope,
	data: JsonObject,
): void {
	const hash = event.streamId.slice(TOKEN_STREAM.length);
	const previous = index.tokens.get(hash);
	if (event.type === "fleet.TokenIssued") {
		const value = data.record;
		if (!isJsonObject(value)) return;
		index.tokens.set(hash, {
			seq: event.seq,
			record: fromJson(BootstrapTokenRecordSchema, value, {
				ignoreUnknownFields: true,
			}),
			ownerAliases: texts(data, "ownerAliases"),
			revoked: false,
			consumedThumbprint: "",
		});
		return;
	}
	if (previous === undefined) return;
	if (event.type === "fleet.TokenConsumed")
		index.tokens.set(hash, {
			...previous,
			seq: event.seq,
			record: create(BootstrapTokenRecordSchema, {
				...previous.record,
				consumedBy: text(data, "memberId"),
			}),
			consumedThumbprint: text(data, "thumbprint"),
		});
	else if (event.type === "fleet.TokenRevoked")
		index.tokens.set(hash, { ...previous, seq: event.seq, revoked: true });
}
