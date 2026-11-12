// Frozen by docs/plans/0024-hobo-cd-swarm-instruction.md (final). Types only.
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import type { GatekeeperEffect, PolicyPack } from "@hobo/contracts";
import type {
	ApplyResult,
	DataClassification,
	DurableEventStore,
	EventPosition,
	FenceToken,
	HttpTransport,
	JsonObject,
	PrincipalRef,
	ResidencyConstraint,
	RoutingPlan,
	RoutingPlanId,
	RoutingStatus,
	TrafficRoutingOfferingId,
} from "@hobo/core";
import type {
	ArtifactKind,
	ArtifactRef,
	CampClaimRecord,
	CampConditionRecord,
	CampManagement,
	CampSetRecord,
	CampStatusRecord,
	ChangeWindowRecord,
	Cohort,
	ComplianceRecord,
	DeltaRecord,
	DepartureAction,
	DiscoveredArtifactRecord,
	EnrollmentState,
	FailoverRecord,
	FailoverState,
	FanoutRecord,
	FanoutStatusRecord,
	FreightApprovedRecord,
	FreightAvailabilityRecord,
	FreightManifestRecord,
	FreightOrigin,
	FreightQualifiedRecord,
	FreightRecord,
	FreightSourceRecord,
	HealthQueryRecord,
	HealthSourceKind,
	ObligationRef,
	PipelineRecord,
	PlacementDecisionRecord,
	PlacementRecord,
	PolicyBindingRecord,
	PolicyMode,
	PostureFindingRecord,
	PostureRemediationRecord,
	PreviewEnvironmentRecord,
	PromotionRecord,
	ProvenanceRef,
	RailDeliveryRecord,
	ReasonRecord,
	RebalanceRecord,
	ReconcileObservationRecord,
	ReconcilerMode,
	ReconcilerRecord,
	RetentionPolicyRecord,
	RolloutPlanRecord,
	RolloutStrategy,
	ScoreSnapshotRecord,
	SelectorRecord,
	SetOrigin,
	SetRecord,
	ShadowDecisionRecord,
	SignalSource,
	SubscriptionKind,
	SubscriptionRecord,
	TaintEffect,
	TaintRecord,
	TrustedPublisherRecord,
	VerificationResultRecord,
	VerificationSpecRecord,
	WindowOverrideRecord,
} from "./_generated/cd_pb.js";

// ── Brands ─────────────────────────────────────────────────────────────────
export type Digest = `sha256:${string}`;
export type FreightId = string & { readonly __brand: "cd.FreightId" };
export type SetId = string & { readonly __brand: "cd.SetId" };
export type DeltaId = string & { readonly __brand: "cd.DeltaId" };
export type PromotionId = string & { readonly __brand: "cd.PromotionId" };
export type CampId = string & { readonly __brand: "cd.CampId" };
export type ReconcilerId = string & { readonly __brand: "cd.ReconcilerId" };
export type RolloutId = string & { readonly __brand: "cd.RolloutId" };
export type VerificationId = string & { readonly __brand: "cd.VerificationId" };

// ── Results and context ────────────────────────────────────────────────────
export type Refusal = Readonly<{ ok: false; reasons: readonly ReasonRecord[] }>;
export type Outcome<T> = Readonly<{ ok: true; value: T }> | Refusal;

export interface CdContext {
	readonly tenant: string;
	readonly principal: PrincipalRef;
	/** Injected clock, epoch ms. Decision code never reads a wall clock. */
	readonly now: () => number;
	readonly signal?: AbortSignal;
}

export interface CdBase {
	readonly store: DurableEventStore;
	readonly tenant: string;
	readonly now: () => number;
}

export interface CredentialResolver {
	/** Resolve a credential locator for one scoped use. Never persisted or logged. */
	resolve(
		ref: string,
		scope: string,
	): Promise<Readonly<Record<string, string>>>;
}

export type FeedRequest = Readonly<{
	method: string;
	path: string;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
}>;

export type FeedResponse = Readonly<{
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array | AsyncIterable<Uint8Array>;
}>;

// ── Freight and ingestion ──────────────────────────────────────────────────
export interface FreightLedger {
	record(
		input: Readonly<{
			manifest: FreightManifestRecord;
			origin: FreightOrigin;
			sourceName?: string;
		}>,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>>;
	yank(
		id: FreightId,
		reason: string,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>>;
	approve(
		input: Readonly<{
			freightId: FreightId;
			campId: CampId;
			reason: string;
			expiresAtMs: number;
		}>,
		ctx: CdContext,
	): Promise<Outcome<FreightApprovedRecord>>;
	/** Accepts only a PASS verification for that Freight and Camp. */
	qualify(
		input: Readonly<{
			freightId: FreightId;
			campId: CampId;
			pipeline: string;
			node: string;
			result: VerificationResultRecord;
		}>,
		ctx: CdContext,
	): Promise<Outcome<FreightQualifiedRecord>>;
	get(id: FreightId): Promise<FreightRecord | undefined>;
	getByAlias(alias: string): Promise<FreightRecord | undefined>;
	isUsable(id: FreightId): Promise<boolean>;
	qualifications(id: FreightId): Promise<readonly FreightQualifiedRecord[]>;
	approvals(id: FreightId): Promise<readonly FreightApprovedRecord[]>;
	list(
		query?: Readonly<{
			bindle?: string;
			labels?: Readonly<Record<string, string>>;
			limit?: number;
		}>,
	): Promise<readonly FreightRecord[]>;
	/** Retention sweep (D18). Returns the Freight retired. */
	retire(
		policy: RetentionPolicyRecord,
		ctx: CdContext,
	): Promise<readonly FreightRecord[]>;
}

export type VerifiedPublisher = Readonly<{
	principal: PrincipalRef;
	publisher: string;
	claims: JsonObject;
}>;

export interface TrustedPublisherVerifier {
	trust(
		publisher: TrustedPublisherRecord,
		ctx: CdContext,
	): Promise<Outcome<TrustedPublisherRecord>>;
	verify(token: string, ctx: CdContext): Promise<Outcome<VerifiedPublisher>>;
}

export interface ProvenanceVerifier {
	verify(
		input: Readonly<{
			statement: Uint8Array;
			bundle?: Uint8Array;
			subjects: readonly ArtifactRef[];
			trustedBuilderIds: readonly string[];
			trustedSignerIdentities: readonly string[];
		}>,
		ctx: CdContext,
	): Promise<Outcome<readonly ProvenanceRef[]>>;
}

export interface FreightIngest {
	manifest(
		input: Readonly<{
			manifest: FreightManifestRecord;
			publisherToken?: string;
		}>,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>>;
	attestation(
		input: Readonly<{
			bindle: string;
			statement: Uint8Array;
			bundle?: Uint8Array;
			publisherToken?: string;
		}>,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>>;
	/** Inbound CDEvent. Creates Freight only with a verifiable attestation; otherwise schedules polls. */
	cdevent(
		input: Readonly<{ body: Uint8Array }>,
		ctx: CdContext,
	): Promise<
		Outcome<
			Readonly<{ freight?: FreightRecord; scheduledPolls: readonly string[] }>
		>
	>;
}

// ── Freight sources (pull discovery) ───────────────────────────────────────
export type CiEventReader = (
	after: string | undefined,
	signal: AbortSignal,
) => AsyncIterable<
	Readonly<{ cursor: string; type: string; data: JsonObject }>
>;

export type CiArtifactReader = (
	runId: string,
	path: string,
) => Promise<Uint8Array | undefined>;

export type DiscoveryResult = Readonly<{
	artifacts: readonly DiscoveredArtifactRecord[];
	cursor: string;
}>;

export interface SubscriptionDriver {
	readonly kind: SubscriptionKind;
	discover(
		input: Readonly<{
			source: string;
			subscription: SubscriptionRecord;
			cursor?: string;
			signal: AbortSignal;
		}>,
		ctx: CdContext,
	): Promise<Outcome<DiscoveryResult>>;
}

export interface FreightSources {
	define(
		source: FreightSourceRecord,
		ctx: CdContext,
	): Promise<Outcome<FreightSourceRecord>>;
	list(): Promise<readonly FreightSourceRecord[]>;
	poll(
		name: string,
		ctx: CdContext,
	): Promise<Outcome<readonly FreightRecord[]>>;
	/** Webhook receiver. Authenticates, maps to sources, schedules polls. Never creates Freight. */
	nudge(request: FeedRequest, ctx: CdContext): Promise<FeedResponse>;
	schedule(names: readonly string[], ctx: CdContext): Promise<void>;
	tick(ctx: CdContext): Promise<void>;
}

// ── Artifacts ──────────────────────────────────────────────────────────────
export type ArtifactStoreConfig =
	| Readonly<{ backend: "filesystem"; root: string }>
	| Readonly<{
			backend: "s3-compatible";
			endpoint: string;
			bucket: string;
			region: string;
			credentialRef: string;
			credentials: CredentialResolver;
			http: HttpTransport;
	  }>
	| Readonly<{ backend: "memory" }>;

export interface ArtifactStore {
	readonly backend: ArtifactStoreConfig["backend"];
	put(
		bytes: Uint8Array,
		meta: Readonly<{ name: string; kind: ArtifactKind; mediaType: string }>,
		ctx: CdContext,
	): Promise<ArtifactRef>;
	get(digest: Digest): Promise<Uint8Array | undefined>;
	has(digest: Digest): Promise<boolean>;
	list(signal: AbortSignal): AsyncIterable<Digest>;
	delete(digest: Digest, reason: string, ctx: CdContext): Promise<void>;
}

export interface ArtifactVerifier {
	/** Digest at its coordinate for every artifact in the manifest. */
	verify(
		manifest: FreightManifestRecord,
		ctx: CdContext,
	): Promise<Outcome<FreightManifestRecord>>;
}

// ── Desired state ──────────────────────────────────────────────────────────
export type DesiredStateChange = Readonly<{
	position: EventPosition;
	set: SetRecord;
	/** Posture attribute paths to report (D25); empty when none are bound. */
	observeFields: readonly string[];
	management: CampManagement;
	policy?: PolicyBindingRecord;
}>;

export interface DesiredStateReader {
	current(campId: CampId): Promise<SetRecord | undefined>;
	get(setId: SetId): Promise<SetRecord | undefined>;
	history(campId: CampId, limit?: number): Promise<readonly SetRecord[]>;
	/** Fetch and verify the resolved-set blob a Set references. */
	resolved(set: SetRecord): Promise<ResolvedDeploymentSet>;
	status(campId: CampId): Promise<ReconcileObservationRecord | undefined>;
	changes(
		input: Readonly<{
			campIds: readonly CampId[];
			after?: EventPosition;
			signal: AbortSignal;
		}>,
	): AsyncIterable<DesiredStateChange>;
}

export interface DeltaLedger {
	open(delta: DeltaRecord, ctx: CdContext): Promise<Outcome<DeltaRecord>>;
	update(delta: DeltaRecord, ctx: CdContext): Promise<Outcome<DeltaRecord>>;
	apply(
		input: Readonly<{
			deltaId: DeltaId;
			gateDecisionId: string;
			resolved: ResolvedDeploymentSet;
			origin: SetOrigin;
		}>,
		ctx: CdContext,
	): Promise<Outcome<SetRecord>>;
	reject(
		deltaId: DeltaId,
		reasons: readonly ReasonRecord[],
		ctx: CdContext,
	): Promise<void>;
	get(deltaId: DeltaId): Promise<DeltaRecord | undefined>;
}

// ── Pipelines and windows ──────────────────────────────────────────────────
export interface PipelineController {
	apply(
		pipeline: PipelineRecord,
		ctx: CdContext,
	): Promise<Outcome<PipelineRecord>>;
	get(name: string): Promise<PipelineRecord | undefined>;
	list(): Promise<readonly PipelineRecord[]>;
	/** Freight available to a node, newest first, each with the reasons it is available. */
	available(
		input: Readonly<{ pipeline: string; node: string }>,
	): Promise<readonly FreightAvailabilityRecord[]>;
	/** Evaluate availability and auto-promotion; request promotions. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export type DeltaIntent =
	| "promote"
	| "rollback"
	| "drift-remediate"
	| "up"
	| "down"
	| "preview"
	| "config"
	| "topology"
	| "failover"
	| "depart"
	| "posture-remediate";

export type WindowEvaluation = Readonly<{
	open: boolean;
	rollbackAllowed: boolean;
	activeFreezes: readonly string[];
	overrides: readonly string[];
	nextOpenAtMs?: number;
}>;

export interface ChangeWindows {
	define(
		window: ChangeWindowRecord,
		ctx: CdContext,
	): Promise<Outcome<ChangeWindowRecord>>;
	list(): Promise<readonly ChangeWindowRecord[]>;
	override(
		input: WindowOverrideRecord,
		ctx: CdContext,
	): Promise<Outcome<WindowOverrideRecord>>;
	evaluate(
		input: Readonly<{
			campId: CampId;
			labels: Readonly<Record<string, string>>;
			envType: string;
			windowNames: readonly string[];
			atMs: number;
			intent: DeltaIntent;
		}>,
	): Promise<WindowEvaluation>;
}

// ── Promotion ──────────────────────────────────────────────────────────────
export interface SetResolver {
	resolve(
		input: Readonly<{
			freight: FreightRecord;
			campId: CampId;
			intent: DeltaIntent;
			base?: SetRecord;
			sourceCampId?: CampId;
		}>,
		ctx: CdContext,
	): Promise<
		Outcome<Readonly<{ resolved: ResolvedDeploymentSet; delta: DeltaRecord }>>
	>;
}

export type GateVerdict = Readonly<{
	decisionId: string;
	effect: GatekeeperEffect;
	obligations: readonly ObligationRef[];
	reasons: readonly ReasonRecord[];
	window?: WindowEvaluation;
	/** Present while a candidate Rail is bound in INFORM (D24). Never decides. */
	shadow?: ShadowVerdict;
}>;

export interface DeployGate {
	evaluate(
		input: Readonly<{
			intent: DeltaIntent;
			delta: DeltaRecord;
			freight: FreightRecord;
			resolved: ResolvedDeploymentSet;
			windows: readonly string[];
			current?: SetRecord;
		}>,
		ctx: CdContext,
	): Promise<GateVerdict>;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalPort {
	request(
		input: Readonly<{
			subject: string;
			summary: string;
			obligations: readonly string[];
			expiresAtMs: number;
		}>,
		ctx: CdContext,
	): Promise<Readonly<{ requestId: string }>>;
	status(requestId: string): Promise<ApprovalStatus>;
}

export type PromoteRequest = Readonly<{
	freightId: FreightId;
	targets: readonly CampId[];
	idempotencyKey: string;
	pipeline?: string;
	node?: string;
	sourceCampId?: CampId;
	strategy?: RolloutStrategy;
	proposal?: boolean;
	/** Set by FanoutController; the gate then checks the fan-out aggregate. */
	fanoutId?: FanoutId;
	intent?: DeltaIntent;
}>;

export interface PromotionService {
	promote(
		request: PromoteRequest,
		ctx: CdContext,
	): Promise<Outcome<PromotionRecord>>;
	rollback(
		input: Readonly<{
			campId: CampId;
			reason: string;
			idempotencyKey: string;
			toSetId?: SetId;
		}>,
		ctx: CdContext,
	): Promise<Outcome<PromotionRecord>>;
	approve(
		promotionId: PromotionId,
		ctx: CdContext,
	): Promise<Outcome<PromotionRecord>>;
	get(promotionId: PromotionId): Promise<PromotionRecord | undefined>;
	list(
		query?: Readonly<{ campId?: CampId; limit?: number }>,
	): Promise<readonly PromotionRecord[]>;
	/** Advance in-flight sagas from journal state. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export interface PreviewEnvironments {
	createPreview(
		input: Readonly<{
			freightId: FreightId;
			sourceCampId: CampId;
			ttlMs: number;
			idempotencyKey: string;
			pipeline?: string;
			node?: string;
		}>,
		ctx: CdContext,
	): Promise<Outcome<PreviewEnvironmentRecord>>;
	expirePreviews(ctx: CdContext): Promise<readonly PreviewEnvironmentRecord[]>;
	listPreviews(): Promise<readonly PreviewEnvironmentRecord[]>;
}

export interface RunbookExecutor {
	run(
		input: Readonly<{ path: string; args: JsonObject }>,
		ctx: CdContext,
	): Promise<Outcome<JsonObject>>;
}

export interface VerifyPort {
	run(
		input: Readonly<{ suite: string; campId: CampId; freightId: FreightId }>,
		ctx: CdContext,
	): Promise<Outcome<JsonObject>>;
}

export interface NotificationPort {
	notify(
		input: Readonly<{ channel: string; subject: string; body: JsonObject }>,
		ctx: CdContext,
	): Promise<void>;
}

// ── Reconciliation ─────────────────────────────────────────────────────────
export type RealizeInput = Readonly<{
	campId: CampId;
	desired: SetRecord;
	resolved: ResolvedDeploymentSet;
	reconcilerId: ReconcilerId;
	fence: FenceToken;
	signal: AbortSignal;
	previous?: SetRecord;
}>;

export interface Realizer {
	/** Drive toward `desired`. Idempotent. Never reports convergence without observation. */
	converge(
		input: RealizeInput,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord>;
	observe(
		input: RealizeInput,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord>;
}

export type ReconcilerLease = Readonly<{
	reconcilerId: ReconcilerId;
	campId: CampId;
	holderId: string;
	fence: FenceToken;
	expiresAtMs: number;
}>;

export interface ReconcilerTransport {
	/** One lease per Camp (subscription CD_SUBSCRIPTIONS.camp). */
	claim(
		input: Readonly<{
			reconcilerId: ReconcilerId;
			campId: CampId;
			holderId: string;
			ttlMs: number;
		}>,
	): Promise<Outcome<ReconcilerLease>>;
	renew(lease: ReconcilerLease): Promise<Outcome<ReconcilerLease>>;
	release(lease: ReconcilerLease): Promise<void>;
	/** Desired-state changes for the lease's Camp after its committed checkpoint. */
	feed(
		input: Readonly<{ lease: ReconcilerLease; signal: AbortSignal }>,
	): AsyncIterable<DesiredStateChange>;
	resolved(
		lease: ReconcilerLease,
		set: SetRecord,
	): Promise<Outcome<ResolvedDeploymentSet>>;
	report(
		lease: ReconcilerLease,
		observation: ReconcileObservationRecord,
	): Promise<Outcome<EventPosition>>;
	checkpoint(
		lease: ReconcilerLease,
		position: EventPosition,
	): Promise<Outcome<EventPosition>>;
}

export type DriftRoute = "reconcile" | "propose" | "ignore" | "escalate";

export interface DriftPolicy {
	route(
		observation: ReconcileObservationRecord,
		ctx: CdContext,
	): Promise<DriftRoute>;
}

export interface CampReconciler {
	readonly reconcilerId: ReconcilerId;
	readonly mode: ReconcilerMode;
	/** Claim each Camp, read the feed, converge, report, checkpoint, renew; until aborted. */
	run(signal: AbortSignal): Promise<void>;
	/** One bounded pass (tests, `hobo up`). */
	reconcileOnce(
		campId: CampId,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord>;
}

export interface PublisherPort {
	readonly target: string;
	publish(
		input: Readonly<{
			set: SetRecord;
			resolved: ResolvedDeploymentSet;
			signal: AbortSignal;
		}>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ revision: string }>>>;
	observe(
		input: Readonly<{ set: SetRecord; revision: string; signal: AbortSignal }>,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord>;
}

// ── Verification ───────────────────────────────────────────────────────────
export type HealthSamples = Readonly<{
	values: readonly number[];
	fromMs: number;
	toMs: number;
}>;

export interface HealthSource {
	readonly kind: HealthSourceKind;
	query(
		input: Readonly<{
			query: HealthQueryRecord;
			campId: CampId;
			cohort: Cohort;
			fromMs: number;
			toMs: number;
			signal: AbortSignal;
		}>,
		ctx: CdContext,
	): Promise<Outcome<HealthSamples>>;
}

export interface VerificationEngine {
	start(
		input: Readonly<{
			spec: VerificationSpecRecord;
			freightId: FreightId;
			campId: CampId;
			cohortAware: boolean;
		}>,
		ctx: CdContext,
	): Promise<VerificationId>;
	get(id: VerificationId): Promise<VerificationResultRecord | undefined>;
	/** Advance running verifications; completes them at window end or deadline. */
	tick(ctx: CdContext): Promise<readonly VerificationResultRecord[]>;
}

// ── Progressive rollout ────────────────────────────────────────────────────
export interface TrafficShifter {
	offerings(campId: CampId): Promise<readonly TrafficRoutingOfferingId[]>;
	shift(
		input: Readonly<{ campId: CampId; plan: RoutingPlan; signal: AbortSignal }>,
		ctx: CdContext,
	): Promise<ApplyResult>;
	status(campId: CampId, planId: RoutingPlanId): Promise<RoutingStatus | null>;
}

export type RolloutStatus =
	| "running"
	| "awaiting-approval"
	| "awaiting-window"
	| "halted"
	| "promoted"
	| "rolled-back"
	| "failed";

export type RolloutSnapshot = Readonly<{
	rolloutId: RolloutId;
	status: RolloutStatus;
	stageIndex: number;
	percent: number;
	reasons: readonly ReasonRecord[];
}>;

export interface RolloutEngine {
	start(plan: RolloutPlanRecord, ctx: CdContext): Promise<RolloutSnapshot>;
	advance(
		rolloutId: RolloutId,
		result: VerificationResultRecord,
		ctx: CdContext,
	): Promise<RolloutSnapshot>;
	hold(
		rolloutId: RolloutId,
		reason: ReasonRecord,
		ctx: CdContext,
	): Promise<RolloutSnapshot>;
	rollback(
		rolloutId: RolloutId,
		reason: string,
		ctx: CdContext,
	): Promise<RolloutSnapshot>;
	get(rolloutId: RolloutId): Promise<RolloutSnapshot | undefined>;
}

export interface RolloutOrchestrator {
	plan(
		input: Readonly<{
			promotion: PromotionRecord;
			obligations: readonly ObligationRef[];
			verification: VerificationSpecRecord;
			stagePercents: readonly number[];
			windows: readonly string[];
		}>,
		ctx: CdContext,
	): Promise<Outcome<RolloutPlanRecord>>;
	run(plan: RolloutPlanRecord, ctx: CdContext): Promise<RolloutSnapshot>;
	rollback(
		input: Readonly<{ rolloutId: RolloutId; reason: string }>,
		ctx: CdContext,
	): Promise<RolloutSnapshot>;
	get(rolloutId: RolloutId): Promise<RolloutSnapshot | undefined>;
	tick(ctx: CdContext): Promise<void>;
}

// ── Feed, agents, service ──────────────────────────────────────────────────
export interface DeliveryFeedHandler {
	readonly pathPrefix: "/v1/cd/";
	handle(request: FeedRequest, signal: AbortSignal): Promise<FeedResponse>;
}

export interface AgentEnrollment {
	/** Single-use bootstrap token scoped to one Camp set (D19). */
	issueToken(
		input: Readonly<{
			campSet: string;
			campIds: readonly CampId[];
			mode: ReconcilerMode;
			ttlMs: number;
		}>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ token: string; expiresAtMs: number }>>>;
	/** Register a public JWK. PENDING until both grants or a Rail auto-accept (I24). */
	enroll(
		input: Readonly<{
			token: string;
			publicJwk: JsonObject;
			claims: readonly CampClaimRecord[];
		}>,
		ctx: CdContext,
	): Promise<
		Outcome<Readonly<{ reconciler: ReconcilerRecord; state: EnrollmentState }>>
	>;
	/** Grant 1: the key belongs to a legitimate agent. */
	approveKey(
		reconcilerId: ReconcilerId,
		ctx: CdContext,
	): Promise<Outcome<ReconcilerRecord>>;
	/** Grant 2: the agent may serve these Camps. */
	accept(
		input: Readonly<{ reconcilerId: ReconcilerId; campIds: readonly CampId[] }>,
		ctx: CdContext,
	): Promise<Outcome<ReconcilerRecord>>;
	/** After acceptance, exchange a DPoP proof of key possession for a key-bound JWT-SVID (cnf.jkt). */
	activate(
		input: Readonly<{ reconcilerId: ReconcilerId; dpopProof: string }>,
		ctx: CdContext,
	): Promise<
		Outcome<
			Readonly<{
				reconciler: ReconcilerRecord;
				svid: string;
				expiresAtMs: number;
			}>
		>
	>;
	refresh(
		input: Readonly<{ svid: string; dpopProof: string }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ svid: string; expiresAtMs: number }>>>;
	revoke(
		reconcilerId: ReconcilerId,
		reason: string,
		ctx: CdContext,
	): Promise<Outcome<ReconcilerRecord>>;
	/** Verify a request's JWT-SVID and DPoP proof (RFC 9449) with jti replay protection. */
	verify(request: FeedRequest): Promise<Outcome<ReconcilerRecord>>;
}

export interface CdService {
	start(): Promise<void>;
	ready(): boolean;
	drain(signal: AbortSignal): Promise<void>;
}

// ── Authorization and telemetry ────────────────────────────────────────────
export type CdAction =
	| "freight.record"
	| "freight.yank"
	| "freight.approve"
	| "publisher.trust"
	| "source.define"
	| "pipeline.apply"
	| "window.define"
	| "window.override"
	| "promote"
	| "rollback"
	| "approve"
	| "preview.create"
	| "reconciler.enroll"
	| "reconciler.revoke"
	| "reconciler.approve-key"
	| "reconciler.accept"
	| "drift.remediate"
	| "campset.define"
	| "camp.taint"
	| "camp.untaint"
	| "camp.manage"
	| "placement.define"
	| "placement.scores"
	| "fanout.halt"
	| "fanout.resume"
	| "fanout.rollback"
	| "failover.propose"
	| "failover.approve"
	| "rebalance"
	| "posture.enforce"
	| "rail.promote";

export interface CdAuthorizer {
	authorize(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ decisionId: string; proposalOnly: boolean }>>>;
}

export type OtelAttributes = Readonly<
	Record<string, string | number | boolean>
>;

export type OtelSpan = Readonly<{
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	kind: "internal" | "server" | "client" | "producer" | "consumer";
	startMs: number;
	endMs: number;
	status: "unset" | "ok" | "error";
	attributes: OtelAttributes;
}>;

export type OtelMetricPoint = Readonly<{
	name: string;
	kind: "counter" | "histogram" | "gauge";
	value: number;
	unit: string;
	atMs: number;
	attributes: OtelAttributes;
}>;

export interface TelemetrySink {
	spans(spans: readonly OtelSpan[]): Promise<void>;
	metrics(points: readonly OtelMetricPoint[]): Promise<void>;
}

export type DoraMetrics = Readonly<{
	windowMs: number;
	deploymentFrequencyPerDay: number;
	leadTimeMsP50: number;
	changeFailureRate: number;
	timeToRestoreMsP50: number;
}>;

export type HealthReport = Readonly<{
	ok: boolean;
	checks: readonly Readonly<{ name: string; ok: boolean; detail: string }>[];
}>;

export interface CdTelemetry {
	dora(
		input: Readonly<{ windowMs: number; campIds?: readonly CampId[] }>,
		ctx: CdContext,
	): Promise<DoraMetrics>;
	reconcileLagMs(campId: CampId, ctx: CdContext): Promise<number | undefined>;
	health(): HealthReport;
}

// ── Inventory and Placement (D19, D20) ─────────────────────────────────────
export type FanoutId = string & { readonly __brand: "cd.FanoutId" };
export type FailoverId = string & { readonly __brand: "cd.FailoverId" };

/** Declared topology of one Camp (from @hobo/camps / @hobo/yards; composed by WP18). */
export type CampTopology = Readonly<{
	campId: CampId;
	yardId: string;
	stationId: string;
	provider: string;
	/** Declared Yard regions. Residency is evaluated only against these. */
	regions: readonly string[];
	envType: string;
	labels: Readonly<Record<string, string>>;
	management: CampManagement;
}>;

export interface TopologyReader {
	camps(): Promise<readonly CampTopology[]>;
	camp(campId: CampId): Promise<CampTopology | undefined>;
}

export interface RailDeliveryReader {
	/** The Station's active Rail `delivery` object, parsed. */
	forStation(stationId: string): Promise<RailDeliveryRecord | undefined>;
	/** The Rail governing a Camp: its enforced binding, else its Station's active Rail. */
	forCamp(campId: CampId): Promise<RailDeliveryRecord | undefined>;
}

export type CampView = Readonly<{
	topology: CampTopology;
	status: CampStatusRecord;
}>;

export type InventorySnapshot = Readonly<{
	digest: Digest;
	camps: readonly CampView[];
}>;

export interface CampInventory {
	status(campId: CampId): Promise<CampStatusRecord | undefined>;
	list(
		query?: Readonly<{
			campSets?: readonly string[];
			selector?: SelectorRecord;
		}>,
	): Promise<readonly CampView[]>;
	/** Merge conditions and claims from one source. Agent sources can never add NO_RUN. */
	observe(
		input: Readonly<{
			campId: CampId;
			source: SignalSource;
			conditions: readonly CampConditionRecord[];
			claims: readonly CampClaimRecord[];
		}>,
		ctx: CdContext,
	): Promise<Outcome<CampStatusRecord>>;
	taint(
		input: Readonly<{ campId: CampId; taint: TaintRecord }>,
		ctx: CdContext,
	): Promise<Outcome<CampStatusRecord>>;
	untaint(
		input: Readonly<{ campId: CampId; key: string; effect: TaintEffect }>,
		ctx: CdContext,
	): Promise<Outcome<CampStatusRecord>>;
	manage(
		input: Readonly<{ campId: CampId; management: CampManagement }>,
		ctx: CdContext,
	): Promise<Outcome<CampStatusRecord>>;
	defineSet(
		set: CampSetRecord,
		ctx: CdContext,
	): Promise<Outcome<CampSetRecord>>;
	sets(): Promise<readonly CampSetRecord[]>;
	/** Canonical view whose digest a placement decision records. */
	snapshot(campSets: readonly string[]): Promise<InventorySnapshot>;
	/** Derive lease/credential/claims conditions and automatic NO_PLACE taints. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export type PlacementSubject = Readonly<{
	classifications: readonly DataClassification[];
	residency: readonly ResidencyConstraint[];
}>;

export interface PlacementEngine {
	define(
		placement: PlacementRecord,
		ctx: CdContext,
	): Promise<Outcome<PlacementRecord>>;
	get(name: string): Promise<PlacementRecord | undefined>;
	reportScores(
		snapshot: ScoreSnapshotRecord,
		ctx: CdContext,
	): Promise<Outcome<ScoreSnapshotRecord>>;
	/** Pure over recorded inputs (I18); records `placement.Decided`. */
	decide(
		input: Readonly<{
			placement: string;
			pipeline: string;
			node: string;
			stationId: string;
			subject: PlacementSubject;
			exclude?: readonly CampId[];
			count?: number;
		}>,
		ctx: CdContext,
	): Promise<Outcome<PlacementDecisionRecord>>;
	decision(decisionId: string): Promise<PlacementDecisionRecord | undefined>;
}

// ── Fan-out and failover (D21, D23) ────────────────────────────────────────
export interface FanoutController {
	start(
		input: Readonly<{
			pipeline: string;
			node: string;
			freightId: FreightId;
			decision: PlacementDecisionRecord;
			fanout: FanoutRecord;
			departure: DepartureAction;
			idempotencyKey: string;
		}>,
		ctx: CdContext,
	): Promise<Outcome<FanoutStatusRecord>>;
	get(fanoutId: FanoutId): Promise<FanoutStatusRecord | undefined>;
	list(
		query?: Readonly<{ pipeline?: string; node?: string; limit?: number }>,
	): Promise<readonly FanoutStatusRecord[]>;
	/** Camps of the node's latest completed decision with their qualified Freight. */
	qualified(input: Readonly<{ pipeline: string; node: string }>): Promise<
		Readonly<{
			decision?: PlacementDecisionRecord;
			qualifiedCampIds: readonly CampId[];
			stableFreightId?: FreightId;
		}>
	>;
	halt(
		fanoutId: FanoutId,
		reason: string,
		ctx: CdContext,
	): Promise<Outcome<FanoutStatusRecord>>;
	resume(
		fanoutId: FanoutId,
		ctx: CdContext,
	): Promise<Outcome<FanoutStatusRecord>>;
	rollback(
		fanoutId: FanoutId,
		reason: string,
		ctx: CdContext,
	): Promise<Outcome<FanoutStatusRecord>>;
	/** Advance in-flight fan-outs from journal state under lease `cd:fanout:<id>`. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export interface FailoverController {
	propose(
		input: Readonly<{ campId: CampId; reason: string; idempotencyKey: string }>,
		ctx: CdContext,
	): Promise<Outcome<readonly FailoverRecord[]>>;
	approve(
		failoverId: FailoverId,
		ctx: CdContext,
	): Promise<Outcome<FailoverRecord>>;
	get(failoverId: FailoverId): Promise<FailoverRecord | undefined>;
	list(
		query?: Readonly<{
			campId?: CampId;
			state?: FailoverState;
			limit?: number;
		}>,
	): Promise<readonly FailoverRecord[]>;
	rebalance(
		input: Readonly<{
			pipeline: string;
			node: string;
			reason: string;
			idempotencyKey: string;
		}>,
		ctx: CdContext,
	): Promise<Outcome<RebalanceRecord>>;
	tick(ctx: CdContext): Promise<void>;
}

// ── Policy delivery and posture (D24, D25) ─────────────────────────────────
export type RailEventReader = (
	after: string | undefined,
	signal: AbortSignal,
) => AsyncIterable<
	Readonly<{
		cursor: string;
		railId: string;
		railDigest: Digest;
		status: "approved" | "active" | "retired";
		stationId: string;
	}>
>;

export interface CampPolicy {
	binding(campId: CampId): Promise<PolicyBindingRecord | undefined>;
	/** Called by promotion only (subject RAIL). */
	bind(
		input: Readonly<{
			campId: CampId;
			freight: FreightRecord;
			mode: PolicyMode;
			promotionId: PromotionId;
		}>,
		ctx: CdContext,
	): Promise<Outcome<PolicyBindingRecord>>;
	/** Rollback: restore the previous enforced digest and clear the candidate. */
	restore(
		input: Readonly<{ campId: CampId; promotionId: PromotionId }>,
		ctx: CdContext,
	): Promise<Outcome<PolicyBindingRecord>>;
}

export type ShadowVerdict = Readonly<{
	candidateRailDigest: Digest;
	decisionId: string;
	effect: GatekeeperEffect;
	diverged: boolean;
}>;

export interface PostureSeriesReader {
	noncompliantRatio(
		input: Readonly<{
			campId: CampId;
			railDigest?: Digest;
			fromMs: number;
			toMs: number;
		}>,
	): Promise<readonly number[]>;
	shadowDivergence(
		input: Readonly<{
			campId: CampId;
			railDigest: Digest;
			fromMs: number;
			toMs: number;
		}>,
	): Promise<readonly number[]>;
}

export interface PostureService {
	compliance(campId: CampId): Promise<readonly ComplianceRecord[]>;
	/** Attribute paths the Camp's bound packs need; reconcilers report only these. */
	observeFields(campId: CampId): Promise<readonly string[]>;
	/** Open ownership conflicts the gate must honour (I22). */
	conflicts(campId: CampId): Promise<readonly PostureFindingRecord[]>;
	remediations(campId: CampId): Promise<readonly PostureRemediationRecord[]>;
	/** Evaluate due Camps, append compliance, propose remediation. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export interface ShadowRecorder {
	/** The Camp's candidate Rail and its resolved pack, while bound in INFORM. */
	candidate(
		campId: CampId,
	): Promise<
		Readonly<{ railDigest: Digest; policyPack: PolicyPack }> | undefined
	>;
	record(decision: ShadowDecisionRecord, ctx: CdContext): Promise<void>;
}

// ── Facade ─────────────────────────────────────────────────────────────────
export interface ContinuousDelivery {
	readonly freight: FreightLedger;
	readonly ingest: FreightIngest;
	readonly publishers: TrustedPublisherVerifier;
	readonly sources: FreightSources;
	readonly artifacts: ArtifactStore;
	readonly desired: DesiredStateReader;
	readonly deltas: DeltaLedger;
	readonly pipelines: PipelineController;
	readonly windows: ChangeWindows;
	readonly promotions: PromotionService & PreviewEnvironments;
	readonly rollouts: RolloutOrchestrator;
	readonly verification: VerificationEngine;
	readonly enrollment: AgentEnrollment;
	readonly feed: DeliveryFeedHandler;
	readonly telemetry: CdTelemetry;
	readonly authorizer: CdAuthorizer;
	readonly inventory: CampInventory;
	readonly placement: PlacementEngine;
	readonly fanout: FanoutController;
	readonly failover: FailoverController;
	readonly campPolicy: CampPolicy;
	readonly posture: PostureService;
	createReconciler(
		input: Readonly<{
			mode: ReconcilerMode;
			reconcilerId: ReconcilerId;
			campIds: readonly CampId[];
			holderId: string;
			transport?: ReconcilerTransport;
		}>,
	): CampReconciler;
}

// ── Module factory signatures (implemented in the named subpath) ───────────
export interface CdFactories {
	/** "./freight" (WP1) */
	createFreightLedger(
		d: CdBase & {
			readonly artifacts: ArtifactVerifier;
			readonly telemetry: TelemetrySink;
		},
	): FreightLedger;
	/** "./ingest" (WP1) */
	createTrustedPublisherVerifier(
		d: CdBase & { readonly http: HttpTransport },
	): TrustedPublisherVerifier;
	/** "./ingest" (WP1) */
	createFreightIngest(
		d: CdBase & {
			readonly ledger: FreightLedger;
			readonly publishers: TrustedPublisherVerifier;
			readonly provenance: ProvenanceVerifier;
			readonly sources: FreightSources;
			readonly authorizer: CdAuthorizer;
		},
	): FreightIngest;
	/** "./sources" (WP2) */
	createFreightSources(
		d: CdBase & {
			readonly ledger: FreightLedger;
			readonly drivers: readonly SubscriptionDriver[];
			readonly provenance: ProvenanceVerifier;
			readonly authorizer: CdAuthorizer;
			readonly webhookSecrets: CredentialResolver;
		},
	): FreightSources;
	/** "./sources" (WP2) */
	createSubscriptionDrivers(
		d: Readonly<{
			http: HttpTransport;
			credentials: CredentialResolver;
			readCiEvents?: CiEventReader;
			readCiArtifact?: CiArtifactReader;
			readRailEvents?: RailEventReader;
		}>,
	): readonly SubscriptionDriver[];
	/** "./artifacts" (WP3) */
	createArtifactStore(config: ArtifactStoreConfig, d: CdBase): ArtifactStore;
	/** "./artifacts" (WP3) */
	createArtifactVerifier(
		d: CdBase & {
			readonly artifacts: ArtifactStore;
			readonly http: HttpTransport;
		},
	): ArtifactVerifier;
	/** "./provenance" (WP3) */
	createProvenanceVerifier(
		d: CdBase & {
			readonly http: HttpTransport;
			readonly trustPolicy: JsonObject;
		},
	): ProvenanceVerifier;
	/** "./sets" (WP4) */
	createDesiredState(
		d: CdBase & { readonly artifacts: ArtifactStore },
	): DesiredStateReader & DeltaLedger;
	/** "./pipelines" (WP5) */
	createPipelineController(
		d: CdBase & {
			readonly freight: FreightLedger;
			readonly promotions: PromotionService;
			readonly placement: PlacementEngine;
			readonly fanout: FanoutController;
			readonly topology: TopologyReader;
			readonly authorizer: CdAuthorizer;
		},
	): PipelineController;
	/** "./windows" (WP5) */
	createChangeWindows(
		d: CdBase & { readonly authorizer: CdAuthorizer },
	): ChangeWindows;
	/** "./promotion" (WP6) */
	createPromotionService(
		d: CdBase & {
			readonly freight: FreightLedger;
			readonly pipelines: PipelineController;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly resolver: SetResolver;
			readonly gate: DeployGate;
			readonly approvals: ApprovalPort;
			readonly rollouts: RolloutOrchestrator;
			readonly verification: VerificationEngine;
			readonly runbooks: RunbookExecutor;
			readonly suites: VerifyPort;
			readonly notify: NotificationPort;
			readonly campPolicy: CampPolicy;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): PromotionService & PreviewEnvironments;
	/** "./reconcile" (WP7) */
	createCampReconciler(
		d: CdBase & {
			readonly reconcilerId: ReconcilerId;
			readonly mode: ReconcilerMode;
			readonly campIds: readonly CampId[];
			readonly holderId: string;
			readonly transport: ReconcilerTransport;
			readonly realizer: Realizer;
			readonly drift: DriftPolicy;
			readonly telemetry: TelemetrySink;
		},
	): CampReconciler;
	/** "./reconcile" (WP7) */
	createInProcessTransport(
		d: CdBase & {
			readonly desired: DesiredStateReader;
			readonly posture?: PostureService;
			readonly topology?: TopologyReader;
		},
	): ReconcilerTransport;
	/** "./verification" (WP9) */
	createVerificationEngine(
		d: CdBase & {
			readonly sources: readonly HealthSource[];
			readonly suites: VerifyPort;
			readonly http: HttpTransport;
		},
	): VerificationEngine;
	/** "./verification" (WP9) */
	createHealthSources(
		d: Readonly<{
			http: HttpTransport;
			credentials: CredentialResolver;
			posture?: PostureSeriesReader;
		}>,
	): readonly HealthSource[];
	/** "./rollout" (WP10) */
	createRolloutOrchestrator(
		d: CdBase & {
			readonly engine: RolloutEngine;
			readonly traffic: TrafficShifter;
			readonly verification: VerificationEngine;
			readonly windows: ChangeWindows;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly approvals: ApprovalPort;
			readonly telemetry: TelemetrySink;
		},
	): RolloutOrchestrator;
	/** "./agent" (WP11) */
	createAgentEnrollment(
		d: CdBase & {
			readonly authorizer: CdAuthorizer;
			readonly rails: RailDeliveryReader;
			readonly inventory: CampInventory;
		},
	): AgentEnrollment;
	/** "./agent" (WP11) */
	createHttpTransport(
		d: Readonly<{
			baseUrl: string;
			http: HttpTransport;
			reconcilerId: ReconcilerId;
			privateJwk: JsonObject;
			svid: string;
			now: () => number;
		}>,
	): ReconcilerTransport;
	/** "./feed" (WP11) */
	createDeliveryFeedHandler(
		d: CdBase & {
			readonly desired: DesiredStateReader;
			readonly enrollment: AgentEnrollment;
			readonly artifacts: ArtifactStore;
			readonly posture: PostureService;
			readonly inventory: CampInventory;
			readonly topology: TopologyReader;
		},
	): DeliveryFeedHandler;
	/** "./service" (WP12) */
	createCdService(
		d: CdBase & {
			readonly cd: ContinuousDelivery;
			readonly reconcilers: readonly CampReconciler[];
			readonly retention: readonly RetentionPolicyRecord[];
			readonly tickIntervalMs: number;
			readonly principal: PrincipalRef;
		},
	): CdService;
	/** "./authz" (WP19) */
	createCdAuthorizer(
		d: CdBase & { readonly policyPack: PolicyPack },
	): CdAuthorizer;
	/** "./telemetry" (WP19) */
	createCdTelemetry(d: CdBase): CdTelemetry;
	/** "./telemetry" (WP19) */
	createTelemetrySink(
		d: Readonly<{
			endpoint?: string;
			http: HttpTransport;
			headers?: Readonly<Record<string, string>>;
		}>,
	): TelemetrySink;
	/** "./inventory" (WP22) */
	createCampInventory(
		d: CdBase & {
			readonly topology: TopologyReader;
			readonly rails: RailDeliveryReader;
			readonly desired: DesiredStateReader;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): CampInventory;
	/** "./placement" (WP22) */
	createPlacementEngine(
		d: CdBase & {
			readonly inventory: CampInventory;
			readonly rails: RailDeliveryReader;
			readonly authorizer: CdAuthorizer;
		},
	): PlacementEngine;
	/** "./fanout" (WP23) */
	createFanoutController(
		d: CdBase & {
			readonly freight: FreightLedger;
			readonly promotions: PromotionService;
			readonly inventory: CampInventory;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly windows: ChangeWindows;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): FanoutController;
	/** "./failover" (WP23) */
	createFailoverController(
		d: CdBase & {
			readonly pipelines: PipelineController;
			readonly inventory: CampInventory;
			readonly placement: PlacementEngine;
			readonly fanout: FanoutController;
			readonly promotions: PromotionService;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly topology: TopologyReader;
			readonly rails: RailDeliveryReader;
			readonly traffic: TrafficShifter;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): FailoverController;
	/** "./posture" (WP24) */
	createCampPolicy(
		d: CdBase & { readonly authorizer: CdAuthorizer },
	): CampPolicy;
	/** "./posture" (WP24) */
	createShadowRecorder(
		d: CdBase & {
			readonly campPolicy: CampPolicy;
			readonly resolvePack: (railDigest: Digest) => Promise<PolicyPack>;
		},
	): ShadowRecorder;
	/** "./posture" (WP24) */
	createPostureService(
		d: CdBase & {
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly campPolicy: CampPolicy;
			readonly rails: RailDeliveryReader;
			readonly inventory: CampInventory;
			/** Policy packs by name, as policy-IR documents. */
			readonly packs: (
				names: readonly string[],
			) => Promise<readonly JsonObject[]>;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): PostureService & PostureSeriesReader;
}
