/**
 * A tenant for unit tests: an authority and a witness key, the witnessed
 * trust record, and helpers that sign member records and session tickets
 * the way the authority does, published on an in-memory wire.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { clone, create, toBinary } from "@bufbuild/protobuf";
import {
	type AuthorityBus,
	type DeviceKeys,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	MEMBER_RECORD_CONTEXT,
	type MemberId,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
	PublicKeyRefSchema,
	parseKeyId,
	parseMemberId,
	Role,
	SESSION_TICKET_CONTEXT,
	SessionTicketSchema,
	type SignedEnvelope,
	type Signer,
	TRUST_RECORD_CONTEXT,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { createMemoryKeyStore, signEnvelope } from "@hobo/fleet/keys";
import { authorityBusOverWire } from "../../src/bus/fleet-bus.js";
import {
	authorityPin,
	createRegistryView,
} from "../../src/bus/registry-view.js";
import { createMemoryNats, type MemoryNats } from "./memory-wire.js";

export const TENANT = "acme";
export const INCARNATION = 3;
const MINUTE = 60_000;

type SuiteSigner = Readonly<{ signer: Signer; raw: string }>;

function suiteSigner(keyId: string): SuiteSigner {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const x = publicKey.export({ format: "jwk" }).x ?? "";
	return {
		raw: x,
		signer: {
			keyId: parseKeyId(keyId),
			algorithm: KeyAlgorithm.EDDSA,
			async sign(bytes) {
				return new Uint8Array(sign(null, bytes, privateKey));
			},
		},
	};
}

export type Tenant = Readonly<{
	bus: AuthorityBus;
	trust: WitnessedEnvelope;
	now: () => number;
	setNow(ms: number): void;
	authority: Signer;
	/** The witness key the trust record pins. */
	witness: Signer;
	device(
		options?: Readonly<{
			roles?: Role[];
			state?: MemberState;
			tenant?: string;
		}>,
	): Promise<DeviceKeys>;
	/** Re-signs a device's record with `change` applied and `record_sequence` one higher, and publishes it. */
	update(
		memberId: MemberId,
		change: (record: MemberRecord) => void,
	): Promise<MemberRecord>;
	ticket(
		keys: DeviceKeys,
		options?: Readonly<{
			expiresInMs?: number;
			incarnation?: number;
			tenant?: string;
			signer?: Signer;
		}>,
	): Promise<SignedEnvelope>;
}>;

export type MemoryTenant = Tenant & Readonly<{ nats: MemoryNats }>;

/** A tenant on an in-memory bus. */
export async function createTenant(): Promise<MemoryTenant> {
	let clock = Date.now();
	const now = () => clock;
	const nats = createMemoryNats(now);
	const wire = nats.connect();
	const pin = authorityPin(() => {
		throw new Error("no trust record");
	});
	const bus = authorityBusOverWire(
		wire,
		createRegistryView({ wire, pin, now }),
		pin,
		now,
	);
	const tenant = await createTenantOn(bus, now, (ms) => {
		clock = ms;
	});
	return { ...tenant, nats };
}

/** A tenant whose authority publishes on `bus`: its trust record is published first. */
export async function createTenantOn(
	bus: AuthorityBus,
	now: () => number,
	setNow: (ms: number) => void = () => undefined,
): Promise<Tenant> {
	const clock = now();
	const authority = suiteSigner("authority#1");
	const witness = suiteSigner("witness#1");
	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: TENANT,
			sequence: 1,
			authorityKeys: [
				create(PublicKeyRefSchema, {
					purpose: KeyPurpose.AUTHORITY,
					keyId: "authority#1",
					algorithm: KeyAlgorithm.EDDSA,
					value: authority.raw,
				}),
			],
			witnessKeys: [
				create(PublicKeyRefSchema, {
					purpose: KeyPurpose.WITNESS,
					keyId: "witness#1",
					algorithm: KeyAlgorithm.EDDSA,
					value: witness.raw,
				}),
			],
			authorityIncarnation: INCARNATION,
			issuer: "https://authority.invalid",
			jwksUri: "https://authority.invalid/jwks",
			issuedAt: new Date(clock).toISOString(),
		}),
	);
	const trust = create(WitnessedEnvelopeSchema, {
		authority: await signEnvelope(
			authority.signer,
			TRUST_RECORD_CONTEXT,
			payload,
		),
		witness: await signEnvelope(witness.signer, TRUST_RECORD_CONTEXT, payload),
	});
	await bus.publisher.putTrust(trust);
	const records = new Map<string, MemberRecord>();
	const publish = async (record: MemberRecord) => {
		records.set(record.memberId, record);
		await bus.publisher.putMember(
			await signEnvelope(
				authority.signer,
				MEMBER_RECORD_CONTEXT,
				toBinary(MemberRecordSchema, record),
			),
			parseMemberId(record.memberId),
		);
	};

	return {
		bus,
		trust,
		now,
		setNow,
		authority: authority.signer,
		witness: witness.signer,
		async device(options = {}) {
			const keys = await createMemoryKeyStore().open();
			const bundle = await signEnvelope(
				keys.identity,
				KEY_BUNDLE_CONTEXT,
				toBinary(
					KeyBundleSchema,
					create(KeyBundleSchema, {
						memberId: keys.memberId,
						sequence: 1,
						keys: [
							create(PublicKeyRefSchema, {
								purpose: KeyPurpose.SIGN,
								keyId: keys.sign.keyId,
								algorithm: keys.sign.algorithm,
								value: keys.signPublicKey,
							}),
						],
						issuedAt: new Date(now()).toISOString(),
						notAfter: new Date(now() + 60 * MINUTE).toISOString(),
					}),
				),
			);
			const record = create(MemberRecordSchema, {
				memberId: keys.memberId,
				tenant: options.tenant ?? TENANT,
				kind: MemberKind.DEVICE,
				state: options.state ?? MemberState.ACTIVE,
				memberships: [
					create(MembershipSchema, {
						fleet: "builders",
						name: "box",
						roles: options.roles ?? [Role.EXECUTOR],
					}),
				],
				identityJwk: keys.identityJwk,
				keyBundle: bundle,
				recordSequence: 1,
				authorityIncarnation: INCARNATION,
				issuedAt: new Date(now()).toISOString(),
				notAfter: new Date(now() + 30 * MINUTE).toISOString(),
			});
			await publish(record);
			return keys;
		},
		async update(memberId, change) {
			const current = records.get(memberId);
			if (current === undefined) throw new Error(`no record for ${memberId}`);
			const next = clone(MemberRecordSchema, current);
			change(next);
			next.recordSequence = current.recordSequence + 1;
			await publish(next);
			return next;
		},
		async ticket(keys, options = {}) {
			return signEnvelope(
				options.signer ?? authority.signer,
				SESSION_TICKET_CONTEXT,
				toBinary(
					SessionTicketSchema,
					create(SessionTicketSchema, {
						ticketId: randomBytes(8).toString("hex"),
						memberId: keys.memberId,
						tenant: options.tenant ?? TENANT,
						issuedAt: new Date(now()).toISOString(),
						expiresAt: new Date(
							now() + (options.expiresInMs ?? 10 * MINUTE),
						).toISOString(),
						authorityIncarnation: options.incarnation ?? INCARNATION,
					}),
				),
			);
		},
	};
}
