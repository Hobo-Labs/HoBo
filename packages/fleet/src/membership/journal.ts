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

function journalled(record: MemberRecord): MemberRecord {
	return create(MemberRecordSchema, {
		...record,
		issuedAt: "",
		notAfter: "",
		authorityIncarnation: 0,
	});
}

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

export type MembershipIndex = {
	readonly members: Map<MemberId, MemberState>;
	readonly tokens: Map<string, TokenState>;
	readonly thumbprints: Map<string, ThumbprintState>;
	readonly incarnations: Map<number, number>;
	lowestIncarnation: number | undefined;
};

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
