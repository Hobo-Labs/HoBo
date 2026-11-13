// Test fixtures for the observation lane: device keys from the in-memory key
// store, their signed key bundles, member records, and a registry double
// built against the frozen `RegistryView` port (rule 6).
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type FleetRecord,
	FleetRecordSchema,
	type FleetView,
	Health,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
	type Observation,
	ObservationSchema,
	PlatformSchema,
	PublicKeyRefSchema,
	type SignedEnvelope,
	TrustRecordSchema,
} from "../../src/_generated/fleet_pb.js";
import { KEY_BUNDLE_CONTEXT } from "../../src/contexts.js";
import { type FleetId, type MemberId, parseFleetId } from "../../src/ids.js";
import { createMemoryKeyStore, signEnvelope } from "../../src/keys/index.js";
import type { DeviceKeys, RegistryView } from "../../src/ports.js";

/** An observation's init fields (not a built message), for overrides. */
export type ObservationInit = Exclude<
	Parameters<typeof create<typeof ObservationSchema>>[1],
	Observation | undefined
>;
/** A member record's init fields, for overrides. */
export type MemberRecordInit = Exclude<
	Parameters<typeof create<typeof MemberRecordSchema>>[1],
	MemberRecord | undefined
>;

export const NOW = Date.parse("2026-11-13T12:00:00.000Z");
export const FLEET: FleetId = parseFleetId("hobo");

export const iso = (ms: number): string => new Date(ms).toISOString();

export async function deviceKeys(): Promise<DeviceKeys> {
	return createMemoryKeyStore().open();
}

/** The key bundle a device signs with its identity key (§6.4). */
export async function keyBundle(
	keys: DeviceKeys,
	notAfterMs = NOW + 24 * 3_600_000,
	signKeyOf: DeviceKeys = keys,
): Promise<SignedEnvelope> {
	const bundle = create(KeyBundleSchema, {
		memberId: keys.memberId,
		sequence: 1,
		keys: [
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.SIGN,
				keyId: `${keys.memberId}#sign`,
				algorithm: KeyAlgorithm.EDDSA,
				value: signKeyOf.signPublicKey,
			}),
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.SEAL,
				keyId: `${keys.memberId}#seal`,
				value: keys.sealPublicKey,
			}),
		],
		issuedAt: iso(NOW - 3_600_000),
		notAfter: iso(notAfterMs),
	});
	return signEnvelope(
		keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(KeyBundleSchema, bundle),
	);
}

export async function deviceRecord(
	keys: DeviceKeys,
	overrides: MemberRecordInit = {},
): Promise<MemberRecord> {
	return create(MemberRecordSchema, {
		memberId: keys.memberId,
		tenant: "acme",
		kind: MemberKind.DEVICE,
		displayName: "box",
		state: MemberState.ACTIVE,
		memberships: [
			create(MembershipSchema, { fleet: FLEET, name: "box", roles: [] }),
		],
		identityJwk: keys.identityJwk,
		keyBundle: await keyBundle(keys),
		...overrides,
	});
}

export function sponsoredRecord(
	memberId: string,
	sponsor: string,
	overrides: MemberRecordInit = {},
): MemberRecord {
	return create(MemberRecordSchema, {
		memberId,
		tenant: "acme",
		kind: MemberKind.BACKEND,
		displayName: "cache",
		state: MemberState.ACTIVE,
		memberships: [create(MembershipSchema, { fleet: FLEET, name: "cache" })],
		sponsor,
		...overrides,
	});
}

export function observation(
	memberId: string,
	overrides: ObservationInit = {},
): Observation {
	return create(ObservationSchema, {
		memberId,
		observerId: memberId,
		fleets: [FLEET],
		health: Health.REACHABLE,
		failingForMs: 0,
		capacity: { freeSlots: 2 },
		labels: ["hobo"],
		platform: create(PlatformSchema, { os: "linux", arch: "x64" }),
		since: iso(NOW - 60_000),
		issuedAt: iso(NOW),
		validUntil: iso(NOW + 45_000),
		...overrides,
	});
}

export function fleetRecord(fleet: string = FLEET): FleetRecord {
	return create(FleetRecordSchema, { fleetId: fleet, tenant: "acme" });
}

/** A `RegistryView` over a fixed set of records (verification is the real view's job). */
export function registry(records: readonly MemberRecord[]): RegistryView {
	const byId = new Map(records.map((record) => [record.memberId, record]));
	const none = async (): Promise<undefined> => undefined;
	return {
		member: async (id: MemberId) => byId.get(id),
		fleet: none,
		membersOf: async (id: FleetId) =>
			records.filter((record) =>
				record.memberships.some((entry) => entry.fleet === id),
			),
		fleets: async () => [],
		members: async () => records,
		view: async (): Promise<FleetView | undefined> => undefined,
		trust: () => create(TrustRecordSchema, { tenant: "acme" }),
		trustEnvelope: () => undefined,
		caughtUp: async () => undefined,
	};
}
