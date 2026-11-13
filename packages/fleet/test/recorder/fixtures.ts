// Fixtures for the recorder and projection tests: an authority key and trust
// record on the memory bus, devices with identity-signed key bundles, signed
// work envelopes, a recording metering sink and a settle helper.
import { generateKeyPairSync, sign } from "node:crypto";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import {
	createMeteringBus,
	type EventInput,
	type JsonObject,
	type MeteringBus,
	parseTenantId,
	type TenantId,
	type UsageEvent,
} from "@hobo/core";
import {
	ClaimSchema,
	CoordinationMode,
	type FleetRecord,
	FleetRecordSchema,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
	type PublicKeyRef,
	PublicKeyRefSchema,
	ReceiptStatus,
	Role,
	SandboxTier,
	SessionCloseSchema,
	type SignedEnvelope,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
	WorkLogChunkSchema,
	WorkOfferSchema,
	WorkOrderSchema,
	WorkReceiptSchema,
	WorkSubmissionSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	CLAIM_CONTEXT,
	FLEET_RECORD_CONTEXT,
	KEY_BUNDLE_CONTEXT,
	LOG_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	OFFER_CONTEXT,
	ORDER_CONTEXT,
	RECEIPT_CONTEXT,
	SESSION_CLOSE_CONTEXT,
	TRUST_RECORD_CONTEXT,
	WORK_SUBMISSION_CONTEXT,
} from "../../src/contexts.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseKeyId,
	parseWorkDigest,
	type WorkDigest,
} from "../../src/ids.js";
import { createMemoryKeyStore, signEnvelope } from "../../src/keys/index.js";
import type {
	AuthorityBus,
	DeviceKeys,
	FleetEventStore,
	FleetLogEvent,
	Signer,
} from "../../src/ports.js";
import {
	createMemoryBus,
	createMemoryEventStore,
} from "../../src/testing/plumbing/index.js";

export const START = Date.parse("2026-11-13T12:00:00.000Z");
export const TENANT: TenantId = parseTenantId("acme");
export const FLEET: FleetId = parseFleetId("hobo");
export const DIGEST: WorkDigest = parseWorkDigest(
	"0123456789abcdef0123456789abcdef",
);
export const iso = (ms: number): string => new Date(ms).toISOString();

/** A clock the test moves by hand. */
export type TestClock = { (): number; ms: number; advance(ms: number): void };
export function testClock(start = START): TestClock {
	// SAFETY: `ms` and `advance` are assigned on the next lines, before the clock is returned.
	const clock = (() => clock.ms) as TestClock;
	clock.ms = start;
	clock.advance = (ms) => {
		clock.ms += ms;
	};
	return clock;
}

export type AuthorityKey = Readonly<{ signer: Signer; ref: PublicKeyRef }>;

export function authorityKey(): AuthorityKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const id = parseKeyId("authority#1");
	return {
		signer: {
			keyId: id,
			algorithm: KeyAlgorithm.EDDSA,
			async sign(bytes) {
				return new Uint8Array(sign(null, bytes, privateKey));
			},
		},
		ref: create(PublicKeyRefSchema, {
			purpose: KeyPurpose.AUTHORITY,
			keyId: id,
			algorithm: KeyAlgorithm.EDDSA,
			value: publicKey.export({ format: "jwk" }).x ?? "",
		}),
	};
}

export type LogLine = Readonly<{
	event: FleetLogEvent;
	fields: Readonly<Record<string, string | number | boolean>>;
}>;

export type World = Readonly<{
	clock: TestClock;
	bus: AuthorityBus;
	store: FleetEventStore;
	authority: AuthorityKey;
	metering: MeteringBus;
	usage: UsageEvent[];
	logs: LogLine[];
	log(
		event: FleetLogEvent,
		fields: Readonly<Record<string, string | number | boolean>>,
	): void;
}>;

export async function world(): Promise<World> {
	const clock = testClock();
	const bus = createMemoryBus(clock);
	const store = createMemoryEventStore();
	const authority = authorityKey();
	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: TENANT,
			sequence: 1,
			authorityKeys: [authority.ref],
			authorityIncarnation: 1,
			issuedAt: iso(START),
		}),
	);
	const signed = await signEnvelope(
		authority.signer,
		TRUST_RECORD_CONTEXT,
		payload,
	);
	await bus.publisher.putTrust(
		create(WitnessedEnvelopeSchema, { authority: signed, witness: signed }),
	);
	const usage: UsageEvent[] = [];
	const metering = createMeteringBus([
		{ sinkId: "test", emit: (event) => void usage.push(event) },
	]);
	const logs: LogLine[] = [];
	return {
		clock,
		bus,
		store,
		authority,
		metering,
		usage,
		logs,
		log: (event, fields) => void logs.push({ event, fields }),
	};
}

/** A second bus over the same clock and trust: the buckets deleted. */
export async function freshBus(of: World): Promise<AuthorityBus> {
	const bus = createMemoryBus(of.clock);
	const trust = of.bus.registry.trustEnvelope();
	if (trust !== undefined) await bus.publisher.putTrust(trust);
	return bus;
}

export type Device = Readonly<{ keys: DeviceKeys; record: MemberRecord }>;

export async function device(
	roles: readonly Role[] = [Role.EXECUTOR],
	name = "box",
): Promise<Device> {
	const keys = await createMemoryKeyStore().open();
	const bundle = create(KeyBundleSchema, {
		memberId: keys.memberId,
		sequence: 1,
		keys: [
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.SIGN,
				keyId: keys.sign.keyId,
				algorithm: KeyAlgorithm.EDDSA,
				value: keys.signPublicKey,
			}),
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.SEAL,
				keyId: `${keys.memberId}#seal`,
				value: keys.sealPublicKey,
			}),
		],
		issuedAt: iso(START - 3_600_000),
		notAfter: iso(START + 48 * 3_600_000),
	});
	const record = create(MemberRecordSchema, {
		memberId: keys.memberId,
		tenant: TENANT,
		kind: MemberKind.DEVICE,
		displayName: name,
		state: MemberState.ACTIVE,
		memberships: [
			create(MembershipSchema, { fleet: FLEET, name, roles: [...roles] }),
		],
		identityJwk: keys.identityJwk,
		keyBundle: await signEnvelope(
			keys.identity,
			KEY_BUNDLE_CONTEXT,
			toBinary(KeyBundleSchema, bundle),
		),
		recordSequence: 1,
		stateChangedAt: iso(START),
	});
	return { keys, record };
}

/** Puts a member record on the bus, signed and valid for 30 minutes from now. */
export async function publishMember(
	at: World,
	record: MemberRecord,
): Promise<void> {
	const now = at.clock();
	const signed = create(MemberRecordSchema, {
		...record,
		issuedAt: iso(now),
		notAfter: iso(now + 30 * 60_000),
	});
	await at.bus.publisher.putMember(
		await signEnvelope(
			at.authority.signer,
			MEMBER_RECORD_CONTEXT,
			toBinary(MemberRecordSchema, signed),
		),
		// SAFETY: fixtures build member ids from the key store.
		record.memberId as MemberId,
	);
}

export async function publishFleet(
	at: World,
	record: FleetRecord,
): Promise<void> {
	const now = at.clock();
	await at.bus.publisher.putFleet(
		await signEnvelope(
			at.authority.signer,
			FLEET_RECORD_CONTEXT,
			toBinary(
				FleetRecordSchema,
				create(FleetRecordSchema, {
					...record,
					issuedAt: iso(now),
					notAfter: iso(now + 30 * 60_000),
				}),
			),
		),
		parseFleetId(record.fleetId),
	);
}

export function fleetRecord(revision = 1, labels = ["hobo"]): FleetRecord {
	return create(FleetRecordSchema, {
		fleetId: FLEET,
		tenant: TENANT,
		owner: "user:alice",
		coordination: CoordinationMode.MANY_ACTIVE,
		policy: { labels },
		revision,
		updatedAt: iso(START),
		updatedBy: "user:alice",
	});
}

export async function submissionEnvelope(
	at: World,
	submissionId: string,
): Promise<SignedEnvelope> {
	return signEnvelope(
		at.authority.signer,
		WORK_SUBMISSION_CONTEXT,
		toBinary(
			WorkSubmissionSchema,
			create(WorkSubmissionSchema, {
				submissionId,
				tenant: TENANT,
				fleet: FLEET,
				author: "user:alice",
				image: "alpine",
				submittedAt: iso(START),
				expiresAt: iso(START + 3_600_000),
			}),
		),
	);
}

export async function offer(
	dispatcher: Device,
	options: Readonly<{ digest?: string; submission?: SignedEnvelope }> = {},
): Promise<SignedEnvelope> {
	const message = create(WorkOfferSchema, {
		workKey: "job-1",
		workDigest: options.digest ?? DIGEST,
		kind: "oci-command",
		fleet: FLEET,
		label: "hobo",
		dispatcher: dispatcher.keys.memberId,
		queuedAt: iso(START),
		expiresAt: iso(START + 15 * 60_000),
	});
	message.submission = options.submission;
	return signEnvelope(
		dispatcher.keys.sign,
		OFFER_CONTEXT,
		toBinary(WorkOfferSchema, message),
	);
}

export async function claim(
	executor: Device,
	dispatcher: Device,
): Promise<SignedEnvelope> {
	return signEnvelope(
		executor.keys.sign,
		CLAIM_CONTEXT,
		toBinary(
			ClaimSchema,
			create(ClaimSchema, {
				workDigest: DIGEST,
				fleet: FLEET,
				memberId: executor.keys.memberId,
				dispatcher: dispatcher.keys.memberId,
				rank: 0,
				sandboxTier: SandboxTier.S1_CONTAINER,
				claimedAt: iso(START + 1_000),
			}),
		),
	);
}

export const ORDER_ID = "aa".repeat(16);

export async function order(
	dispatcher: Device,
	executor: Device,
	orderId = ORDER_ID,
): Promise<SignedEnvelope> {
	return signEnvelope(
		dispatcher.keys.sign,
		ORDER_CONTEXT,
		toBinary(
			WorkOrderSchema,
			create(WorkOrderSchema, {
				orderId,
				offer: create(WorkOfferSchema, {
					workKey: "job-1",
					workDigest: DIGEST,
					kind: "oci-command",
					fleet: FLEET,
					dispatcher: dispatcher.keys.memberId,
				}),
				memberId: executor.keys.memberId,
				sandboxTier: SandboxTier.S1_CONTAINER,
				parameters: { image: "alpine" },
				secret: {
					recipientKeyId: `${executor.keys.memberId}#seal`,
					ephemeralPublicKey: "secret-material",
					nonce: new Uint8Array(12),
					ciphertext: new Uint8Array([1, 2, 3]),
				},
				issuedAt: iso(START + 2_000),
				expiresAt: iso(START + 15 * 60_000),
			}),
		),
	);
}

export async function receipt(
	executor: Device,
	status: ReceiptStatus,
	options: Readonly<{
		at?: number;
		sandboxSeconds?: number;
		orderId?: string;
	}> = {},
): Promise<SignedEnvelope> {
	return signEnvelope(
		executor.keys.sign,
		RECEIPT_CONTEXT,
		toBinary(
			WorkReceiptSchema,
			create(WorkReceiptSchema, {
				orderId: options.orderId ?? ORDER_ID,
				workDigest: DIGEST,
				memberId: executor.keys.memberId,
				status,
				at: iso(options.at ?? START + 3_000),
				sandboxTier: SandboxTier.S1_CONTAINER,
				sandboxSeconds: options.sandboxSeconds ?? 0,
				outputDigest: status === ReceiptStatus.SUCCEEDED ? "sha256:00ff" : "",
			}),
		),
	);
}

export async function logChunk(
	executor: Device,
	sequence: number,
	text: string,
	last = false,
): Promise<SignedEnvelope> {
	return signEnvelope(
		executor.keys.sign,
		LOG_CONTEXT,
		toBinary(
			WorkLogChunkSchema,
			create(WorkLogChunkSchema, {
				orderId: ORDER_ID,
				sequence,
				data: new TextEncoder().encode(text),
				last,
			}),
		),
	);
}

export async function sessionClose(
	member: Device,
	sessionId: string,
	transport: string,
	sent: number,
	received: number,
): Promise<SignedEnvelope> {
	return signEnvelope(
		member.keys.sign,
		SESSION_CLOSE_CONTEXT,
		toBinary(
			SessionCloseSchema,
			create(SessionCloseSchema, {
				sessionId,
				memberId: member.keys.memberId,
				transport,
				bytesSent: BigInt(sent),
				bytesReceived: BigInt(received),
				at: iso(START + 10_000),
			}),
		),
	);
}

/** Every event in the store, in append order. */
export async function allEvents(store: FleetEventStore) {
	const out = [];
	for await (const positioned of store.readAll()) out.push(positioned.event);
	return out;
}

/** Lets queued deliveries and the recorder's chain run until the store stops growing. */
export async function settle(store: FleetEventStore): Promise<void> {
	let last = -1;
	let stable = 0;
	while (stable < 5) {
		for (let i = 0; i < 10; i += 1)
			await new Promise<void>((resolve) => setImmediate(resolve));
		const count = (await allEvents(store)).length;
		stable = count === last ? stable + 1 : 0;
		last = count;
	}
}

export const SERVICE = { kind: "service", id: "test" } as const;

/** Appends events as another lane would (L02 members, L32 fleets and submissions, grants). */
export async function appendAs(
	store: FleetEventStore,
	stream: string,
	events: readonly EventInput<JsonObject>[],
): Promise<void> {
	let head = 0;
	for await (const event of store.read(stream)) head = event.seq;
	await store.append(stream, [...events], {
		expectedSeq: head,
		actor: SERVICE,
		tenant: TENANT,
	});
}

/** A record-changing member event in L02's shape (journal.ts). */
export function memberEvent(
	type: string,
	record: MemberRecord,
): EventInput<JsonObject> {
	return {
		type,
		data: {
			subject: `member.${record.memberId}`,
			subjectSequence: record.recordSequence,
			// SAFETY: protobuf JSON of a message is a JSON object.
			record: toJson(MemberRecordSchema, record) as JsonObject,
		},
	};
}

/** A fleet event in the shape this lane reads (data.record, as L02 does for members). */
export function fleetEvent(
	type: string,
	record: FleetRecord,
): EventInput<JsonObject> {
	return {
		type,
		data: {
			subject: `fleet.${record.fleetId}`,
			subjectSequence: record.revision,
			// SAFETY: protobuf JSON of a message is a JSON object.
			record: toJson(FleetRecordSchema, record) as JsonObject,
		},
	};
}

export { ReceiptStatus, Role };
