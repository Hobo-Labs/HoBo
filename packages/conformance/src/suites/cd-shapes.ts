// Structural shapes of the @hobo/cd ports and records the CD suites exercise.
//
// @hobo/conformance does not depend on @hobo/cd (CD depends on the platform,
// not the other way round), so these mirror the frozen contract in
// packages/cd/src/ports.ts and cd.proto field-for-field, narrowed to what a
// suite reads. Every real implementation is assignable to them. The enum
// mirrors are pinned against the generated enums by the kit's drift test
// (examples/cd-conformance-kit/test/shapes-drift.test.ts).
import type {
	ApplyResult,
	EventPosition,
	FenceToken,
	RoutingPlan,
	RoutingPlanId,
	RoutingStatus,
	TrafficRoutingOfferingId,
} from "@hobo/core";
import type { CdReasonLike } from "./cd-kit.js";

// ── Enum mirrors (numeric values of cd.proto) ───────────────────────────────

export const CD_ARTIFACT_KIND = Object.freeze({
	WASM_COMPONENT: 1,
	FUNCTION_BUNDLE: 2,
	STATIC_ASSETS: 3,
	OCI_IMAGE: 4,
	VM_IMAGE: 5,
	PACKAGE: 6,
	SOURCE_TREE: 7,
} as const);

export const CD_SUBSCRIPTION_KIND = Object.freeze({
	OCI_REPOSITORY: 1,
	GIT_REPOSITORY: 2,
	PACKAGE_REGISTRY: 3,
	HTTP_INDEX: 4,
	HOBO_CI: 5,
	HOBO_RAIL: 6,
} as const);

export const CD_RECONCILE_STATUS = Object.freeze({
	CONVERGING: 1,
	CONVERGED: 2,
	BLOCKED: 3,
	DRIFTED: 4,
	OBSERVED: 5,
} as const);

export const CD_HEALTH_SOURCE_KIND = Object.freeze({
	PROMETHEUS: 1,
	HOBO_METERING: 2,
	HTTP_JSON: 3,
	DATADOG: 4,
	NEW_RELIC: 5,
	CLOUDWATCH: 6,
	HOBO_POSTURE: 7,
} as const);

export const CD_COHORT = Object.freeze({
	CANARY: 1,
	BASELINE: 2,
	ALL: 3,
} as const);

export const CD_CAMP_MANAGEMENT = Object.freeze({
	MANAGED: 1,
	OBSERVE_ONLY: 2,
} as const);

export const CD_CONDITION_TYPE = Object.freeze({
	READY: 1,
	REACHABLE: 2,
	LEASED: 3,
	CREDENTIAL_VALID: 4,
	CLAIMS_CONSISTENT: 5,
	POSTURE_COMPLIANT: 6,
} as const);

export const CD_CONDITION_STATUS = Object.freeze({
	TRUE: 1,
	FALSE: 2,
	UNKNOWN: 3,
} as const);

export const CD_SIGNAL_SOURCE = Object.freeze({
	STATION: 1,
	RECONCILER: 2,
	HEALTH_SOURCE: 3,
	OPERATOR: 4,
} as const);

export const CD_TAINT_EFFECT = Object.freeze({
	NO_PLACE: 1,
	NO_RUN: 2,
} as const);

export const CD_FANOUT_STRATEGY = Object.freeze({
	ALL: 1,
	PROGRESSIVE: 2,
	PROGRESSIVE_PER_GROUP: 3,
} as const);

export const CD_FANOUT_STATE = Object.freeze({
	RUNNING: 1,
	HALTED: 2,
	COMPLETED: 3,
	ROLLED_BACK: 4,
	SUPERSEDED: 5,
} as const);

// public-contract: refusal codes the CD suites expect by name (plan 0024).
export const CD_REFUSAL = Object.freeze({
	placementUnsatisfiable: "placement-unsatisfiable",
	progressiveUnsupported: "progressive-unsupported",
	failoverUnsafe: "failover-unsafe",
	ownershipConflict: "ownership-conflict",
	enrollmentIncomplete: "enrollment-incomplete",
} as const);

// ── Shared records ───────────────────────────────────────────────────────────

export type Outcome<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; reasons: readonly CdReasonLike[] }>;

export type CdContextLike = Readonly<{
	tenant: string;
	principal: unknown;
	now: () => number;
	signal?: AbortSignal;
}>;

export type ArtifactRefLike = Readonly<{
	name: string;
	kind: number;
	digest: string;
	coordinate: string;
	sizeBytes?: bigint;
	mediaType?: string;
	ecosystem?: string;
}>;

export type ProvenanceRefLike = Readonly<{
	statementDigest: string;
	builderId: string;
	signerIdentity: string;
	verified: boolean;
	verifier: string;
	subjectDigests: readonly string[];
}>;

export type ResourceObservationLike = Readonly<{
	resource: string;
	healthy: boolean;
	driftKind: string;
	attributes?: Readonly<Record<string, string>>;
	retained?: readonly string[];
}>;

export type ReconcileObservationLike = Readonly<{
	campId: string;
	setId: string;
	fenceToken: string;
	status: number;
	resources: readonly ResourceObservationLike[];
	reasons: readonly CdReasonLike[];
}>;

export type SetRecordLike = Readonly<{
	setId: string;
	campId: string;
	freightId: string;
}>;

// ── Ports (structural) ───────────────────────────────────────────────────────

export type RealizeInputLike<TSet extends SetRecordLike, TResolved> = Readonly<{
	campId: string;
	desired: TSet;
	resolved: TResolved;
	reconcilerId: string;
	fence: FenceToken;
	signal: AbortSignal;
	previous?: TSet;
}>;

export interface RealizerLike<TInput, TCtx> {
	converge(input: TInput, ctx: TCtx): Promise<ReconcileObservationLike>;
	observe(input: TInput, ctx: TCtx): Promise<ReconcileObservationLike>;
}

export interface TrafficShifterLike<TCtx> {
	offerings(campId: string): Promise<readonly TrafficRoutingOfferingId[]>;
	shift(
		input: Readonly<{ campId: string; plan: RoutingPlan; signal: AbortSignal }>,
		ctx: TCtx,
	): Promise<ApplyResult>;
	status(campId: string, planId: RoutingPlanId): Promise<RoutingStatus | null>;
}

export type HealthSamplesLike = Readonly<{
	values: readonly number[];
	fromMs: number;
	toMs: number;
}>;

export interface HealthSourceLike<TQuery, TCtx> {
	readonly kind: number;
	query(
		input: Readonly<{
			query: TQuery;
			campId: string;
			cohort: number;
			fromMs: number;
			toMs: number;
			signal: AbortSignal;
		}>,
		ctx: TCtx,
	): Promise<Outcome<HealthSamplesLike>>;
}

export interface PublisherLike<TSet, TResolved, TCtx> {
	readonly target: string;
	publish(
		input: Readonly<{ set: TSet; resolved: TResolved; signal: AbortSignal }>,
		ctx: TCtx,
	): Promise<Outcome<Readonly<{ revision: string }>>>;
	observe(
		input: Readonly<{ set: TSet; revision: string; signal: AbortSignal }>,
		ctx: TCtx,
	): Promise<ReconcileObservationLike>;
}

export type ReconcilerLeaseLike = Readonly<{
	reconcilerId: string;
	campId: string;
	holderId: string;
	fence: FenceToken;
	expiresAtMs: number;
}>;

export type DesiredStateChangeLike = Readonly<{
	position: EventPosition;
	set: SetRecordLike;
}>;

export interface ReconcilerTransportLike<
	TLease extends ReconcilerLeaseLike,
	TObs,
> {
	claim(
		input: Readonly<{
			reconcilerId: string;
			campId: string;
			holderId: string;
			ttlMs: number;
		}>,
	): Promise<Outcome<TLease>>;
	renew(lease: TLease): Promise<Outcome<TLease>>;
	release(lease: TLease): Promise<void>;
	feed(
		input: Readonly<{ lease: TLease; signal: AbortSignal }>,
	): AsyncIterable<DesiredStateChangeLike>;
	report(lease: TLease, observation: TObs): Promise<Outcome<EventPosition>>;
	checkpoint(
		lease: TLease,
		position: EventPosition,
	): Promise<Outcome<EventPosition>>;
}

export interface ArtifactStoreLike<TCtx> {
	readonly backend: string;
	put(
		bytes: Uint8Array,
		meta: Readonly<{ name: string; kind: number; mediaType: string }>,
		ctx: TCtx,
	): Promise<ArtifactRefLike>;
	get(digest: `sha256:${string}`): Promise<Uint8Array | undefined>;
	has(digest: `sha256:${string}`): Promise<boolean>;
	list(signal: AbortSignal): AsyncIterable<string>;
	delete(digest: `sha256:${string}`, reason: string, ctx: TCtx): Promise<void>;
}

export interface ArtifactVerifierLike<TManifest, TCtx> {
	verify(manifest: TManifest, ctx: TCtx): Promise<Outcome<TManifest>>;
}

export type ProvenanceInputLike = Readonly<{
	statement: Uint8Array;
	bundle?: Uint8Array;
	subjects: readonly ArtifactRefLike[];
	trustedBuilderIds: readonly string[];
	trustedSignerIdentities: readonly string[];
}>;

export interface ProvenanceVerifierLike<TCtx> {
	verify(
		input: ProvenanceInputLike,
		ctx: TCtx,
	): Promise<Outcome<readonly ProvenanceRefLike[]>>;
}

export type DiscoveredArtifactLike = Readonly<{
	source: string;
	subscription: string;
	artifact?: ArtifactRefLike;
	version: string;
	commit: string;
}>;

export interface SubscriptionDriverLike<TSub, TCtx> {
	readonly kind: number;
	discover(
		input: Readonly<{
			source: string;
			subscription: TSub;
			cursor?: string;
			signal: AbortSignal;
		}>,
		ctx: TCtx,
	): Promise<
		Outcome<
			Readonly<{ artifacts: readonly DiscoveredArtifactLike[]; cursor: string }>
		>
	>;
}
