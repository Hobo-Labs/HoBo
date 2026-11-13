// Test harness for the enrollment authority (L02): a memory bus and event
// store, the memory credential issuer, an allow-by-tag policy engine, and a
// double for every member of `AuthorityParts` (§11.3 rule 6). Devices are
// built from `createMemoryKeyStore`, people from issuer-minted person tokens.
import {
	generateKeyPairSync,
	randomBytes,
	sign as signBytes,
} from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	allowDecision,
	createMeteringBus,
	denyDecision,
	type PolicyEngine,
	type PrincipalRef,
	parseTenantId,
} from "@hobo/core";
import {
	ApprovalMode,
	CoordinationMode,
	type CredentialRequest,
	CredentialRequestSchema,
	DeviceClass,
	type EnrollmentRequest,
	EnrollmentRequestSchema,
	type FleetPolicy,
	FleetPolicySchema,
	FleetRecordSchema,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	LifecycleRequestSchema,
	MemberKind,
	type OverlayJoin,
	OverlayJoinSchema,
	PlatformSchema,
	PublicKeyRefSchema,
	Role,
	type SignedEnvelope,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	FLEET_RECORD_CONTEXT,
	KEY_BUNDLE_CONTEXT,
	TRUST_RECORD_CONTEXT,
} from "../../src/contexts.js";
import { POLICY_DECIDED_EVENT } from "../../src/events.js";
import { parseKeyId } from "../../src/ids.js";
import {
	createMemoryCredentialIssuer,
	createMemoryKeyStore,
	generateDpopKey,
	jwkThumbprint,
	mintDpopProof,
	parsePublicJwk,
	signEnvelope,
} from "../../src/keys/index.js";
import { createEnrollmentAuthority } from "../../src/membership/index.js";
import type {
	AuthorityDeps,
	AuthorityParts,
	DeviceKeys,
	EnrollmentAuthority,
	FleetCommands,
	FleetEventStore,
	FleetFailure,
	IdentityAssertionVerifier,
	Outcome,
	OverlayCredentialMinter,
	PublicJwk,
	Signer,
	VerifiedToken,
} from "../../src/ports.js";
import {
	createMemoryBus,
	createMemoryEventStore,
} from "../../src/testing/plumbing/index.js";

export const ISSUER = "https://authority.fleet.test";
export const TENANT = parseTenantId("acme");
export const OWNER: PrincipalRef = { kind: "user", id: "owner" };
export const START_MS = Date.parse("2026-11-01T10:00:00.000Z");

export type Clock = Readonly<{ now: () => number; advance(ms: number): void }>;

export function testClock(start = START_MS): Clock {
	let at = start;
	return { now: () => at, advance: (ms) => (at += ms) };
}

function refused<T>(code: FleetFailure["code"], message: string): Outcome<T> {
	return { ok: false, error: { code, message } };
}

type RawKey = Readonly<{ signer: Signer; raw: string }>;

function ed25519(keyId: string): RawKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		signer: {
			keyId: parseKeyId(keyId),
			algorithm: KeyAlgorithm.EDDSA,
			sign: async (bytes) => new Uint8Array(signBytes(null, bytes, privateKey)),
		},
		raw: publicKey
			.export({ format: "der", type: "spki" })
			.subarray(-32)
			.toString("base64url"),
	};
}

/** What the parts doubles saw. */
export type PartCalls = {
	ticks: string[];
	fleets: string[];
	checkClaim: string[];
};

export type Options = Partial<{
	minters: readonly OverlayCredentialMinter[];
	assertions: IdentityAssertionVerifier;
	checkClaim: AuthorityParts["checkClaim"];
	store: FleetEventStore;
	policy: PolicyEngine;
}>;

/** Allow when the subject carries `fleet-admin` or the action itself as a tag. */
export function allowByTag(): PolicyEngine {
	const engineId = "l02-test-allow-by-tag";
	return {
		engineId,
		async evaluate(request) {
			const tags = request.subject.tags;
			return tags.includes("fleet-admin") || tags.includes(request.action)
				? allowDecision(engineId, request, ["tag allows"])
				: denyDecision(engineId, request, ["no tag allows"]);
		},
	};
}

export function refusingAssertions(): IdentityAssertionVerifier {
	return {
		verifyOidc: async () => refused("unauthenticated", "no OIDC issuers"),
		verifyCertificateChain: () => refused("unauthenticated", "no CA roots"),
	};
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function harness(options: Options = {}) {
	const clock = testClock();
	const now = clock.now;
	const bus = createMemoryBus(now);
	const store = options.store ?? createMemoryEventStore();
	const authorityKey = ed25519("authority#1");
	const witnessKey = ed25519("witness#1");
	const ref = (key: typeof authorityKey, purpose: KeyPurpose) =>
		create(PublicKeyRefSchema, {
			purpose,
			keyId: key.signer.keyId,
			algorithm: key.signer.algorithm,
			value: key.raw,
		});
	const trustPayload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: TENANT,
			sequence: 1,
			authorityKeys: [ref(authorityKey, KeyPurpose.AUTHORITY)],
			witnessKeys: [ref(witnessKey, KeyPurpose.WITNESS)],
			authorityIncarnation: 1,
			issuer: ISSUER,
			jwksUri: `${ISSUER}/v1/fleet/jwks`,
			issuedAt: new Date(now()).toISOString(),
		}),
	);
	await bus.publisher.putTrust(
		create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(
				authorityKey.signer,
				TRUST_RECORD_CONTEXT,
				trustPayload,
			),
			witness: await signEnvelope(
				witnessKey.signer,
				TRUST_RECORD_CONTEXT,
				trustPayload,
			),
		}),
	);

	const issuer = createMemoryCredentialIssuer(now);
	const logged: string[] = [];
	const calls: PartCalls = { ticks: [], fleets: [], checkClaim: [] };
	const deps: AuthorityDeps = {
		tenant: TENANT,
		store,
		bus,
		policy: options.policy ?? allowByTag(),
		decisions: {
			toEvent: (request, decision) => ({
				type: POLICY_DECIDED_EVENT,
				data: { action: request.action, effect: decision.effect },
			}),
		},
		issuer,
		directory: {
			async tenantsOf() {
				return [{ tenant: TENANT, tags: [], aliases: ["github:42"] }];
			},
		},
		accounts: {
			async verify(bearer) {
				return bearer === "account-ok"
					? {
							ok: true,
							value: {
								principal: { kind: "service", id: "relay" },
								tenant: TENANT,
								scopes: ["read"],
							},
						}
					: refused("unauthenticated", "unknown account");
			},
		},
		signIn: [
			{
				id: "test",
				begin: async () => ({ url: `${ISSUER}/x` }),
				complete: async () => refused("unauthenticated", "not here"),
			},
		],
		assertions: options.assertions ?? refusingAssertions(),
		recordSigner: authorityKey.signer,
		metering: createMeteringBus(),
		overlayMinters: options.minters ?? [],
		incarnation: 1,
		now,
		log: (event) => {
			logged.push(event);
		},
		discovery: {
			issuer: ISSUER,
			natsUrls: ["nats://bus.test:4222"],
			natsSentinelCredentials: "sentinel",
			relayUrls: [],
			minAgentVersion: "1.0.0",
		},
	};

	const unavailable = async () =>
		refused<never>("unavailable", "double: not this lane");
	const fleetCall =
		(name: keyof FleetCommands) => async (): Promise<Outcome<never>> => {
			calls.fleets.push(name);
			return refused("unavailable", `double ${name}`);
		};
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
		projection: {
			async tick() {
				calls.ticks.push("projection");
			},
			async caughtUp() {},
		},
		fleets: {
			listFleets: fleetCall("listFleets"),
			getFleet: fleetCall("getFleet"),
			defineFleet: fleetCall("defineFleet"),
			fleetView: fleetCall("fleetView"),
			fleetVerdict: fleetCall("fleetVerdict"),
			grantSession: fleetCall("grantSession"),
			submitWork: fleetCall("submitWork"),
		},
		audit: {
			async tick() {
				calls.ticks.push("audit");
			},
		},
		checkClaim:
			options.checkClaim ??
			(async () => {
				calls.checkClaim.push("valid");
				return "valid";
			}),
	};

	const authority = createEnrollmentAuthority(deps, parts);
	const fleetRevisions = new Map<string, number>();

	return {
		clock,
		bus,
		store,
		issuer,
		deps,
		parts,
		calls,
		logged,
		authority,
		recordSigner: authorityKey.signer,
		recordKey: authorityKey.raw,
		/** Another authority instance on the same store and bus. */
		another(): EnrollmentAuthority {
			return createEnrollmentAuthority(deps, parts);
		},
		/** Publishes a fleet record to the registry, as the projection would. */
		async fleet(
			fleetId: string,
			policy: Partial<Omit<FleetPolicy, "$typeName">> = {},
			owner: PrincipalRef = OWNER,
		): Promise<void> {
			const revision = (fleetRevisions.get(fleetId) ?? 0) + 1;
			fleetRevisions.set(fleetId, revision);
			const record = create(FleetRecordSchema, {
				fleetId,
				tenant: TENANT,
				owner: `${owner.kind}:${owner.id}`,
				coordination: CoordinationMode.MANY_ACTIVE,
				policy: create(FleetPolicySchema, {
					approval: ApprovalMode.SINGLE,
					...policy,
				}),
				revision,
				issuedAt: new Date(now()).toISOString(),
				notAfter: "2100-01-01T00:00:00.000Z",
			});
			await bus.publisher.putFleet(
				await signEnvelope(
					authorityKey.signer,
					FLEET_RECORD_CONTEXT,
					toBinary(FleetRecordSchema, record),
				),
				// SAFETY: test fleet ids are short tokens.
				fleetId as Parameters<typeof bus.publisher.putFleet>[1],
			);
		},
		/** A signed-in person: the token, its DPoP key, and the verified caller. */
		async person(
			principal: PrincipalRef,
			tags: readonly string[] = ["fleet-admin"],
			key = generateDpopKey(),
		) {
			const issued = await issuer.issuePerson({
				principal,
				tenant: TENANT,
				tags,
				jkt: jwkThumbprint(key.publicJwk),
				ttlMs: 15 * 60 * 1_000,
			});
			const verified = issuer.verify(issued.token, ISSUER, now());
			if (!verified.ok) throw new Error(verified.error.message);
			return { token: issued.token, key, caller: verified.value };
		},
	};
}

export type TestDevice = Readonly<{
	keys: DeviceKeys;
	identity: PublicJwk;
	thumbprint: string;
	signJwk: PublicJwk;
	bundle: SignedEnvelope;
	/** The caller `authenticate` yields for a proof with the SIGN key. */
	caller: VerifiedToken;
}>;

export async function bundleFor(
	keys: DeviceKeys,
	nowMs: number,
	options: Partial<{ sequence: number; hours: number; identity: Signer }> = {},
): Promise<SignedEnvelope> {
	const bundle = create(KeyBundleSchema, {
		memberId: keys.memberId,
		sequence: options.sequence ?? 1,
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
		issuedAt: new Date(nowMs).toISOString(),
		notAfter: new Date(nowMs + (options.hours ?? 24) * 3_600_000).toISOString(),
	});
	return signEnvelope(
		options.identity ?? keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(KeyBundleSchema, bundle),
	);
}

export async function device(nowMs: number): Promise<TestDevice> {
	const keys = await createMemoryKeyStore().open();
	const identity = parsePublicJwk(keys.identityJwk);
	if (!identity.ok) throw new Error(identity.error.message);
	const signJwk: PublicJwk = {
		kty: "OKP",
		crv: "Ed25519",
		x: keys.signPublicKey,
	};
	return {
		keys,
		identity: identity.value,
		thumbprint: jwkThumbprint(identity.value),
		signJwk,
		bundle: await bundleFor(keys, nowMs),
		caller: {
			kind: "member",
			memberId: keys.memberId,
			tenant: TENANT,
			jkt: jwkThumbprint(signJwk),
			expiresAtMs: nowMs + 60_000,
		},
	};
}

export function enrollment(
	subject: TestDevice,
	fields: Partial<Omit<EnrollmentRequest, "$typeName">>,
): EnrollmentRequest {
	return create(EnrollmentRequestSchema, {
		tenant: TENANT,
		name: "laptop",
		displayName: "Laptop",
		identityJwk: subject.keys.identityJwk,
		keyBundle: subject.bundle,
		platform: create(PlatformSchema, { os: "linux", arch: "x64" }),
		region: "eu-west-1",
		agentVersion: "1.2.0",
		deviceClass: DeviceClass.PERSONAL,
		requestedRoles: [Role.EXECUTOR],
		...fields,
	});
}

export function refresh(
	generation: number,
	nonce: Uint8Array = randomBytes(16),
): CredentialRequest {
	return create(CredentialRequestSchema, {
		generation,
		refreshNonce: nonce,
		agentVersion: "1.2.0",
	});
}

export function why(
	reason = "",
): ReturnType<typeof create<typeof LifecycleRequestSchema>> {
	return create(LifecycleRequestSchema, { reason });
}

export function minter(
	provider: "tailscale" | "netbird",
	behaviour: "ok" | "fail" | "throw",
	seen: string[] = [],
): OverlayCredentialMinter {
	return {
		provider,
		async mint(input) {
			seen.push(
				`${provider}:${input.memberId}:${input.ttlMs}:${input.tags.join(",")}`,
			);
			if (behaviour === "throw") throw new Error("minter down");
			if (behaviour === "fail")
				return refused<OverlayJoin>("unavailable", "provider down");
			return {
				ok: true,
				value: create(OverlayJoinSchema, {
					provider,
					credential: `${provider}-single-use`,
					expiresAt: new Date(START_MS + input.ttlMs).toISOString(),
					tags: [...input.tags],
				}),
			};
		},
	};
}

export async function dpopFor(
	subject: TestDevice,
	method: string,
	url: string,
	nowMs: number,
	accessToken?: string,
): Promise<string> {
	return mintDpopProof(
		subject.keys.sign,
		subject.signJwk,
		accessToken === undefined
			? { htm: method, htu: url, nowMs }
			: { htm: method, htu: url, nowMs, accessToken },
	);
}

export { MemberKind };
