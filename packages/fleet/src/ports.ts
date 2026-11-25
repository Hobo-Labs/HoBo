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
export type FleetLogEvent = (typeof FLEET_LOG_EVENTS)[number];
export type FleetLog = (
	event: FleetLogEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;
export type FleetContext = (typeof FLEET_CONTEXTS)[number];
export type PublicJwk = Readonly<
	| { kty: "EC"; crv: "P-256"; x: string; y: string }
	| { kty: "OKP"; crv: "Ed25519"; x: string }
>;
export type Clock = () => number;
export interface Subscription {
	stop(): Promise<void>;
}
export type FleetEventStore = EventStore &
	Readonly<{
		readAll(
			options?: Readonly<{ after?: EventPosition; limit?: number }>,
		): AsyncIterable<PositionedEvent>;
	}>;
export type BusStart = "start" | "new" | Readonly<{ after: number }>;

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
	signPublicKey: string;
	sealPublicKey: string;
	openSealed(
		box: SealedBox,
		context: string,
		associatedData: Uint8Array,
	): Promise<Uint8Array>;
	agree(peerSealPublicKey: string): Promise<Uint8Array>;
	heldKey: boolean;
}>;
export type AgentState = Readonly<{
	generation: number;
	pendingRefreshNonce: Uint8Array | undefined;
	trust: WitnessedEnvelope | undefined;
	lastSequence: Readonly<Record<string, number>>;
	seenOrderIds: readonly string[];
	pendingReceipts: readonly SignedEnvelope[];
}>;
export interface KeyStore {
	open(): Promise<DeviceKeys>;
	readState(): Promise<AgentState>;
	writeState(next: AgentState): Promise<void>;
	rotateOperational(): Promise<DeviceKeys>;
	destroy(): Promise<void>;
}

export interface RegistryView {
	member(id: MemberId): Promise<MemberRecord | undefined>;
	fleet(id: FleetId): Promise<FleetRecord | undefined>;
	membersOf(id: FleetId): Promise<readonly MemberRecord[]>;
	fleets(): Promise<readonly FleetRecord[]>;
	members(): Promise<readonly MemberRecord[]>;
	view(id: FleetId): Promise<FleetView | undefined>;
	trust(): TrustRecord;
	trustEnvelope(): WitnessedEnvelope | undefined;
	caughtUp(): Promise<void>;
}
export interface RegistryPublisher {
	putMember(record: SignedEnvelope, id: MemberId): Promise<void>;
	putFleet(record: SignedEnvelope, id: FleetId): Promise<void>;
	putView(view: SignedEnvelope, id: FleetId): Promise<void>;
	putTrust(trust: WitnessedEnvelope): Promise<void>;
}

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
	| {
			kind: "account";
			principal: PrincipalRef;
			tenant: TenantId;
			scopes: readonly string[];
	  }
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
	readonly id: string;
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
	firstUse(scope: string, id: string, expiresAtMs: number): Promise<boolean>;
}
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
	onCheckpoint?(
		handler: (checkpoint: SignedEnvelope) => Promise<void>,
	): Subscription;
	proposeTrust(record: SignedEnvelope): Promise<void>;
	onTrustProposed(
		handler: (record: SignedEnvelope) => Promise<void>,
	): Subscription;
	onTrustWitnessed(
		handler: (trust: WitnessedEnvelope) => Promise<void>,
	): Subscription;
}

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
	observeAll(
		from: BusStart,
		handler: (
			order: SignedEnvelope,
			to: MemberId,
			sequence: number,
		) => Promise<void>,
	): Subscription;
}
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
export interface RelayChannel {
	send(to: MemberId, sessionId: string, frame: Uint8Array): Promise<void>;
	subscribe(
		self: MemberId,
		handler: (sessionId: string, frame: Uint8Array) => Promise<void>,
	): Subscription;
}
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
export type AuthorityBus = FleetBus &
	Readonly<{
		publisher: RegistryPublisher;
		audit: AuditLog;
		replay: ReplayStore;
	}>;
export interface FleetBusConnector {
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
	writeSecret(path: string, bytes: Uint8Array): Promise<void>;
	destroy(): Promise<void>;
}
export interface EgressProxyFactory {
	open(
		allow: readonly string[],
	): Promise<Readonly<{ url: string; close(): Promise<void> }>>;
}
export type HostSignals = Readonly<{
	freeInodes?: number;
	psiMemorySome?: number;
	psiMemoryFull?: number;
}>;
export interface CapacitySource {
	read(): Promise<
		Readonly<{
			capacity: Capacity;
			health: Health;
			labels: readonly string[];
			hostSignals?: HostSignals;
		}>
	>;
}

export type FailureClassifier = (error: Error | undefined) => Health;
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
export type AssignmentValue = Readonly<{
	active: MemberName | undefined;
	sealed: boolean;
	target: MemberName | undefined;
	reason: string;
	lossWindowMs: number | undefined;
}>;
export type AssignmentAcceptOutcome =
	| "accepted"
	| "duplicate"
	| "conflict"
	| "gap"
	| "busy";
export type AssignmentReplica = Readonly<{
	id: MemberName;
	read(limit?: number): Promise<readonly AssignmentEntry[]>;
	accept(entry: AssignmentEntry): Promise<AssignmentAcceptOutcome>;
	refresh?(): Promise<boolean>;
	seed?(entry: AssignmentEntry): Promise<"seeded" | "not-empty">;
}>;
export type AssignmentRegister = Readonly<{
	replicas: readonly AssignmentReplica[];
	classify?: FailureClassifier;
	earlyCurrent?: (
		resolution: Extract<AssignmentResolution, { status: "current" }>,
		replies: readonly AssignmentReply[],
	) => boolean;
	stopAfterMajority?: boolean;
}>;
export type AssignmentReply = Readonly<
	| { replica: MemberName; rows: readonly AssignmentEntry[] }
	| { replica: MemberName; failure: Health }
>;
export type AssignmentContender = Readonly<{
	assignment: AssignmentEntry;
	holders: readonly MemberName[];
}>;
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
export type NamedObservation = Readonly<{
	name: MemberName;
	observation: Observation;
}>;
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
	observe(member: MemberRecord): Promise<Observation>;
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
	viewTtlMs: number;
	refusedTtlMs: number;
	now: Clock;
	log: FleetLog;
}>;

export type TransportKind = "p2p" | "overlay" | "bus-relay";
export interface FleetStream {
	readonly peer: string;
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
	accept(
		authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>,
		handler: (stream: FleetStream, grant: SessionGrant) => Promise<void>,
	): Subscription;
	stop(): Promise<void>;
}

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
	sponsored?: readonly Readonly<{
		memberId: MemberId;
		observe(): Promise<Observation>;
	}>[];
}>;

type Empty = Readonly<Record<string, never>>;
type ById<
	K extends string,
	T extends object = Readonly<Record<never, never>>,
> = Readonly<Record<K, string>> & T;
export type FleetApi = {
	authorityDiscovery: [Empty, AuthorityDiscovery];
	discovery: [Readonly<{ tenant: TenantId }>, Discovery];
	jwks: [Empty, Readonly<{ jwks: string }>];
	signInStart: [SignInStart, SignInChallenge];
	signInCallback: [SignInCallback, ApprovalView];
	signInDevice: [SignInDeviceCode, SignInChallenge];
	approval: [ById<"state">, ApprovalView];
	approve: [ApprovalDecision, ApprovalResult];
	signInComplete: [SignInComplete, PersonCredential];
	signInPoll: [SignInPoll, PersonCredential];
	signInRefresh: [SignInRefresh, PersonCredential];
	issueToken: [TokenCreateRequest, TokenCreateResponse];
	listTokens: [Empty, TokenList];
	revokeToken: [ById<"tokenHash">, TokenList];
	enroll: [EnrollmentRequest, EnrollmentResponse];
	declare: [DeclareRequest, EnrollmentResponse];
	approveKey: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope];
	accept: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope];
	reject: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope];
	suspend: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope];
	resume: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope];
	unlock: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope];
	revoke: [ById<"memberId", { request: LifecycleRequest }>, SignedEnvelope];
	assign: [ById<"memberId", { request: MembershipRequest }>, SignedEnvelope];
	credentials: [
		ById<"memberId", { request: CredentialRequest }>,
		CredentialResponse,
	];
	rotateKeys: [
		ById<"memberId", { request: KeyRotationRequest }>,
		SignedEnvelope,
	];
	leave: [ById<"memberId">, SignedEnvelope];
	listMembers: [Readonly<{ fleet?: FleetId }>, MemberList];
	getMember: [ById<"memberId">, SignedEnvelope];
	listFleets: [Empty, FleetList];
	getFleet: [ById<"fleetId">, SignedEnvelope];
	defineFleet: [FleetRecord, SignedEnvelope];
	fleetView: [ById<"fleetId">, SignedEnvelope];
	fleetVerdict: [ById<"fleetId", { label: string }>, FleetVerdict];
	grantSession: [SessionRequest, SignedEnvelope];
	submitWork: [WorkSubmissionRequest, WorkStatus];
	workStatus: [ById<"submissionId">, WorkStatus];
	workLogs: [ById<"submissionId">, WorkLogs];
	report: [ViolationReport, SignedEnvelope];
	auditCheckpoints: [Readonly<{ fromSequence?: number }>, AuditCheckpoints];
	auditEntries: [Readonly<{ from: number; to: number }>, AuditEntries];
};
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
	tick(): Promise<void>;
}>;
type BrowserOnly = "signInCallback" | "signInDevice" | "approval" | "approve";
export type FleetClient = {
	readonly [M in Exclude<keyof FleetApi, BrowserOnly>]: (
		request: FleetApi[M][0],
	) => Promise<Outcome<FleetApi[M][1]>>;
};
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
export type AuthorityParts = Readonly<{
	signIn: ReturnType<typeof createSignIn>;
	recorder: ReturnType<typeof createRecorder>;
	projection: ReturnType<typeof createRegistryProjection>;
	fleets: FleetCommands;
	audit: ReturnType<typeof createAuditChain>;
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
