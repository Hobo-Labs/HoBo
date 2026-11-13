/**
 * Fixtures for the work lane: devices from the in-memory key store with their
 * signed key bundles and member records, fleet records, an Ed25519 authority
 * key for submissions, a registry double over maps (rule 6), signed offers,
 * claims, orders and submissions, and helpers that put records on the memory
 * bus. Only frozen entry points and the generated types are imported.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	ClaimSchema,
	CoordinationMode,
	DeviceClass,
	type FleetPolicy,
	FleetPolicySchema,
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
	type PublicKeyRef,
	PublicKeyRefSchema,
	Role,
	SandboxTier,
	type SignedEnvelope,
	TrustClass,
	type TrustRecord,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
	type WorkOffer,
	WorkOfferSchema,
	WorkOrderSchema,
	WorkOrigin,
	WorkSubmissionSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	CLAIM_CONTEXT,
	FLEET_RECORD_CONTEXT,
	KEY_BUNDLE_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	OBSERVATION_CONTEXT,
	OFFER_CONTEXT,
	ORDER_CONTEXT,
	ORDER_SECRET_CONTEXT,
	TRUST_RECORD_CONTEXT,
	WORK_SUBMISSION_CONTEXT,
} from "../../src/contexts.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseKeyId,
	parseMemberId,
} from "../../src/ids.js";
import {
	createMemoryKeyStore,
	seal,
	signEnvelope,
} from "../../src/keys/index.js";
import type {
	AuthorityBus,
	DeviceKeys,
	KeyStore,
	RegistryView,
	Signer,
} from "../../src/ports.js";
import { workDigest } from "../../src/work/index.js";

/** The init fields of a generated message (not a built message), for overrides. */
type InitOf<S extends Parameters<typeof create>[0]> = Exclude<
	Parameters<typeof create<S>>[1],
	undefined | Readonly<{ $typeName: string }>
>;

export const NOW = Date.parse("2026-11-13T12:00:00.000Z");
export const FLEET: FleetId = parseFleetId("hobo");
export const OTHER_FLEET: FleetId = parseFleetId("other");
export const DAY = 24 * 3_600_000;
export const iso = (ms: number): string => new Date(ms).toISOString();

export type Device = Readonly<{
	keys: DeviceKeys;
	store: KeyStore;
	record: MemberRecord;
}>;

export type DeviceOptions = Readonly<{
	roles?: readonly Role[];
	fleet?: string;
	deviceClass?: DeviceClass;
	state?: MemberState;
	region?: string;
	owner?: string;
	aliases?: readonly string[];
	agentVersion?: string;
	os?: string;
	kind?: MemberKind;
	/** Extra memberships, e.g. executor in another fleet. */
	also?: readonly Readonly<{ fleet: string; roles: readonly Role[] }>[];
}>;

async function bundle(keys: DeviceKeys): Promise<SignedEnvelope> {
	const message = create(KeyBundleSchema, {
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
		issuedAt: iso(NOW - 3_600_000),
		notAfter: iso(NOW + 30 * DAY),
	});
	return signEnvelope(
		keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(KeyBundleSchema, message),
	);
}

export async function device(options: DeviceOptions = {}): Promise<Device> {
	const store = createMemoryKeyStore();
	const keys = await store.open();
	const fleet = options.fleet ?? FLEET;
	const record = create(MemberRecordSchema, {
		memberId: keys.memberId,
		tenant: "acme",
		kind: options.kind ?? MemberKind.DEVICE,
		displayName: "device",
		state: options.state ?? MemberState.ACTIVE,
		memberships: [
			create(MembershipSchema, {
				fleet,
				name: `m${keys.memberId.slice(4, 12)}`,
				roles: [...(options.roles ?? [Role.EXECUTOR])],
			}),
			...(options.also ?? []).map((extra) =>
				create(MembershipSchema, {
					fleet: extra.fleet,
					name: `m${keys.memberId.slice(4, 12)}`,
					roles: [...extra.roles],
				}),
			),
		],
		deviceClass: options.deviceClass ?? DeviceClass.EPHEMERAL,
		identityJwk: keys.identityJwk,
		keyBundle: await bundle(keys),
		platform: { os: options.os ?? "linux", arch: "x64" },
		region: options.region ?? "",
		agentVersion: options.agentVersion ?? "1.0.0",
		owner: options.owner ?? "github:1",
		ownerAliases: [...(options.aliases ?? ["github:1"])],
		recordSequence: 1,
		issuedAt: iso(NOW),
		notAfter: iso(NOW + 30 * DAY),
	});
	return { keys, store, record };
}

export function policy(
	init: InitOf<typeof FleetPolicySchema> = {},
): FleetPolicy {
	return create(FleetPolicySchema, init);
}

/** A policy that allows the test repository on main and every kind. */
export function openPolicy(
	init: InitOf<typeof FleetPolicySchema> = {},
): FleetPolicy {
	return create(FleetPolicySchema, {
		repositories: [
			{
				repository: "acme/app",
				refs: ["refs/heads/main", "refs/pull/*/merge"],
			},
		],
		...init,
	});
}

export function fleetRecord(
	fleetPolicy: FleetPolicy = openPolicy(),
	fleet: string = FLEET,
): FleetRecord {
	return create(FleetRecordSchema, {
		fleetId: fleet,
		tenant: "acme",
		coordination: CoordinationMode.MANY_ACTIVE,
		policy: fleetPolicy,
		revision: 1,
		issuedAt: iso(NOW),
		notAfter: iso(NOW + 30 * DAY),
	});
}

export type AuthorityKey = Readonly<{ signer: Signer; ref: PublicKeyRef }>;

export function authorityKey(index = 1): AuthorityKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyId = parseKeyId(`authority#${index}`);
	const jwk = publicKey.export({ format: "jwk" });
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
			value: jwk.x ?? "",
		}),
	};
}

export function trustRecord(authority: AuthorityKey): TrustRecord {
	return create(TrustRecordSchema, {
		tenant: "acme",
		sequence: 1,
		authorityKeys: [authority.ref],
	});
}

/** A `RegistryView` over maps (verification is the real view's job). */
export function registry(
	members: readonly MemberRecord[],
	fleets: readonly FleetRecord[],
	authority?: AuthorityKey,
	views: readonly FleetView[] = [],
): RegistryView {
	const byId = new Map(members.map((record) => [record.memberId, record]));
	const fleetById = new Map(fleets.map((record) => [record.fleetId, record]));
	return {
		member: async (id: MemberId) => byId.get(id),
		fleet: async (id: FleetId) => fleetById.get(id),
		membersOf: async (id: FleetId) =>
			members.filter((record) =>
				record.memberships.some((entry) => entry.fleet === id),
			),
		fleets: async () => fleets,
		members: async () => members,
		view: async (id: FleetId) => views.find((view) => view.fleet === id),
		trust: () =>
			authority === undefined
				? create(TrustRecordSchema, { tenant: "acme" })
				: trustRecord(authority),
		trustEnvelope: () => undefined,
		caughtUp: async () => undefined,
	};
}

export type OfferInit = InitOf<typeof WorkOfferSchema>;

export function offer(
	dispatcher: MemberId | string,
	init: OfferInit = {},
): WorkOffer {
	const kind = init.kind ?? "github-actions-job";
	const workKey = init.workKey ?? "job-1";
	return create(WorkOfferSchema, {
		workKey,
		workDigest: workDigest(kind, workKey),
		kind,
		fleet: FLEET,
		label: "hobo",
		needs: { labels: [] },
		trustClass: TrustClass.ORG,
		author: "github:2",
		origin: WorkOrigin.INTERNAL,
		repository: "acme/app",
		ref: "refs/heads/main",
		workflowDigest: "",
		queuedAt: iso(NOW),
		expiresAt: iso(NOW + 10 * 60_000),
		dispatcher,
		...init,
	});
}

export function signOffer(keys: DeviceKeys, message: WorkOffer) {
	return signEnvelope(
		keys.sign,
		OFFER_CONTEXT,
		toBinary(WorkOfferSchema, message),
	);
}

export type ClaimInit = InitOf<typeof ClaimSchema>;

export function claimFor(
	claimant: DeviceKeys,
	answered: WorkOffer,
	init: ClaimInit = {},
	signer: Signer = claimant.sign,
): Promise<SignedEnvelope> {
	const message = create(ClaimSchema, {
		workDigest: answered.workDigest,
		fleet: answered.fleet,
		memberId: claimant.memberId,
		dispatcher: answered.dispatcher,
		offerExpiresAt: answered.expiresAt,
		rank: 0,
		sandboxTier: SandboxTier.S3_MICROVM,
		claimedAt: answered.queuedAt,
		...init,
	});
	return signEnvelope(signer, CLAIM_CONTEXT, toBinary(ClaimSchema, message));
}

export type OrderInit = InitOf<typeof WorkOrderSchema>;

export async function orderFor(
	dispatcher: DeviceKeys,
	recipient: Device,
	work: WorkOffer,
	init: OrderInit = {},
	secret = new TextEncoder().encode("registration-token"),
): Promise<SignedEnvelope> {
	const orderId = init.orderId ?? "0123456789abcdef0123456789abcdef";
	const sealKey = create(PublicKeyRefSchema, {
		purpose: KeyPurpose.SEAL,
		keyId: `${recipient.keys.memberId}#seal`,
		value: recipient.keys.sealPublicKey,
	});
	const message = create(WorkOrderSchema, {
		orderId,
		offer: work,
		memberId: recipient.keys.memberId,
		sandboxTier: SandboxTier.S3_MICROVM,
		parameters: { image: "runner:latest" },
		secret: seal(
			sealKey,
			secret,
			ORDER_SECRET_CONTEXT,
			new TextEncoder().encode(`${orderId}\0${recipient.keys.memberId}`),
		),
		issuedAt: iso(NOW),
		expiresAt: work.expiresAt,
		...init,
	});
	return signEnvelope(
		dispatcher.sign,
		ORDER_CONTEXT,
		toBinary(WorkOrderSchema, message),
	);
}

export function submission(
	authority: AuthorityKey,
	init: InitOf<typeof WorkSubmissionSchema> = {},
): Promise<SignedEnvelope> {
	const message = create(WorkSubmissionSchema, {
		submissionId: "sub-1",
		tenant: "acme",
		fleet: FLEET,
		author: "github:1",
		image: "alpine",
		imageDigest: "",
		argv: ["echo", "hello"],
		env: { GREETING: "hi" },
		needs: { labels: [] },
		egressAllow: ["example.com"],
		submittedAt: iso(NOW),
		expiresAt: iso(NOW + DAY),
		...init,
	});
	return signEnvelope(
		authority.signer,
		WORK_SUBMISSION_CONTEXT,
		toBinary(WorkSubmissionSchema, message),
	);
}

export type ObservationInit = InitOf<typeof ObservationSchema>;

export function observation(
	of: Device,
	at: number,
	init: ObservationInit = {},
): Observation {
	return create(ObservationSchema, {
		memberId: of.keys.memberId,
		observerId: of.keys.memberId,
		fleets: [FLEET],
		health: Health.REACHABLE,
		capacity: { freeSlots: 1 },
		labels: [],
		platform: { os: "linux", arch: "x64" },
		sandboxTiers: [SandboxTier.S1_CONTAINER, SandboxTier.S3_MICROVM],
		agentVersion: "1.0.0",
		issuedAt: iso(at),
		validUntil: iso(at + 50_000),
		...init,
	});
}

export async function publishObservation(
	bus: AuthorityBus,
	of: Device,
	at: number,
	init: ObservationInit = {},
): Promise<void> {
	const message = observation(of, at, init);
	const envelope = await signEnvelope(
		of.keys.sign,
		OBSERVATION_CONTEXT,
		toBinary(ObservationSchema, message),
	);
	await bus.observations.publish(envelope, of.keys.memberId, of.keys.memberId);
}

/** Puts member, fleet and trust records on the memory bus (its view does not verify signatures). */
export async function seedBus(
	bus: AuthorityBus,
	authority: AuthorityKey,
	members: readonly MemberRecord[],
	fleets: readonly FleetRecord[],
): Promise<void> {
	for (const member of members)
		await bus.publisher.putMember(
			await signEnvelope(
				authority.signer,
				MEMBER_RECORD_CONTEXT,
				toBinary(MemberRecordSchema, member),
			),
			parseMemberId(member.memberId),
		);
	for (const fleet of fleets)
		await bus.publisher.putFleet(
			await signEnvelope(
				authority.signer,
				FLEET_RECORD_CONTEXT,
				toBinary(FleetRecordSchema, fleet),
			),
			parseFleetId(fleet.fleetId),
		);
	const trust = toBinary(TrustRecordSchema, trustRecord(authority));
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
}
