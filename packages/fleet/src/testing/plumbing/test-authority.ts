import {
	generateKeyPairSync,
	type KeyObject,
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
	type TenantId,
} from "@hobo/core";
import {
	KeyAlgorithm,
	KeyPurpose,
	type PublicKeyRef,
	PublicKeyRefSchema,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "../../_generated/fleet_pb.js";
import { createAuditChain } from "../../audit/index.js";
import { TRUST_RECORD_CONTEXT } from "../../contexts.js";
import { POLICY_DECIDED_EVENT } from "../../events.js";
import { createFleetCommands } from "../../fleets/index.js";
import { parseKeyId } from "../../ids.js";
import {
	createMemoryCredentialIssuer,
	generateDpopKey,
	jwkThumbprint,
	signEnvelope,
} from "../../keys/index.js";
import { createEnrollmentAuthority } from "../../membership/index.js";
import type {
	AuthorityBus,
	AuthorityDeps,
	Clock,
	EnrollmentAuthority,
	FleetEventStore,
	FleetFailure,
	Outcome,
	PolicyDecisionRecorder,
	PrincipalDirectory,
	Signer,
	SignInProvider,
} from "../../ports.js";
import {
	createRecorder,
	createRegistryProjection,
} from "../../recorder/index.js";
import { createSignIn } from "../../signin/index.js";
import { checkClaim } from "../../work/index.js";
import { createMemoryBus } from "./memory-bus.js";
import { createMemoryEventStore } from "./memory-event-store.js";

const ISSUER = "https://authority.fleet.test";
const PERSON_TOKEN_TTL_MS = 15 * 60 * 1_000;
const ADMIN_TAG = "fleet-admin";

export async function createTestAuthority(now: Clock): Promise<
	Readonly<{
		authority: EnrollmentAuthority;
		bus: AuthorityBus;
		store: FleetEventStore;
		trust: WitnessedEnvelope;
		signInAs(principal: PrincipalRef, tags: readonly string[]): Promise<string>;
	}>
> {
	const tenant = parseTenantId("test");
	const bus = createMemoryBus(now);
	const store = createMemoryEventStore();
	const authorityKey = ed25519Signer("authority#1");
	const witnessKey = ed25519Signer("witness#1");

	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant,
			sequence: 1,
			authorityKeys: [authorityKey.ref(KeyPurpose.AUTHORITY)],
			witnessKeys: [witnessKey.ref(KeyPurpose.WITNESS)],
			authorityIncarnation: 1,
			issuer: ISSUER,
			jwksUri: `${ISSUER}/v1/fleet/jwks`,
			issuedAt: new Date(now()).toISOString(),
		}),
	);
	const trust = create(WitnessedEnvelopeSchema, {
		authority: await signEnvelope(
			authorityKey.signer,
			TRUST_RECORD_CONTEXT,
			payload,
		),
		witness: await signEnvelope(
			witnessKey.signer,
			TRUST_RECORD_CONTEXT,
			payload,
		),
	});
	await bus.publisher.putTrust(trust);

	const people = new Map<string, readonly string[]>();
	const issuer = createMemoryCredentialIssuer(now);
	const deps: AuthorityDeps = {
		tenant,
		store,
		bus,
		policy: allowByTag(),
		decisions: testDecisionRecorder(),
		issuer,
		directory: testDirectory(tenant, people),
		accounts: {
			verify: async () =>
				refused("no account credentials in the test authority"),
		},
		signIn: [testSignInProvider(people)],
		assertions: {
			verifyOidc: async () => refused("no OIDC issuers in the test authority"),
			verifyCertificateChain: () =>
				refused("no device CA roots in the test authority"),
		},
		recordSigner: authorityKey.signer,
		metering: createMeteringBus(),
		overlayMinters: [],
		incarnation: 1,
		now,
		log: () => {},
		discovery: {
			issuer: ISSUER,
			natsUrls: [],
			natsSentinelCredentials: "",
			relayUrls: [],
			minAgentVersion: "0.0.0",
		},
	};

	const recorder = createRecorder(deps);
	const authority = createEnrollmentAuthority(deps, {
		signIn: createSignIn(deps),
		recorder,
		projection: createRegistryProjection({
			...deps,
			reliability: () => recorder.reliability(),
		}),
		fleets: createFleetCommands({ ...deps, mode: "authority" }),
		audit: createAuditChain({
			store,
			log: bus.audit,
			signer: authorityKey.signer,
			incarnation: 1,
			now,
		}),
		checkClaim,
	});
	recorder.start();

	return {
		authority,
		bus,
		store,
		trust,
		async signInAs(principal, tags) {
			people.set(principalKey(principal), [...tags]);
			const { publicJwk } = generateDpopKey();
			const issued = await issuer.issuePerson({
				principal,
				tenant,
				tags,
				jkt: jwkThumbprint(publicJwk),
				ttlMs: PERSON_TOKEN_TTL_MS,
			});
			return issued.token;
		},
	};
}

function allowByTag(): PolicyEngine {
	const engineId = "hobo-fleet-test-allow-by-tag";
	return {
		engineId,
		async evaluate(request) {
			const tags = request.subject.tags;
			return tags.includes(ADMIN_TAG) || tags.includes(request.action)
				? allowDecision(engineId, request, [`tag allows ${request.action}`])
				: denyDecision(engineId, request, [`no tag allows ${request.action}`]);
		},
	};
}

function testDecisionRecorder(): PolicyDecisionRecorder {
	return {
		toEvent(request, decision) {
			return {
				type: POLICY_DECIDED_EVENT,
				data: {
					action: request.action,
					effect: decision.effect,
					engineId: decision.engineId,
					reasons: [...decision.reasons],
					subject: request.subject.identity,
					resourceKind: request.resource.kind,
					resourceId: request.resource.id,
				},
			};
		},
	};
}

function testDirectory(
	tenant: TenantId,
	people: ReadonlyMap<string, readonly string[]>,
): PrincipalDirectory {
	return {
		async tenantsOf(principal) {
			const tags = people.get(principalKey(principal));
			return tags === undefined ? [] : [{ tenant, tags, aliases: [] }];
		},
	};
}

function testSignInProvider(
	people: ReadonlyMap<string, readonly string[]>,
): SignInProvider {
	return {
		id: "test",
		async begin(input) {
			return {
				url: `${ISSUER}/test-signin/authorize?state=${encodeURIComponent(input.state)}`,
			};
		},
		async complete(input) {
			const separator = input.code.indexOf(":");
			const principal: PrincipalRef | undefined =
				separator > 0
					? principalOf(
							input.code.slice(0, separator),
							input.code.slice(separator + 1),
						)
					: undefined;
			if (principal === undefined || !people.has(principalKey(principal)))
				return refused("unknown test principal");
			return { ok: true, value: { principal, claims: {} } };
		},
	};
}

function principalOf(kind: string, id: string): PrincipalRef | undefined {
	return kind === "user" ||
		kind === "agent" ||
		kind === "service" ||
		kind === "system"
		? { kind, id }
		: undefined;
}

function principalKey(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

function refused<T>(message: string): Outcome<T> {
	const error: FleetFailure = { code: "unauthenticated", message };
	return { ok: false, error };
}

type TestKey = Readonly<{
	signer: Signer;
	ref(purpose: KeyPurpose): PublicKeyRef;
}>;

function ed25519Signer(keyId: string): TestKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const id = parseKeyId(keyId);
	return {
		signer: {
			keyId: id,
			algorithm: KeyAlgorithm.EDDSA,
			sign: async (bytes) => new Uint8Array(signBytes(null, bytes, privateKey)),
		},
		ref: (purpose) =>
			create(PublicKeyRefSchema, {
				purpose,
				keyId: id,
				algorithm: KeyAlgorithm.EDDSA,
				value: rawPublicKey(publicKey),
			}),
	};
}

function rawPublicKey(publicKey: KeyObject): string {
	return publicKey
		.export({ format: "der", type: "spki" })
		.subarray(-32)
		.toString("base64url");
}
