/**
 * Records for the work kind's tests, built only from `@hobo/fleet`'s public
 * entry points: devices from the in-memory key store with signed key bundles
 * and member records, a many-active fleet whose policy admits `acme/app`, an
 * authority key, observations, and a helper that puts them on a bus.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type AuthorityBus,
	CapacitySchema,
	type CapacitySource,
	CoordinationMode,
	DeviceClass,
	type DeviceKeys,
	type EgressProxyFactory,
	FLEET_RECORD_CONTEXT,
	type FleetPolicy,
	FleetPolicySchema,
	type FleetRecord,
	FleetRecordSchema,
	Health,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	type KeyStore,
	MEMBER_RECORD_CONTEXT,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	OBSERVATION_CONTEXT,
	ObservationSchema,
	type PublicKeyRef,
	PublicKeyRefSchema,
	parseFleetId,
	parseKeyId,
	parseMemberId,
	type Role,
	SandboxTier,
	type Signer,
	TRUST_RECORD_CONTEXT,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { createMemoryKeyStore, signEnvelope } from "@hobo/fleet/keys";

export const FLEET = "hobo";
const DAY = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

export type Device = Readonly<{
	keys: DeviceKeys;
	store: KeyStore;
	record: MemberRecord;
}>;

export async function device(
	roles: readonly Role[],
	nowMs: number,
	deviceClass: DeviceClass = DeviceClass.EPHEMERAL,
): Promise<Device> {
	const store = createMemoryKeyStore();
	const keys = await store.open();
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
						keyId: `${keys.memberId}#sign`,
						algorithm: KeyAlgorithm.EDDSA,
						value: keys.signPublicKey,
					}),
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SEAL,
						keyId: `${keys.memberId}#seal`,
						value: keys.sealPublicKey,
					}),
				],
				issuedAt: iso(nowMs - 3_600_000),
				notAfter: iso(nowMs + 30 * DAY),
			}),
		),
	);
	const record = create(MemberRecordSchema, {
		memberId: keys.memberId,
		tenant: "acme",
		kind: MemberKind.DEVICE,
		displayName: "device",
		state: MemberState.ACTIVE,
		memberships: [{ fleet: FLEET, name: "box", roles: [...roles] }],
		deviceClass,
		identityJwk: keys.identityJwk,
		keyBundle: bundle,
		platform: { os: "linux", arch: "x64" },
		agentVersion: "1.0.0",
		owner: "github:1",
		ownerAliases: ["github:1"],
		recordSequence: 1,
		issuedAt: iso(nowMs),
		notAfter: iso(nowMs + 30 * DAY),
	});
	return { keys, store, record };
}

/** Admits `acme/app` on main and on pull-request merge refs. */
export function policy(): FleetPolicy {
	return create(FleetPolicySchema, {
		repositories: [
			{
				repository: "acme/app",
				refs: ["refs/heads/main", "refs/pull/*/merge"],
			},
		],
	});
}

export function fleetRecord(nowMs: number): FleetRecord {
	return create(FleetRecordSchema, {
		fleetId: FLEET,
		tenant: "acme",
		coordination: CoordinationMode.MANY_ACTIVE,
		policy: policy(),
		revision: 1,
		issuedAt: iso(nowMs),
		notAfter: iso(nowMs + 30 * DAY),
	});
}

export type AuthorityKey = Readonly<{ signer: Signer; ref: PublicKeyRef }>;

export function authorityKey(): AuthorityKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyId = parseKeyId("authority#1");
	return {
		signer: {
			keyId,
			algorithm: KeyAlgorithm.EDDSA,
			async sign(bytes) {
				return new Uint8Array(signBytes(null, bytes, privateKey));
			},
		},
		ref: create(PublicKeyRefSchema, {
			purpose: KeyPurpose.AUTHORITY,
			keyId,
			algorithm: KeyAlgorithm.EDDSA,
			value: publicKey.export({ format: "jwk" }).x ?? "",
		}),
	};
}

/** Puts the trust, member and fleet records on the memory bus. */
export async function seed(
	bus: AuthorityBus,
	authority: AuthorityKey,
	members: readonly MemberRecord[],
	fleet: FleetRecord,
): Promise<void> {
	const trust = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: "acme",
			sequence: 1,
			authorityKeys: [authority.ref],
		}),
	);
	await bus.publisher.putTrust(
		create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(
				authority.signer,
				TRUST_RECORD_CONTEXT,
				trust,
			),
			witness: await signEnvelope(
				authority.signer,
				TRUST_RECORD_CONTEXT,
				trust,
			),
		}),
	);
	for (const member of members)
		await bus.publisher.putMember(
			await signEnvelope(
				authority.signer,
				MEMBER_RECORD_CONTEXT,
				toBinary(MemberRecordSchema, member),
			),
			parseMemberId(member.memberId),
		);
	await bus.publisher.putFleet(
		await signEnvelope(
			authority.signer,
			FLEET_RECORD_CONTEXT,
			toBinary(FleetRecordSchema, fleet),
		),
		parseFleetId(fleet.fleetId),
	);
}

/** The executor's own signed observation of itself: reachable, one slot, S1. */
export async function observe(
	bus: Pick<AuthorityBus, "observations">,
	of: Device,
	nowMs: number,
): Promise<void> {
	const envelope = await signEnvelope(
		of.keys.sign,
		OBSERVATION_CONTEXT,
		toBinary(
			ObservationSchema,
			create(ObservationSchema, {
				memberId: of.keys.memberId,
				observerId: of.keys.memberId,
				fleets: [FLEET],
				health: Health.REACHABLE,
				capacity: {
					freeSlots: 1,
					totalSlots: 1,
					freeMemoryMb: 65_536,
					freeDiskMb: 262_144,
				},
				labels: ["hobo"],
				platform: { os: "linux", arch: "x64" },
				sandboxTiers: [SandboxTier.S1_CONTAINER],
				agentVersion: "1.0.0",
				issuedAt: iso(nowMs),
				validUntil: iso(nowMs + 50_000),
			}),
		),
	);
	await bus.observations.publish(envelope, of.keys.memberId, of.keys.memberId);
}

export function oneSlot(): CapacitySource {
	return {
		async read() {
			return {
				capacity: create(CapacitySchema, {
					freeSlots: 1,
					totalSlots: 1,
					freeMemoryMb: 65_536,
					freeDiskMb: 262_144,
				}),
				health: Health.REACHABLE,
				labels: ["hobo"],
			};
		},
	};
}

export function noEgress(): EgressProxyFactory & { opened: string[][] } {
	const opened: string[][] = [];
	return {
		opened,
		async open(allow) {
			opened.push([...allow]);
			return { url: "http://proxy.invalid:3128", async close() {} };
		},
	};
}
