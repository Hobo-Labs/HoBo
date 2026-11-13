// ACTIVE members and their credentials, made by the real enrollment
// authority (L02) over a deployment of the harness, for the backup and
// restore tests. The parts L02 routes elsewhere are doubles (§11.3 rule 6).
import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	allowDecision,
	createMeteringBus,
	denyDecision,
	type PrincipalRef,
} from "@hobo/core";
import {
	ApprovalMode,
	type AuthorityDeps,
	type AuthorityParts,
	CoordinationMode,
	type CredentialIssuer,
	CredentialRequestSchema,
	DeviceClass,
	type EnrollmentAuthority,
	EnrollmentRequestSchema,
	FLEET_RECORD_CONTEXT,
	type FleetEventStore,
	FleetPolicySchema,
	FleetRecordSchema,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	type MemberId,
	type Outcome,
	PlatformSchema,
	POLICY_DECIDED_EVENT,
	PublicKeyRefSchema,
	parseFleetId,
	Role,
	type SignedEnvelope,
} from "@hobo/fleet";
import {
	createMemoryCredentialIssuer,
	createMemoryKeyStore,
	jwkThumbprint,
	parsePublicJwk,
	signEnvelope,
} from "@hobo/fleet/keys";
import { createEnrollmentAuthority } from "@hobo/fleet/membership";
import { type Deployment, ISSUER } from "./harness.js";

export const OWNER: PrincipalRef = { kind: "user", id: "owner" };
export const FLEET = "build";

function refused<T>(message: string): Outcome<T> {
	return { ok: false, error: { code: "unavailable", message } };
}

/** The enrollment authority and the credential issuer whose person tokens it accepts. */
export type ComposedAuthority = Readonly<{
	authority: EnrollmentAuthority;
	issuer: CredentialIssuer;
}>;

export function enrollmentAuthority(
	dep: Deployment,
	store: FleetEventStore,
	now: () => number,
	incarnation = 1,
): ComposedAuthority {
	const issuer = createMemoryCredentialIssuer(now);
	const deps: AuthorityDeps = {
		tenant: dep.tenant,
		store,
		bus: dep.bus,
		policy: {
			engineId: "l27-test",
			async evaluate(request) {
				return request.subject.tags.includes("fleet-admin")
					? allowDecision("l27-test", request, ["admin"])
					: denyDecision("l27-test", request, ["not admin"]);
			},
		},
		decisions: {
			toEvent: (request, decision) => ({
				type: POLICY_DECIDED_EVENT,
				data: { action: request.action, effect: decision.effect },
			}),
		},
		issuer,
		directory: {
			async tenantsOf() {
				return [{ tenant: dep.tenant, tags: ["fleet-admin"], aliases: [] }];
			},
		},
		accounts: { verify: async () => refused("no accounts") },
		signIn: [],
		assertions: {
			verifyOidc: async () => refused("no OIDC"),
			verifyCertificateChain: () => refused("no CA"),
		},
		recordSigner: dep.record.signer,
		metering: createMeteringBus(),
		overlayMinters: [],
		incarnation,
		now,
		log: () => {},
		discovery: {
			issuer: ISSUER,
			natsUrls: [],
			natsSentinelCredentials: "",
			relayUrls: [],
			minAgentVersion: "1.0.0",
		},
	};
	const unavailable = async () => refused<never>("double");
	const parts: AuthorityParts = {
		signIn: {
			start: unavailable,
			device: unavailable,
			callback: unavailable,
			approval: unavailable,
			approve: unavailable,
			complete: unavailable,
			poll: unavailable,
			refresh: unavailable,
		},
		recorder: {
			start() {},
			async stop() {},
			workStatus: unavailable,
			workLogs: unavailable,
			reliability: () => new Map(),
		},
		projection: { async tick() {}, async caughtUp() {} },
		fleets: {
			listFleets: unavailable,
			getFleet: unavailable,
			defineFleet: unavailable,
			fleetView: unavailable,
			fleetVerdict: unavailable,
			grantSession: unavailable,
			submitWork: unavailable,
		},
		audit: { tick: () => dep.tickAudit() },
		checkClaim: async () => "valid",
	};
	return { authority: createEnrollmentAuthority(deps, parts), issuer };
}

/** Publishes the fleet record the projection would, with AUTO_OWNER approval. */
export async function publishFleet(dep: Deployment, now: () => number) {
	const record = create(FleetRecordSchema, {
		fleetId: FLEET,
		tenant: dep.tenant,
		owner: `${OWNER.kind}:${OWNER.id}`,
		coordination: CoordinationMode.MANY_ACTIVE,
		policy: create(FleetPolicySchema, { approval: ApprovalMode.AUTO_OWNER }),
		revision: 1,
		issuedAt: new Date(now()).toISOString(),
		notAfter: new Date(now() + 30 * 60_000).toISOString(),
	});
	await dep.bus.publisher.putFleet(
		await signEnvelope(
			dep.record.signer,
			FLEET_RECORD_CONTEXT,
			toBinary(FleetRecordSchema, record),
		),
		parseFleetId(FLEET),
	);
}

export type EnrolledMember = Readonly<{
	memberId: MemberId;
	caller: Readonly<{
		kind: "member";
		memberId: MemberId;
		tenant: Deployment["tenant"];
		jkt: string;
		expiresAtMs: number;
	}>;
	record: SignedEnvelope;
	ticket: SignedEnvelope;
	generation: number;
}>;

/** Enrolls `name` with a person token bound to its identity key and refreshes its credentials once. */
export async function enrollActive(
	dep: Deployment,
	composed: ComposedAuthority,
	now: () => number,
	name: string,
): Promise<EnrolledMember> {
	const { authority, issuer } = composed;
	const keys = await createMemoryKeyStore().open();
	const identity = parsePublicJwk(keys.identityJwk);
	if (!identity.ok) throw new Error(identity.error.message);
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
						algorithm: KeyAlgorithm.EDDSA,
						value: keys.signPublicKey,
					}),
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SEAL,
						keyId: `${keys.memberId}#seal`,
						algorithm: KeyAlgorithm.UNSPECIFIED,
						value: keys.sealPublicKey,
					}),
				],
				issuedAt: new Date(now()).toISOString(),
				notAfter: new Date(now() + 24 * 3_600_000).toISOString(),
			}),
		),
	);
	// The owner, signed in with the device's identity key as the DPoP key (D44).
	const issued = await issuer.issuePerson({
		principal: OWNER,
		tenant: dep.tenant,
		tags: ["fleet-admin"],
		jkt: jwkThumbprint(identity.value),
		ttlMs: 15 * 60_000,
	});
	const verified = issuer.verify(issued.token, ISSUER, now());
	if (!verified.ok) throw new Error(verified.error.message);
	const person = { token: issued.token, caller: verified.value };
	const enrolled = await authority.enroll(
		create(EnrollmentRequestSchema, {
			tenant: dep.tenant,
			fleet: FLEET,
			name,
			displayName: name,
			identityJwk: keys.identityJwk,
			keyBundle: bundle,
			platform: create(PlatformSchema, { os: "linux", arch: "x64" }),
			region: "eu-west-1",
			agentVersion: "1.2.0",
			deviceClass: DeviceClass.PERSONAL,
			requestedRoles: [Role.EXECUTOR],
			proof: { case: "personToken", value: person.token },
		}),
		person.caller,
	);
	if (!enrolled.ok) throw new Error(`enroll: ${enrolled.error.message}`);
	const record = enrolled.value.memberRecord;
	if (record === undefined) throw new Error("no member record");
	const caller = {
		kind: "member",
		memberId: keys.memberId,
		tenant: dep.tenant,
		jkt: jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: keys.signPublicKey }),
		expiresAtMs: now() + 60_000,
	} as const;
	const credentials = await refresh(authority, keys.memberId, caller, 0);
	if (!credentials.ok)
		throw new Error(`credentials: ${credentials.error.message}`);
	const ticket = credentials.value.sessionTicket;
	if (ticket === undefined) throw new Error("no ticket");
	return {
		memberId: keys.memberId,
		caller,
		record,
		ticket,
		generation: credentials.value.generation,
	};
}

export function refresh(
	authority: EnrollmentAuthority,
	memberId: MemberId,
	caller: EnrolledMember["caller"],
	generation: number,
) {
	return authority.credentials(
		{
			memberId,
			request: create(CredentialRequestSchema, {
				generation,
				refreshNonce: new Uint8Array(randomBytes(16)),
				agentVersion: "1.2.0",
			}),
		},
		caller,
	);
}
