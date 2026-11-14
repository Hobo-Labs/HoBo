/**
 * The acceptance world (design §11.4 L26): the real authority, composed by
 * `assembleAuthority` and served by `createAuthorityHandler` with no network,
 * over a bus the caller chooses (the memory bus for `pnpm run test:behavior`,
 * `nats-server` for the acceptance integration test), with the real audit
 * chain and witness, and device agents built by `createFleetAgent`.
 *
 * The world holds the trust anchor itself (one authority key, one witness
 * key), so the authority signs records with a key the pinned trust record
 * names and every agent verifies what it is answered. Time is the wall clock
 * plus an offset the suite can advance, so agent loops run on real timers
 * while the authority's audit and expiry ticks can be moved forward.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
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
	type AgentDeps,
	ApprovalMode,
	type AuthorityBus,
	type AuthorityDeps,
	CapacitySchema,
	type CapacitySource,
	type Clock,
	CoordinationMode,
	DeviceClass,
	type EgressProxyFactory,
	type FleetBusConnector,
	type FleetLog,
	type FleetLogEvent,
	type FleetPolicy,
	FleetPolicySchema,
	FleetRecordSchema,
	Health,
	type IdentityAssertionVerifier,
	KeyAlgorithm,
	KeyPurpose,
	type KeyStore,
	type MemberId,
	type PublicKeyRef,
	PublicKeyRefSchema,
	parseFleetId,
	parseKeyId,
	type Role,
	type SandboxDriver,
	SandboxTier,
	type Signer,
	type SignInProvider,
	TokenCreateRequestSchema,
	TRUST_RECORD_CONTEXT,
	type TrustRecord,
	TrustRecordSchema,
	type VerifiedToken,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
	type WorkRunner,
	type WorkSource,
} from "@hobo/fleet";
import { createFleetAgent } from "@hobo/fleet/agent";
import { createWitness } from "@hobo/fleet/audit";
import {
	createMemoryCredentialIssuer,
	createMemoryKeyStore,
	generateDpopKey,
	jwkThumbprint,
	signEnvelope,
} from "@hobo/fleet/keys";
// The plumbing of `@hobo/fleet/testing`, by path: that barrel also loads the conformance suites, which
// import vitest, and the behaviour suite runs under cucumber.
import {
	createFakeSandboxDriver,
	createMemoryBus,
	createMemoryEventStore,
} from "../../fleet/src/testing/plumbing/index.js";
import { assembleAuthority } from "../src/compose/assemble.js";
import { createPolicyDecisionRecorder } from "../src/identity/decisions.js";
import { createStaticPrincipalDirectory } from "../src/identity/directory.js";
import { createAuthorityHandler } from "../src/service/http.js";
import { type AuditLogDouble, createAuditLogDouble } from "./audit-log.js";
import {
	createMemoryConnector,
	type MemoryConnector,
} from "./memory-connector.js";

export const ISSUER = "https://authority.fleet.test";
export const TENANT: TenantId = parseTenantId("test");
/** The workload OIDC token the world's assertion verifier accepts, and what it says. */
export const WORKLOAD_TOKEN = "workload-oidc-token-of-a-ci-job";
export const WORKLOAD_ISSUER = "https://token.actions.githubusercontent.com";
export const WORKLOAD_SUBJECT = "repo:acme/app:ref:refs/heads/main";

/** The people the directory knows: the developer, two administrators, and an auditor. */
export const PEOPLE = {
	dev: { kind: "user", id: "dev" },
	alice: { kind: "user", id: "alice" },
	bob: { kind: "user", id: "bob" },
	auditor: { kind: "user", id: "auditor" },
} as const satisfies Readonly<Record<string, PrincipalRef>>;
export type PersonName = keyof typeof PEOPLE;
const NAMES: readonly PersonName[] = ["dev", "alice", "bob", "auditor"];
const TAGS = {
	dev: ["fleet-admin"],
	alice: ["fleet-admin"],
	bob: ["fleet-admin"],
	auditor: ["auditor"],
} as const satisfies Readonly<Record<PersonName, readonly string[]>>;

/** A wall clock the suite can move forward. */
export type WorldClock = Readonly<{ now: Clock; advance(ms: number): void }>;

function worldClock(): WorldClock {
	let offset = 0;
	return {
		now: () => Date.now() + offset,
		advance(ms) {
			offset += ms;
		},
	};
}

/** An Ed25519 key held in memory, as a `Signer` and as a trust record's key reference. */
export type HeldKey = Readonly<{
	signer: Signer;
	ref(purpose: KeyPurpose): PublicKeyRef;
}>;

export function heldKey(keyId: string): HeldKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const id = parseKeyId(keyId);
	const raw = publicKey
		.export({ format: "der", type: "spki" })
		.subarray(-32)
		.toString("base64url");
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
				value: raw,
			}),
	};
}

/** What a bus provider hands the world: the authority's bus, how devices connect, and what discovery publishes. */
export type OpenedBus = Readonly<{
	bus: AuthorityBus;
	connector: FleetBusConnector;
	natsUrls: readonly string[];
	natsSentinelCredentials: string;
	/** Present only on the memory bus: the outage switch and the audit log double the witness answers through. */
	memory?: Readonly<{ connector: MemoryConnector; audit: AuditLogDouble }>;
	close(): Promise<void>;
}>;
export type BusProvider = (
	input: Readonly<{
		trust: TrustRecord;
		envelope: WitnessedEnvelope;
		authority: HeldKey;
		now: Clock;
	}>,
) => Promise<OpenedBus>;

/** The memory bus, with an audit log the world's witness can co-sign through. */
export const memoryBusProvider: BusProvider = async ({ envelope, now }) => {
	const memory = createMemoryBus(now);
	await memory.publisher.putTrust(envelope);
	const audit = createAuditLogDouble();
	const bus: AuthorityBus = { ...memory, audit: audit.log };
	const connector = createMemoryConnector(bus);
	return {
		bus,
		connector,
		natsUrls: [],
		natsSentinelCredentials: "",
		memory: { connector, audit },
		async close() {},
	};
};

/** Allow when the subject carries `fleet-admin` or a tag equal to the action; a device holding a role may declare (§6.5 "Sponsors"). */
function allowByTag(): PolicyEngine {
	const engineId = "fleet-acceptance";
	return {
		engineId,
		async evaluate(request) {
			const tags = request.subject.tags;
			const sponsor =
				request.action === "fleet.member.declare" &&
				tags.some((tag) => tag.startsWith("role:"));
			return sponsor ||
				tags.includes("fleet-admin") ||
				tags.includes(request.action)
				? allowDecision(engineId, request, ["tag"])
				: denyDecision(engineId, request, ["no tag"]);
		},
	};
}

/** The identity provider of the world: the code is `<kind>:<id>` of a person in the directory. */
function testProvider(): SignInProvider {
	return {
		id: "test",
		async begin(input) {
			return {
				url: `https://idp.test/authorize?state=${encodeURIComponent(input.state)}`,
			};
		},
		async complete(input) {
			const [kind, id] = input.code.split(":");
			if (kind === "user" && id !== undefined && id.length > 0)
				return { ok: true, value: { principal: { kind, id }, claims: {} } };
			return {
				ok: false,
				error: { code: "unauthenticated", message: "unknown code" },
			};
		},
	};
}

/** Accepts exactly one workload token (a fixed token id), for whatever audience the authority asks with. */
function workloadAssertions(now: Clock): IdentityAssertionVerifier {
	return {
		async verifyOidc(assertion) {
			if (assertion !== WORKLOAD_TOKEN)
				return {
					ok: false,
					error: { code: "unauthenticated", message: "not a workload token" },
				};
			// One token: its id is the same however often it is presented.
			const tokenId = "jti-1";
			return {
				ok: true,
				value: {
					issuer: WORKLOAD_ISSUER,
					subject: WORKLOAD_SUBJECT,
					tokenId,
					claims: {
						repository: "acme/app",
						exp: String(Math.floor(now() / 1000) + 300),
					},
				},
			};
		},
		verifyCertificateChain: () => ({
			ok: false,
			error: { code: "unauthenticated", message: "no device CA roots" },
		}),
	};
}

/** One HTTP exchange as the agent's fetch saw it, after the authority answered. */
export type Exchange = Readonly<{
	method: string;
	path: string;
	status: number;
}>;

export type FleetWorld = Awaited<ReturnType<typeof createFleetWorld>>;

export async function createFleetWorld(
	options: Readonly<{ bus?: BusProvider; log?: FleetLog }> = {},
) {
	const clock = worldClock();
	const now = clock.now;
	const authorityKey = heldKey("authority#1");
	const witnessKey = heldKey("witness#1");
	const trust = create(TrustRecordSchema, {
		tenant: TENANT,
		sequence: 1,
		authorityKeys: [authorityKey.ref(KeyPurpose.AUTHORITY)],
		witnessKeys: [witnessKey.ref(KeyPurpose.WITNESS)],
		authorityIncarnation: 1,
		issuer: ISSUER,
		jwksUri: `${ISSUER}/v1/fleet/jwks`,
		issuedAt: new Date(now()).toISOString(),
	});
	const payload = toBinary(TrustRecordSchema, trust);
	const envelope = create(WitnessedEnvelopeSchema, {
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
	const opened = await (options.bus ?? memoryBusProvider)({
		trust,
		envelope,
		authority: authorityKey,
		now,
	});

	const logged: {
		event: FleetLogEvent;
		fields: Readonly<Record<string, string | number | boolean>>;
	}[] = [];
	const log: FleetLog = (event, fields) => {
		logged.push({ event, fields });
		options.log?.(event, fields);
	};
	const store = createMemoryEventStore();
	const issuer = createMemoryCredentialIssuer(now);
	const deps: AuthorityDeps = {
		tenant: TENANT,
		store,
		bus: opened.bus,
		policy: allowByTag(),
		decisions: createPolicyDecisionRecorder(),
		issuer,
		directory: createStaticPrincipalDirectory(
			NAMES.map((name) => ({
				principal: `${PEOPLE[name].kind}:${PEOPLE[name].id}`,
				tenant: TENANT,
				tags: [...TAGS[name]],
			})),
		),
		accounts: {
			verify: async () => ({
				ok: false,
				error: { code: "unauthenticated", message: "no accounts" },
			}),
		},
		signIn: [testProvider()],
		assertions: workloadAssertions(now),
		recordSigner: authorityKey.signer,
		metering: createMeteringBus(),
		overlayMinters: [],
		incarnation: 1,
		now,
		log,
		discovery: {
			issuer: ISSUER,
			natsUrls: opened.natsUrls,
			natsSentinelCredentials: opened.natsSentinelCredentials,
			relayUrls: [],
			minAgentVersion: "0.0.0",
		},
	};
	const runtime = assembleAuthority(deps, { timers: false });
	runtime.start();
	await runtime.tickOnce();
	const handler = createAuthorityHandler({
		runtime,
		issuer: ISSUER,
		sessionKey: new Uint8Array(32).fill(7),
		credentials: issuer,
		store,
		registry: () => opened.bus.registry,
		replay: opened.bus.replay,
		now,
		log,
	});

	// The witness, co-signing checkpoints through the memory bus's audit log double.
	const witness =
		opened.memory === undefined
			? undefined
			: createWitness({
					log: opened.memory.audit.log,
					registryChanges: () => ({ async stop() {} }),
					trust: () => trust,
					signer: witnessKey.signer,
					publish: opened.memory.audit.publish,
					now,
					log2: log,
				});
	witness?.start();

	// The agents' fetch: every request through the real handler; the suite may drop an answer after the authority decided.
	const exchanges: Exchange[] = [];
	let drop: ((exchange: Exchange) => boolean) | undefined;
	let reachable = true;
	const fetchDouble: typeof fetch = async (input, init) => {
		if (!reachable)
			throw new TypeError("fetch failed: the authority is unreachable");
		const request = new Request(input, init);
		const response = await handler(request);
		const exchange = {
			method: request.method,
			path: new URL(request.url).pathname,
			status: response.status,
		};
		exchanges.push(exchange);
		if (drop?.(exchange) === true)
			throw new TypeError(
				"fetch failed: the connection reset before the answer",
			);
		return response;
	};

	const person = async (name: PersonName, key = generateDpopKey()) => {
		const principal = PEOPLE[name];
		const issued = await issuer.issuePerson({
			principal,
			tenant: TENANT,
			tags: TAGS[name],
			jkt: jwkThumbprint(key.publicJwk),
			ttlMs: 15 * 60_000,
		});
		const verified = issuer.verify(issued.token, ISSUER, now());
		if (!verified.ok) throw new Error(verified.error.message);
		return { token: issued.token, key, caller: verified.value };
	};

	const defineFleet = async (
		fleetId: string,
		owner: PersonName,
		policy: Partial<Omit<FleetPolicy, "$typeName">> = {},
		coordination = CoordinationMode.MANY_ACTIVE,
	) => {
		const { caller } = await person(owner);
		const defined = await runtime.authority.defineFleet(
			create(FleetRecordSchema, {
				fleetId,
				tenant: TENANT,
				owner: `${PEOPLE[owner].kind}:${PEOPLE[owner].id}`,
				coordination,
				policy: create(FleetPolicySchema, {
					approval: ApprovalMode.AUTO_OWNER,
					...policy,
				}),
			}),
			caller,
		);
		if (!defined.ok)
			throw new Error(
				`defineFleet: ${defined.error.code} ${defined.error.message}`,
			);
		await runtime.tickOnce();
	};

	const token = async (
		fleet: string,
		name: string,
		roles: readonly Role[],
		by: PersonName = "dev",
		deviceClass = DeviceClass.DEDICATED,
	) => {
		const { caller } = await person(by);
		const issued = await runtime.authority.issueToken(
			create(TokenCreateRequestSchema, {
				fleet,
				name,
				displayName: name,
				deviceClass,
				roles: [...roles],
				ttlSeconds: 900,
			}),
			caller,
		);
		if (!issued.ok)
			throw new Error(
				`issueToken: ${issued.error.code} ${issued.error.message}`,
			);
		return issued.value.token;
	};

	const agents: ReturnType<typeof createFleetAgent>[] = [];
	const agent = (
		input: Readonly<{
			keys?: KeyStore | undefined;
			runners?: readonly WorkRunner[];
			sources?: (
				current: () => ReturnType<typeof createFleetAgent> | undefined,
			) => readonly WorkSource[];
			sandboxes?: readonly SandboxDriver[] | undefined;
			egress?: EgressProxyFactory | undefined;
			slots?: number;
			log?: FleetLog;
		}> = {},
	) => {
		const keys = input.keys ?? createMemoryKeyStore();
		let built: ReturnType<typeof createFleetAgent> | undefined;
		const deps: AgentDeps = {
			keys,
			authorityUrl: ISSUER,
			tenant: TENANT,
			connector: opened.connector,
			capacity: slots(input.slots ?? 2),
			runners: input.runners ?? [],
			sources: input.sources?.(() => built) ?? [],
			sandboxes: input.sandboxes ?? [
				createFakeSandboxDriver(SandboxTier.S1_CONTAINER),
			],
			egress: input.egress ?? closedEgress,
			transports: [],
			agentVersion: "1.0.0",
			now,
			log: input.log ?? log,
			fetch: fetchDouble,
		};
		built = createFleetAgent(deps);
		agents.push(built);
		return { agent: built, keys };
	};

	return {
		clock,
		now,
		trust,
		envelope,
		authorityKey,
		witnessKey,
		deps,
		store,
		issuer,
		bus: opened.bus,
		opened,
		runtime,
		authority: runtime.authority,
		handler,
		fetch: fetchDouble,
		exchanges,
		logged,
		person,
		defineFleet,
		token,
		agent,
		fleetId: parseFleetId,
		/** Drop the answers this predicate selects (the authority has already decided). */
		dropAnswers(next: ((exchange: Exchange) => boolean) | undefined) {
			drop = next;
		},
		authorityReachable(value: boolean) {
			reachable = value;
		},
		async stop() {
			for (const running of agents.splice(0))
				await running.stop().catch(() => undefined);
			await witness?.stop();
			await runtime.stop();
			await opened.close();
		},
	};
}

/** The caller a member's SIGN key proves, as `authenticate` yields it. */
export function memberCaller(
	memberId: MemberId,
	signPublicKey: string,
	nowMs: number,
): VerifiedToken {
	return {
		kind: "member",
		memberId,
		tenant: TENANT,
		jkt: jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: signPublicKey }),
		expiresAtMs: nowMs + 60_000,
	};
}

export function slots(count: number): CapacitySource {
	return {
		async read() {
			return {
				capacity: create(CapacitySchema, {
					freeSlots: count,
					totalSlots: count,
				}),
				health: Health.REACHABLE,
				labels: [],
			};
		},
	};
}

/** An egress proxy that allows nothing: the in-memory work needs no network. */
export const closedEgress: EgressProxyFactory = {
	async open() {
		return { url: "http://egress.invalid:3128", async close() {} };
	},
};

/** A live view of whichever bus the agent holds now, for a work source built before the agent connects. */
export { liveBus } from "./live-bus.js";
