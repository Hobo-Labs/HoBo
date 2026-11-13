/**
 * The frozen ports of HoBo Fleet (ADR-0182, design §7.3), verbatim.
 *
 * Record types are the generated ones from `./_generated/fleet_pb.js`; the
 * branded ids come from `./ids.js`. Only the coordinator edits this file; a
 * lane that finds a contract wrong reports it under `requirementChanges`.
 */

import type {
	EphemeralKey,
	EventInput,
	EventPosition,
	EventStore,
	MeteringBus,
	PolicyDecision,
	PolicyEngine,
	PolicyRequest,
	PositionedEvent,
	PrincipalRef,
	TenantId,
} from "@hobo/core";
import type {
	ApprovalDecision,
	ApprovalResult,
	ApprovalView,
	AuditCheckpoints,
	AuditEntries,
	AuditEntry,
	AuthorityDiscovery,
	Capacity,
	CoordinationMode,
	CredentialRequest,
	CredentialResponse,
	DeclareRequest,
	Discovery,
	EnrollmentRequest,
	EnrollmentResponse,
	FleetList,
	FleetPolicy,
	FleetRecord,
	FleetVerdict,
	FleetView,
	Health,
	KeyAlgorithm,
	KeyRotationRequest,
	LifecycleRequest,
	MemberKind,
	MemberList,
	MemberRecord,
	MembershipRequest,
	Observation,
	OverlayJoin,
	PersonCredential,
	ReceiptStatus,
	SandboxTier,
	SealedBox,
	SessionGrant,
	SessionRequest,
	SignedEnvelope,
	SignInCallback,
	SignInChallenge,
	SignInComplete,
	SignInDeviceCode,
	SignInPoll,
	SignInRefresh,
	SignInStart,
	TokenCreateRequest,
	TokenCreateResponse,
	TokenList,
	TrustRecord,
	ViolationReport,
	WitnessedEnvelope,
	WorkLogs,
	WorkNeeds,
	WorkOffer,
	WorkOrder,
	WorkOrigin,
	WorkStatus,
	WorkSubmissionRequest,
} from "./_generated/fleet_pb.js";
import type { createAuditChain } from "./audit/index.js";
import type { FLEET_CONTEXTS } from "./contexts.js";
import type { FleetErrorCode } from "./errors.js";
import type { FLEET_LOG_EVENTS } from "./events.js";
import type {
	FleetId,
	KeyId,
	MemberId,
	MemberName,
	WorkDigest,
} from "./ids.js";
import type {
	createRecorder,
	createRegistryProjection,
} from "./recorder/index.js";
import type { createSignIn } from "./signin/index.js";
import type { checkClaim } from "./work/index.js";

export type Outcome<T> = Readonly<
	{ ok: true; value: T } | { ok: false; error: FleetFailure }
>;
export type FleetFailure = Readonly<{
	code: FleetErrorCode;
	message: string;
	detail?: Readonly<Record<string, string>>;
}>;
/** `FLEET_LOG_EVENTS` in events.ts holds exactly the names listed at the end of §7.5. */
export type FleetLogEvent = (typeof FLEET_LOG_EVENTS)[number];
export type FleetLog = (
	event: FleetLogEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;
/** `FLEET_CONTEXTS` in contexts.ts holds exactly the context strings of the §7.4 table plus "hobo-fleet/order-secret/v1". */
export type FleetContext = (typeof FLEET_CONTEXTS)[number];
/** A public key as RFC 7517 JSON, after parsePublicJwk. Never carries private members. */
export type PublicJwk = Readonly<
	| { kty: "EC"; crv: "P-256"; x: string; y: string }
	| { kty: "OKP"; crv: "Ed25519"; x: string }
>;
export type Clock = () => number; // epoch milliseconds
export interface Subscription {
	stop(): Promise<void>;
}
/**
 * The event store every authority-side component uses: the core port plus an ordered read of
 * every stream, which the audit chain, projection rebuild and recorder catch-up need.
 * `@hobo/runtime-local`'s `DurableEventStore` satisfies it as it is; the journal store implements it.
 */
export type FleetEventStore = EventStore &
	Readonly<{
		readAll(
			options?: Readonly<{ after?: EventPosition; limit?: number }>,
		): AsyncIterable<PositionedEvent>;
	}>;
/** Where an authority-side bus subscription starts: every retained message, only new ones, or after a stream sequence. */
export type BusStart = "start" | "new" | Readonly<{ after: number }>;

// ── Keys (devices) ─────────────────────────────────────────────────────────
export interface Signer {
	readonly keyId: KeyId;
	readonly algorithm: KeyAlgorithm;
	sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export type DeviceKeys = Readonly<{
	memberId: MemberId;
	identityJwk: string;
	identity: Signer;
	sign: Signer;
	/** The SIGN key's public half: raw Ed25519, base64url, no padding. A device builds its key bundle from it. */
	signPublicKey: string;
	sealPublicKey: string;
	openSealed(
		box: SealedBox,
		context: string,
		associatedData: Uint8Array,
	): Promise<Uint8Array>;
	agree(peerSealPublicKey: string): Promise<Uint8Array>; // raw X25519 shared secret
	heldKey: boolean;
}>;
export type AgentState = Readonly<{
	generation: number;
	pendingRefreshNonce: Uint8Array | undefined;
	trust: WitnessedEnvelope | undefined; // the pinned trust record
	lastSequence: Readonly<Record<string, number>>; // per stream, for resuming consumers
	seenOrderIds: readonly string[]; // bounded to the order stream's max age
	pendingReceipts: readonly SignedEnvelope[]; // signed receipts not yet published, oldest first (F4)
}>;
export interface KeyStore {
	/** Creates the identity and operational keys if absent. Never returns private material. */
	open(): Promise<DeviceKeys>;
	readState(): Promise<AgentState>;
	writeState(next: AgentState): Promise<void>; // atomic replace
	rotateOperational(): Promise<DeviceKeys>;
	destroy(): Promise<void>;
}

// ── Registry ───────────────────────────────────────────────────────────────
/**
 * Every implementation verifies envelopes, expiry and record sequence against the pinned trust record
 * before returning; callers receive only verified records. Two exceptions to signature checking, both
 * unsigned by design: the in-memory view of `createMemoryBus` (tests only) decodes without verifying
 * signatures, and the local-mode view of `createLocalFleet` holds records it built itself. The in-memory
 * view still refuses a record past its `not_after` (against its injected clock) and one whose
 * `record_sequence` is lower than the highest it has returned for that key, so it passes runBusConformance.
 */
export interface RegistryView {
	member(id: MemberId): Promise<MemberRecord | undefined>;
	fleet(id: FleetId): Promise<FleetRecord | undefined>;
	membersOf(id: FleetId): Promise<readonly MemberRecord[]>;
	/** Every fleet and every member of this tenant; for list routes, the recorder and the projection. */
	fleets(): Promise<readonly FleetRecord[]>;
	members(): Promise<readonly MemberRecord[]>;
	view(id: FleetId): Promise<FleetView | undefined>;
	trust(): TrustRecord;
	/** The pinned record as it was received, for Discovery and CredentialResponse. Undefined in local mode. */
	trustEnvelope(): WitnessedEnvelope | undefined;
	caughtUp(): Promise<void>;
}
export interface RegistryPublisher {
	putMember(record: SignedEnvelope, id: MemberId): Promise<void>;
	putFleet(record: SignedEnvelope, id: FleetId): Promise<void>;
	putView(view: SignedEnvelope, id: FleetId): Promise<void>;
	putTrust(trust: WitnessedEnvelope): Promise<void>;
}

// ── Authority-side issuers and verifiers ───────────────────────────────────
export type VerifiedToken = Readonly<
	| {
			kind: "member";
			memberId: MemberId;
			tenant: TenantId;
			jkt: string;
			expiresAtMs: number;
	  }
	| {
			kind: "person";
			principal: PrincipalRef;
			tenant: TenantId;
			tags: readonly string[];
			jkt: string;
			expiresAtMs: number;
	  }
	/** The relay's account credential, through AccountCredentialVerifier: read routes and POST /work only. */
	| {
			kind: "account";
			principal: PrincipalRef;
			tenant: TenantId;
			scopes: readonly string[];
	  }
	/** A workload OIDC token, through IdentityAssertionVerifier.verifyOidc: the verdict route (a GitHub Actions token), and members:declare when an oidc_trust rule with `sponsor` matches. */
	| {
			kind: "workload";
			issuer: string;
			subject: string;
			repository: string;
			tenant: TenantId;
			expiresAtMs: number;
	  }
>;
export interface CredentialIssuer {
	issueMember(
		input: Readonly<{
			member: MemberRecord;
			audiences: readonly string[];
			jkt: string;
			ttlMs: number;
		}>,
	): Promise<Readonly<{ token: string; expiresAtMs: number }>>;
	issuePerson(
		input: Readonly<{
			principal: PrincipalRef;
			tenant: TenantId;
			tags: readonly string[];
			jkt: string;
			ttlMs: number;
		}>,
	): Promise<Readonly<{ token: string; expiresAtMs: number }>>;
	/** Accepts only tokens signed by this issuer's own keys. */
	verify(
		token: string,
		audience: string,
		nowMs: number,
	): Outcome<VerifiedToken>;
	jwks(): string;
}
export interface PrincipalDirectory {
	tenantsOf(
		principal: PrincipalRef,
		claims: Readonly<Record<string, string>>,
	): Promise<
		readonly Readonly<{
			tenant: TenantId;
			tags: readonly string[];
			aliases: readonly string[];
		}>[]
	>;
}
export interface AccountCredentialVerifier {
	verify(bearer: string): Promise<
		Outcome<
			Readonly<{
				principal: PrincipalRef;
				tenant: TenantId;
				scopes: readonly string[];
			}>
		>
	>;
}
export interface SignInProvider {
	readonly id: string; // "oidc" | "github" | "atproto"
	begin(
		input: Readonly<{
			state: string;
			redirectUri: string;
			codeChallenge: string;
		}>,
	): Promise<Readonly<{ url: string }>>;
	complete(
		input: Readonly<{
			code: string;
			state: string;
			redirectUri: string;
			codeVerifier: string;
		}>,
	): Promise<
		Outcome<
			Readonly<{
				principal: PrincipalRef;
				claims: Readonly<Record<string, string>>;
			}>
		>
	>;
}
export interface IdentityAssertionVerifier {
	verifyOidc(
		assertion: string,
		expectedAudience: string,
	): Promise<
		Outcome<
			Readonly<{
				issuer: string;
				subject: string;
				tokenId: string;
				claims: Readonly<Record<string, string>>;
			}>
		>
	>;
	verifyCertificateChain(
		input: Readonly<{
			chainPem: readonly string[];
			identityJwk: string;
			rootsPem: readonly string[];
			nowMs: number;
		}>,
	): Outcome<Readonly<{ digest: string }>>;
}
export interface OverlayCredentialMinter {
	readonly provider: "tailscale" | "netbird";
	mint(
		input: Readonly<{
			tenant: TenantId;
			memberId: MemberId;
			tags: readonly string[];
			ttlMs: number;
		}>,
	): Promise<Outcome<OverlayJoin>>;
}
export interface ReplayStore {
	/** True the first time a (scope, id) pair is seen before `expiresAtMs`. */
	firstUse(scope: string, id: string, expiresAtMs: number): Promise<boolean>;
}
/** Builds the `policy.Decided` event. Implemented in @hobo/fleet-authority with @hobo/policy, which this package may not import. */
export interface PolicyDecisionRecorder {
	toEvent(request: PolicyRequest, decision: PolicyDecision): EventInput;
}
export interface AuditLog {
	append(entry: AuditEntry): Promise<void>;
	appendCheckpoint(checkpoint: SignedEnvelope): Promise<void>;
	entries(
		fromSequence: number,
		toSequence: number,
	): Promise<readonly AuditEntry[]>;
	onWitnessed(
		handler: (checkpoint: WitnessedEnvelope) => Promise<void>,
	): Subscription;
	/** Witness (optional, amendment 2): authority-signed checkpoints as appended, before co-signature. */
	onCheckpoint?(
		handler: (checkpoint: SignedEnvelope) => Promise<void>,
	): Subscription;
	/** Authority: publish a new authority-signed trust record on fleet.audit.trust for co-signature. */
	proposeTrust(record: SignedEnvelope): Promise<void>;
	/** Witness: proposed trust records, in stream order. */
	onTrustProposed(
		handler: (record: SignedEnvelope) => Promise<void>,
	): Subscription;
	/** Authority: trust records the witness has co-signed. */
	onTrustWitnessed(
		handler: (trust: WitnessedEnvelope) => Promise<void>,
	): Subscription;
}

// ── The bus (in memory in @hobo/fleet, over NATS in @hobo/fleet-nats) ──────
// Every `subscribe` takes `from` and hands its handler the stream sequence of each message, so the
// authority's recorder can resume after an outage ("recording catches up", §6.9). Devices pass "new"
// or { after } from AgentState.lastSequence.
export type KeyedEnvelope = Readonly<{
	observerId: MemberId;
	memberId: MemberId;
	envelope: SignedEnvelope;
}>;
export interface ObservationBoard {
	publish(
		observation: SignedEnvelope,
		observer: MemberId,
		member: MemberId,
	): Promise<void>;
	read(
		limit: number,
	): Promise<
		Readonly<{ observations: readonly KeyedEnvelope[]; capped: boolean }>
	>;
}
export interface ClaimLedger {
	/** First writer wins, enforced by the store. */
	claim(
		claim: SignedEnvelope,
		fleet: FleetId,
		digest: WorkDigest,
	): Promise<"claimed" | "held">;
	holder(
		fleet: FleetId,
		digest: WorkDigest,
	): Promise<SignedEnvelope | undefined>;
	subscribe(
		fleets: readonly FleetId[],
		from: BusStart,
		handler: (
			claim: SignedEnvelope,
			fleet: FleetId,
			digest: WorkDigest,
			sequence: number,
		) => Promise<void>,
	): Subscription;
	/** Dispatcher only. */
	remove(fleet: FleetId, digest: WorkDigest): Promise<void>;
}
export interface OfferFeed {
	publish(offer: SignedEnvelope, fleet: FleetId): Promise<void>;
	subscribe(
		fleets: readonly FleetId[],
		from: BusStart,
		handler: (offer: SignedEnvelope, sequence: number) => Promise<void>,
	): Subscription;
}
export interface SubmissionFeed {
	publish(submission: SignedEnvelope, fleet: FleetId): Promise<void>;
	subscribe(
		fleets: readonly FleetId[],
		from: BusStart,
		handler: (submission: SignedEnvelope, sequence: number) => Promise<void>,
	): Subscription;
}
export interface OrderChannel {
	deliver(order: SignedEnvelope, to: MemberId): Promise<void>;
	subscribe(
		self: MemberId,
		from: BusStart,
		handler: (order: SignedEnvelope, sequence: number) => Promise<void>,
	): Subscription;
	/** Authority recorder only: every order's envelope, in stream order. */
	observeAll(
		from: BusStart,
		handler: (
			order: SignedEnvelope,
			to: MemberId,
			sequence: number,
		) => Promise<void>,
	): Subscription;
}
/** Event kinds: "receipt" | "log" | "session-close". */
export interface EventChannel {
	publish(event: SignedEnvelope, from: MemberId, kind: string): Promise<void>;
	subscribe(
		kinds: readonly string[],
		from: BusStart,
		handler: (
			event: SignedEnvelope,
			member: MemberId,
			kind: string,
			sequence: number,
		) => Promise<void>,
	): Subscription;
}
export interface ControlChannel {
	send(control: SignedEnvelope, to: MemberId): Promise<void>;
	subscribe(
		self: MemberId,
		from: BusStart,
		handler: (control: SignedEnvelope, sequence: number) => Promise<void>,
	): Subscription;
}
/** Plain publish-subscribe on fleet.relay.<to>.<sessionId>; no stream, no sequence. Frames are already encrypted by the bus-relay transport. */
export interface RelayChannel {
	send(to: MemberId, sessionId: string, frame: Uint8Array): Promise<void>;
	subscribe(
		self: MemberId,
		handler: (sessionId: string, frame: Uint8Array) => Promise<void>,
	): Subscription;
}
/** What a device holds. */
export type FleetBus = Readonly<{
	registry: RegistryView;
	observations: ObservationBoard;
	claims: ClaimLedger;
	offers: OfferFeed;
	submissions: SubmissionFeed;
	orders: OrderChannel;
	events: EventChannel;
	control: ControlChannel;
	relay: RelayChannel;
	status(): "connected" | "disconnected" | "closed";
	close(): Promise<void>;
}>;
/** What the authority holds: the same ports plus the writers only it has. */
export type AuthorityBus = FleetBus &
	Readonly<{
		publisher: RegistryPublisher;
		audit: AuditLog;
		replay: ReplayStore;
	}>;
export interface FleetBusConnector {
	/** Connects as this device. `trust` is the pinned record every registry read is verified against; `ticket` is called for each connection attempt. */
	connect(
		input: Readonly<{
			discovery: Discovery;
			keys: DeviceKeys;
			trust: WitnessedEnvelope;
			ticket: () => Promise<SignedEnvelope>;
			resumeFrom: Readonly<Record<string, number>>;
			log: FleetLog;
		}>,
	): Promise<FleetBus>;
}

// ── Many-active work ───────────────────────────────────────────────────────
export type UpstreamWork = Readonly<{
	workKey: string;
	label: string;
	needs: WorkNeeds;
	author: string;
	origin: WorkOrigin;
	repository: string;
	ref: string;
	workflowDigest: string;
	queuedAtMs: number;
	submission?: SignedEnvelope;
}>;
export interface WorkSource {
	readonly kind: string;
	poll(fleet: FleetRecord): Promise<readonly UpstreamWork[]>;
	/** Builds the non-secret parameters and the bootstrap secret for one claimant. */
	prepare(
		offer: WorkOffer,
		claimant: MemberRecord,
	): Promise<
		Outcome<
			Readonly<{
				parameters: Readonly<Record<string, string>>;
				secret: Uint8Array;
				egressAllow: readonly string[];
			}>
		>
	>;
	stillWanted(offer: WorkOffer): Promise<boolean>;
}
/** Facts read from the upstream platform's own job context inside the sandbox. */
export type ObservedAssignment = Readonly<{
	workKey: string;
	repository: string;
	ref: string;
	author: string;
	origin: WorkOrigin;
}>;
export interface WorkRunner {
	readonly kind: string;
	run(
		input: Readonly<{
			order: WorkOrder;
			secret: Uint8Array;
			sandbox: Sandbox;
			signal: AbortSignal;
			onLog(chunk: Uint8Array): void;
			log: FleetLog;
		}>,
	): Promise<
		Readonly<{
			status: ReceiptStatus;
			reason: string;
			outputDigest: string;
			observedWorkKey: string;
		}>
	>;
}
export interface SandboxDriver {
	readonly tier: SandboxTier;
	/** Self-test run at agent start; a failing driver is not advertised. */
	available(): Promise<Outcome<Readonly<{ providesDocker: boolean }>>>;
	create(
		input: Readonly<{
			orderId: string;
			image: string;
			limits: Readonly<{
				memoryMb: number;
				cpus: number;
				pids: number;
				diskMb: number;
			}>;
			egressProxyUrl: string;
			readOnlyMounts: readonly Readonly<{ source: string; target: string }>[];
			hostDocker: boolean;
			fence: (observed: ObservedAssignment) => Promise<boolean>;
		}>,
	): Promise<Sandbox>;
}
export interface Sandbox {
	readonly id: string;
	readonly tier: SandboxTier;
	/** A URL reachable only from inside this sandbox. `POST <controlUrl>/fence` with an `ObservedAssignment` as JSON answers `{"allow":true|false}` from the `fence` callback. */
	readonly controlUrl: string;
	exec(
		input: Readonly<{
			argv: readonly string[];
			env: Readonly<Record<string, string>>;
			stdin?: Uint8Array;
			signal: AbortSignal;
			onOutput(chunk: Uint8Array): void;
		}>,
	): Promise<Readonly<{ exitCode: number }>>;
	writeSecret(path: string, bytes: Uint8Array): Promise<void>; // never through argv or env
	destroy(): Promise<void>;
}
/** One proxy per order (§6.11 "Egress"): exact hosts in `allow` only; link-local and metadata addresses always refused. Its `url` is what SandboxDriver.create receives as `egressProxyUrl`. */
export interface EgressProxyFactory {
	open(
		allow: readonly string[],
	): Promise<Readonly<{ url: string; close(): Promise<void> }>>;
}
export interface CapacitySource {
	read(): Promise<
		Readonly<{ capacity: Capacity; health: Health; labels: readonly string[] }>
	>;
}

// ── One-active assignment (moved from @hobo/backend-fleet, names kept) ─────
export type FailureClassifier = (error: Error | undefined) => Health; // one of UNREACHABLE, QUOTA_EXHAUSTED, AUTH, UNKNOWN
/** domain-view: today's FleetAssignment (backend-fleet/src/assignment.ts:45) plus `members` (undefined for every entry written without membership epochs); plain numbers and undefined, not the wire's types. Built only by parseAssignmentEntry. */
export type AssignmentEntry = Readonly<{
	epoch: number;
	active: MemberName | undefined;
	sealed: boolean;
	target: MemberName | undefined;
	reason: string;
	lossWindowMs: number | undefined;
	decidedAtMs: number;
	decidedBy: string;
	members: readonly MemberName[] | undefined;
}>;
/** What a proposer chooses; the register supplies epoch, time and author (today's FleetAssignmentValue). */
export type AssignmentValue = Readonly<{
	active: MemberName | undefined;
	sealed: boolean;
	target: MemberName | undefined;
	reason: string;
	lossWindowMs: number | undefined;
}>;
/** As today (assignment.ts:148-163): `gap` = the log is too short to take it; `busy` = a copy into that member is in progress. */
export type AssignmentAcceptOutcome =
	| "accepted"
	| "duplicate"
	| "conflict"
	| "gap"
	| "busy";
export type AssignmentReplica = Readonly<{
	id: MemberName;
	/** Entries in ascending epoch order; `limit` keeps only the highest ones. */
	read(limit?: number): Promise<readonly AssignmentEntry[]>;
	accept(entry: AssignmentEntry): Promise<AssignmentAcceptOutcome>;
	/** Present on replicas whose log can expire (the cache-key replica): reset its lifetime; false when the log is absent. */
	refresh?(): Promise<boolean>;
	/** Present on replicas whose log can be lost: start an empty log at `entry`. Only rejoinAssignmentReplicas calls it. */
	seed?(entry: AssignmentEntry): Promise<"seeded" | "not-empty">;
}>;
/** The members of one fleet's register, in configured order. Built by parseAssignmentRegister. */
export type AssignmentRegister = Readonly<{
	replicas: readonly AssignmentReplica[];
	classify?: FailureClassifier;
}>;
export type AssignmentReply = Readonly<
	| { replica: MemberName; rows: readonly AssignmentEntry[] }
	| { replica: MemberName; failure: Health }
>;
export type AssignmentContender = Readonly<{
	assignment: AssignmentEntry;
	holders: readonly MemberName[];
}>;
/** As today (assignment.ts:185-206). */
export type AssignmentResolution = Readonly<
	| {
			status: "current";
			assignment: AssignmentEntry;
			holders: readonly MemberName[];
			behind: readonly MemberName[];
			silent: readonly MemberName[];
	  }
	| { status: "empty"; silent: readonly MemberName[] }
	| {
			status: "undecided";
			epoch: number;
			contenders: readonly AssignmentContender[];
			silent: readonly MemberName[];
	  }
	| {
			status: "no-majority";
			answered: number;
			required: number;
			silent: readonly MemberName[];
	  }
>;
/** As today (assignment.ts:407-431). */
export type AssignmentProposalOutcome = Readonly<
	| {
			status: "decided" | "undecided";
			assignment: AssignmentEntry;
			holders: readonly MemberName[];
	  }
	| { status: "stale" | "unavailable"; resolution: AssignmentResolution }
	| {
			status: "refused";
			replica: MemberName;
			outcome: AssignmentAcceptOutcome | "silent" | "not-a-member";
	  }
>;
export type AssignmentProposal = Readonly<{
	expectedEpoch: number;
	value: AssignmentValue;
	decidedBy: string;
	nowMs: number;
}>;
export type AssignmentOverride = Readonly<{
	value: AssignmentValue;
	decidedBy: string;
	nowMs: number;
}>;
export type RejoinOutcome = Readonly<{
	replica: MemberName;
	outcome: "seeded" | "not-empty" | "unproven" | "silent";
}>;
export type EphemeralAssignmentReplica = AssignmentReplica &
	Readonly<{
		key: EphemeralKey;
		refresh(): Promise<boolean>;
		seed(entry: AssignmentEntry): Promise<"seeded" | "not-empty">;
	}>;
export type EphemeralAssignmentReplicaOptions = Readonly<{
	key?: string;
	ttlMs?: number;
	maxEntries?: number;
}>;
/** An observation with the member's name in the fleet being decided (names are per fleet; an Observation carries only member_id). */
export type NamedObservation = Readonly<{
	name: MemberName;
	observation: Observation;
}>;
/** eligibleForActive's answer for one member: the health verdict only, with today's reason strings. */
export type EligibleMember = Readonly<{
	name: MemberName;
	eligible: boolean;
	reasons: readonly string[];
}>;
export type OneActiveAction = Readonly<
	| { action: "keep" | "hold"; reasons: readonly string[] }
	| {
			action: "switch" | "failover";
			target: MemberName;
			lossWindowMs: number | undefined;
			reasons: readonly string[];
	  }
>;
/** What one tick did (today's CacheFleetTick, cache-fleet.ts:201-215, plus `membership`). `route` is chooseAction's answer when it was asked. */
export type OneActiveTick = Readonly<{
	action:
		| "single"
		| "bootstrap"
		| "activate"
		| "sealed-waiting"
		| "reseal"
		| "keep"
		| "hold"
		| "switch"
		| "failover"
		| "no-majority"
		| "undecided"
		| "membership";
	epoch: number;
	active: MemberName | undefined;
	target: MemberName | undefined;
	reasons: readonly string[];
	route?: OneActiveAction;
}>;
export type OneActiveDeps = Readonly<{
	fleet: FleetRecord;
	registry: RegistryView;
	register: AssignmentRegister;
	/** The loop pairs each answer with the member's name in this fleet. */
	observe(member: MemberRecord): Promise<Observation>;
	/** Cost-based choosing, from @hobo/backend-routing or any other policy. `members` is the configured order (the last tie-break); the callback derives the period's workload from the observations' usage itself. For a reseal it is asked as a failover from the sealed target. */
	chooseAction(
		input: Readonly<{
			assignment: AssignmentEntry;
			members: readonly MemberName[];
			observations: readonly NamedObservation[];
			eligibility: readonly EligibleMember[];
			nowMs: number;
		}>,
	): Promise<OneActiveAction>;
	scheduleActivation(epoch: number, afterMs: number): Promise<void>;
	decidedBy: string;
	sealWaitMs: number;
	/** How long `active()` reuses its last answer: when decided, and when refused. */
	viewTtlMs: number;
	refusedTtlMs: number;
	now: Clock;
	log: FleetLog;
}>;

// ── Transport ──────────────────────────────────────────────────────────────
export type TransportKind = "p2p" | "overlay" | "bus-relay";
export interface FleetStream {
	readonly peer: string; // the authenticated transport identity
	read(): AsyncIterable<Uint8Array>;
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<Readonly<{ bytesSent: number; bytesReceived: number }>>;
}
export interface FleetTransport {
	readonly kind: TransportKind;
	start(keys: DeviceKeys): Promise<Readonly<{ transportIdentity: string }>>;
	dial(
		input: Readonly<{ grant: SignedEnvelope; signal: AbortSignal }>,
	): Promise<Outcome<FleetStream>>;
	/** `authorise` is called with the peer's proven identity and its presented grant before any byte is delivered. */
	accept(
		authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>,
		handler: (stream: FleetStream, grant: SessionGrant) => Promise<void>,
	): Subscription;
	stop(): Promise<void>;
}

// ── Composition ────────────────────────────────────────────────────────────
export type AuthorityDeps = Readonly<{
	tenant: TenantId;
	store: FleetEventStore;
	bus: AuthorityBus;
	policy: PolicyEngine;
	decisions: PolicyDecisionRecorder;
	issuer: CredentialIssuer;
	directory: PrincipalDirectory;
	accounts: AccountCredentialVerifier;
	signIn: readonly SignInProvider[];
	assertions: IdentityAssertionVerifier;
	recordSigner: Signer;
	metering: MeteringBus;
	overlayMinters: readonly OverlayCredentialMinter[];
	incarnation: number;
	now: Clock;
	log: FleetLog;
	/** What Discovery publishes besides the trust envelope (which comes from bus.registry.trustEnvelope()). */
	discovery: Readonly<{
		issuer: string;
		natsUrls: readonly string[];
		natsSentinelCredentials: string;
		relayUrls: readonly string[];
		minAgentVersion: string;
	}>;
}>;
export type AgentDeps = Readonly<{
	keys: KeyStore;
	authorityUrl: string;
	tenant: TenantId;
	connector: FleetBusConnector;
	capacity: CapacitySource;
	runners: readonly WorkRunner[];
	sources: readonly WorkSource[];
	sandboxes: readonly SandboxDriver[];
	egress: EgressProxyFactory;
	transports: readonly FleetTransport[];
	agentVersion: string;
	now: Clock;
	log: FleetLog;
	fetch: typeof fetch;
	/** Members this device sponsors and observes (a relay host and its backends). The agent signs and publishes each observation with its SIGN key. */
	sponsored?: readonly Readonly<{
		memberId: MemberId;
		observe(): Promise<Observation>;
	}>[];
}>;

// ── The authority's API: one method per route of §6.15 ────────────────────
type Empty = Readonly<Record<string, never>>;
// Amendment 2: the default was `Empty` (Record<string, never>), which collapsed every id field to `never`.
type ById<
	K extends string,
	T extends object = Readonly<Record<never, never>>,
> = Readonly<Record<K, string>> & T;
/** Method name: [request, response]. The comment is the route. Responses typed SignedEnvelope carry the record named. */
export type FleetApi = {
	authorityDiscovery: [Empty, AuthorityDiscovery]; // GET  /.well-known/hobo-fleet
	discovery: [Readonly<{ tenant: TenantId }>, Discovery]; // GET  /v1/fleet/tenants/{tenant}/discovery
	jwks: [Empty, Readonly<{ jwks: string }>]; // GET  /v1/fleet/jwks
	signInStart: [SignInStart, SignInChallenge]; // POST /v1/fleet/signin/start
	signInCallback: [SignInCallback, ApprovalView]; // GET  /v1/fleet/signin/callback (browser)
	signInDevice: [SignInDeviceCode, SignInChallenge]; // POST /v1/fleet/signin/device (browser)
	approval: [ById<"state">, ApprovalView]; // GET  /v1/fleet/approve/{state} (browser)
	approve: [ApprovalDecision, ApprovalResult]; // POST /v1/fleet/approve/{state} (browser)
	signInComplete: [SignInComplete, PersonCredential]; // POST /v1/fleet/signin/complete
	signInPoll: [SignInPoll, PersonCredential]; // POST /v1/fleet/signin/device/poll
	signInRefresh: [SignInRefresh, PersonCredential]; // POST /v1/fleet/signin/refresh
	issueToken: [TokenCreateRequest, TokenCreateResponse]; // POST /v1/fleet/tokens
	listTokens: [Empty, TokenList]; // GET  /v1/fleet/tokens
	revokeToken: [ById<"tokenHash">, TokenList]; // DELETE /v1/fleet/tokens/{hash}
	enroll: [EnrollmentRequest, EnrollmentResponse]; // POST /v1/fleet/members
	declare: [DeclareRequest, EnrollmentResponse]; // POST /v1/fleet/members:declare
	approveKey: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope]; // POST /v1/fleet/members/{id}/approve-key
	accept: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope]; // POST …/accept
	reject: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope]; // POST …/reject
	suspend: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope]; // POST …/suspend
	resume: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope]; // POST …/resume
	unlock: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope]; // POST …/unlock
	revoke: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope]; // POST …/revoke
	assign: [ById<"memberId", { request: MembershipRequest }>, SignedEnvelope]; // POST /v1/fleet/members/{id}/memberships
	credentials: [
		ById<"memberId", { request: CredentialRequest }>,
		CredentialResponse,
	]; // POST /v1/fleet/members/{id}/credentials
	rotateKeys: [
		ById<"memberId", { request: KeyRotationRequest }>,
		SignedEnvelope,
	]; // POST /v1/fleet/members/{id}/keys
	leave: [ById<"memberId">, SignedEnvelope]; // POST /v1/fleet/members/{id}/leave
	listMembers: [Readonly<{ fleet?: FleetId }>, MemberList]; // GET  /v1/fleet/members
	getMember: [ById<"memberId">, SignedEnvelope]; // GET  /v1/fleet/members/{id}
	listFleets: [Empty, FleetList]; // GET  /v1/fleet/fleets
	getFleet: [ById<"fleetId">, SignedEnvelope]; // GET  /v1/fleet/fleets/{id}
	defineFleet: [FleetRecord, SignedEnvelope]; // PUT  /v1/fleet/fleets/{id}
	fleetView: [ById<"fleetId">, SignedEnvelope]; // GET  /v1/fleet/fleets/{id}/view
	fleetVerdict: [ById<"fleetId", { label: string }>, FleetVerdict]; // GET  /v1/fleet/fleets/{id}/verdict
	grantSession: [SessionRequest, SignedEnvelope]; // POST /v1/fleet/sessions
	submitWork: [WorkSubmissionRequest, WorkStatus]; // POST /v1/fleet/work
	workStatus: [ById<"submissionId">, WorkStatus]; // GET  /v1/fleet/work/{id}
	workLogs: [ById<"submissionId">, WorkLogs]; // GET  /v1/fleet/work/{id}/logs
	report: [ViolationReport, SignedEnvelope]; // POST /v1/fleet/reports
	auditCheckpoints: [Readonly<{ fromSequence?: number }>, AuditCheckpoints]; // GET  /v1/fleet/audit/checkpoints
	auditEntries: [Readonly<{ from: number; to: number }>, AuditEntries]; // GET  /v1/fleet/audit/entries
};
/** The authority's commands. `caller` is the result of `authenticate`, or undefined on routes with no auth. */
export type EnrollmentAuthority = {
	readonly [M in keyof FleetApi]: (
		request: FleetApi[M][0],
		caller: VerifiedToken | undefined,
	) => Promise<Outcome<FleetApi[M][1]>>;
} & Readonly<{
	authenticate(
		request: Readonly<{
			method: string;
			url: string;
			authorization: string;
			dpop: string;
		}>,
	): Promise<Outcome<VerifiedToken>>;
	/** Re-sign expiring records, publish views, checkpoint the audit chain. */
	tick(): Promise<void>;
}>;
/** The four browser-only methods are not on the client: a browser calls them, not a CLI or an agent. */
type BrowserOnly = "signInCallback" | "signInDevice" | "approval" | "approve";
export type FleetClient = {
	readonly [M in Exclude<keyof FleetApi, BrowserOnly>]: (
		request: FleetApi[M][0],
	) => Promise<Outcome<FleetApi[M][1]>>;
};
/** The commands of fleets, policy, sessions, work submission, views and verdicts (L32). */
export type FleetCommands = Pick<
	EnrollmentAuthority,
	| "listFleets"
	| "getFleet"
	| "defineFleet"
	| "fleetView"
	| "fleetVerdict"
	| "grantSession"
	| "submitWork"
>;
/** What createEnrollmentAuthority composes. Passed in, so that the lanes building each part merge independently. */
export type AuthorityParts = Readonly<{
	signIn: ReturnType<typeof createSignIn>;
	recorder: ReturnType<typeof createRecorder>;
	projection: ReturnType<typeof createRegistryProjection>;
	fleets: FleetCommands;
	audit: ReturnType<typeof createAuditChain>;
	/** For `report`: the dispatcher's own claim rules (L04). */
	checkClaim: typeof checkClaim;
}>;
export type LocalFleetInit = Readonly<{
	tenant: TenantId;
	fleetId: FleetId;
	coordination: CoordinationMode;
	policy: FleetPolicy;
	owner: PrincipalRef;
	members: readonly Readonly<{
		kind: MemberKind;
		name: MemberName;
		displayName: string;
		credentialRef: string;
		endpointDigest: string;
	}>[];
	now: Clock;
	log: FleetLog;
}>;
