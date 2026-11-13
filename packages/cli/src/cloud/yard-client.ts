import { create } from "@bufbuild/protobuf";
import {
	canonicalManifestHash,
	type ManifestV1,
	serializeManifest,
} from "@hobo/bindles";
import type {
	CampId,
	CampReconciler,
	CdContext,
	ContinuousDelivery,
	Digest,
	FreightId,
	OtelMetricPoint,
	Outcome,
	PromotionId,
	ReconcilerId,
	TelemetrySink,
} from "@hobo/cd";
import {
	ArtifactKind,
	FREIGHT_MANIFEST_SCHEMA,
	type FreightManifestRecord,
	FreightManifestRecordSchema,
	FreightOrigin,
	type FreightRecord,
	type PromotionRecord,
	PromotionState,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcilerMode,
	ReconcileStatus,
	SetOrigin,
	type SetRecord,
} from "@hobo/cd";
import {
	collectStream,
	type DeploymentPlan,
	type DeployResult,
	type DeployResultPlanned,
	deploy,
	type GatewayContext,
	type GatewayDeps,
	manifestHostingPolicy,
	type OrchestratorDeps,
	type OrchestratorResult,
	type PlannerRegistry,
	type PlanRemediation,
	type PlanResult,
	plan as planDeployment,
	runCompensation,
	runOrchestrator,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import type { PrincipalRef } from "@hobo/core";

// The Yard-client seam (S2-08): the single in-process call path the four cloud
// verbs (login/plan/up/down) share. The CLI dispatch layer is the source of
// truth for the CLI<->Yard boundary; MCP parity (S3-01) reuses this same seam.
//
// `src/` stays adapter-free: the concrete EventStore/ActorHost/Executor/
// IacProvider and provider registry are INJECTED via YardRuntime (tests populate
// them from @hobo/runtime-local + @hobo/provider-cloudflare + an in-memory
// IacProvider). Un-injected, the cloud verbs fall back to their shell stubs.

// A dev/mocked-lane session. The gateway accepts any attributable (non-system,
// non-empty-id) principal (gateway.authorize), so a fixture principal suffices
// for the mocked lane; @hobo/identity SVID brokering is a later slice.
export interface YardSession {
	readonly tenant: string;
	readonly principal: PrincipalRef;
	readonly token: string;
	readonly issuedAt: string;
}

// The env-specific runtime the Yard drives. Every field is sourced structurally
// from @hobo/cloud re-exports so `src/` never imports an infra adapter directly.
export interface YardRuntime {
	readonly store: GatewayDeps["store"];
	readonly actorHost: GatewayDeps["actorHost"];
	readonly executor: OrchestratorDeps["executor"];
	readonly broker: OrchestratorDeps["broker"];
	readonly registry: PlannerRegistry;
	/** Authoritative financial evidence and admission; never supplied by a CLI flag. */
	readonly hostingBudgetAuthority?: SharedHostingBudgetAuthority;
	readonly defaultHostingBudgetId?: string;
	readonly hostingBudgetRequired?: boolean;
	/** @hobo/cd desired-state delivery (D13). Composed by WP18; absent = legacy direct path. */
	readonly delivery?: YardDelivery;
	/** The production hosting supervisor owns provider effects and observed teardown. */
	readonly hostingExecution?: {
		up(request: {
			admission: DeployResultPlanned;
			session: YardSession;
		}): Promise<UpResult>;
		down(request: {
			deploymentId: string;
			session: YardSession;
			bindle: ManifestV1;
		}): Promise<DownResult>;
	};
}

export interface DeployConfig {
	readonly objective?: string;
	readonly region?: string;
	readonly budgetId?: string;
}

export interface PlanRenderedSuccess {
	readonly ok: true;
	readonly deploymentId: string;
	readonly planHash: string;
	readonly plan: DeploymentPlan;
	readonly resources: DeploymentPlan["resources"];
	readonly dependencyOrder: string[];
}

export interface PlanRenderedRejection {
	readonly ok: false;
	readonly deploymentId: string;
	readonly reason: string;
	readonly remediations: PlanRemediation[];
}

export type PlanRendered = PlanRenderedSuccess | PlanRenderedRejection;

export interface ProgressEvent {
	readonly type: string;
	readonly resourceId?: string;
	readonly detail: string;
}

export interface UpRejected {
	readonly status: "rejected";
	readonly deploymentId: string;
	readonly reason: string;
	readonly remediations: PlanRemediation[];
}

export interface UpRealized {
	readonly status: OrchestratorResult["status"];
	readonly deploymentId: string;
	readonly planHash: string;
	readonly plan: DeploymentPlan;
	readonly provisioned: string[];
	readonly progress: ProgressEvent[];
}

export type UpResult = UpRejected | UpRealized;

export interface DownResult {
	// CLI-facing teardown status: "destroyed" when the compensation/destroy path
	// tore everything down, "needs-human" when a destroy failed mid-rollback.
	readonly status: "destroyed" | "needs-human";
	readonly deploymentId: string;
	readonly destroyed: string[];
	readonly progress: ProgressEvent[];
}

// ── Desired-state delivery (plan 0024 D13) ──────────────────────────────────
// With `runtime.delivery` wired, `hobo up` declares desired state instead of
// driving the orchestrator imperatively: it records LOCAL_BUILD Freight,
// promotes it into the deployment Camp, and an in-process conductor converges
// it with bounded `reconcileOnce` passes. `down` is a teardown Delta through
// the same gate. UpResult/DownResult are unchanged; CD detail travels in the
// DeliveryReceipt beside them.
//
// Runbook (handed to WP21 for packages/hobo/CD.md):
// - `HOBO_FREIGHT_STALE` / `HOBO_FREIGHT_FOREIGN`: `.hobo/freight.json` was
//   built for another declaration or project. Run `hobo build`, then `hobo up`.
// - `HOBO_FREIGHT_INVALID`: delete `.hobo/freight.json`, run `hobo build`.
// - `HOBO_FREIGHT_ARTIFACT_MISSING`: the configured artifact store lacks the
//   built bytes (store changed or swept). Run `hobo build` against it.
// - `HOBO_FREIGHT_DECLARATION_MISMATCH`: the artifact store does not address
//   bytes by sha256; fix the store configuration.
// - `HOBO_FREIGHT_UNKNOWN`: `--to` names nothing recorded; list Freight with
//   `hobo deploy freight list`.
// - `HOBO_ROLLBACK_UNAVAILABLE`: the Camp has no predecessor Set (first deploy,
//   or torn down); pin a revision with `--to`.
// - `HOBO_PROMOTION_REFUSED`: the gate, lineage or authorization refused; the
//   remediations carry the CD reasons verbatim.
// - `HOBO_PROMOTION_HELD`: approval or a closed change window parks the
//   promotion; `hobo deploy status` shows it, rerun `hobo up` afterwards.
// - `HOBO_UP_INCOMPLETE` with status `needs-human`: the reconciler reported
//   BLOCKED; its reasons are in the `deployment.ReconcileBlocked` progress
//   line. With status `waiting`: convergence outlived the bounded passes
//   (`YardDelivery.maxPasses`, default 16); rerun `hobo up` (idempotent) or
//   let `hobo serve cd` finish it.
// - `HOBO_DELIVERY_UNAVAILABLE`: `--to`/`--rollback` on a lane without CD.
// Metrics: `hobo.cli.delivery.{outcome,passes,duration}` by verb and outcome;
// a failing TelemetrySink shows as a `telemetry.Unavailable` progress line.

// public-contract: where `hobo build` writes the hobo.freight-manifest/v1 document.
export const FREIGHT_FILE = ".hobo/freight.json";
// public-contract: media type of the canonical Bindle bytes stored under declaration_hash.
export const DECLARATION_MEDIA_TYPE = "application/vnd.hobo.bindle+json";
// public-contract: artifact name of the stored declaration.
export const DECLARATION_ARTIFACT = "declaration";
// public-contract: Freight label marking an anonymous (claimable) deploy.
export const ANONYMOUS_LABEL = "hobo.dev/anonymous";
// public-contract: bounded conductor passes before `up` reports "waiting".
export const DELIVERY_MAX_PASSES = 16;

// public-contract: typed delivery refusals; each carries a remediation.
export const DELIVERY_REFUSAL = Object.freeze({
	freightInvalid: "HOBO_FREIGHT_INVALID",
	freightStale: "HOBO_FREIGHT_STALE",
	artifactMissing: "HOBO_FREIGHT_ARTIFACT_MISSING",
	declarationMismatch: "HOBO_FREIGHT_DECLARATION_MISMATCH",
	freightRefused: "HOBO_FREIGHT_REFUSED",
	freightUnknown: "HOBO_FREIGHT_UNKNOWN",
	freightForeign: "HOBO_FREIGHT_FOREIGN",
	rollbackUnavailable: "HOBO_ROLLBACK_UNAVAILABLE",
	promotionRefused: "HOBO_PROMOTION_REFUSED",
	promotionHeld: "HOBO_PROMOTION_HELD",
	deliveryUnavailable: "HOBO_DELIVERY_UNAVAILABLE",
} as const);
export type DeliveryRefusalCode =
	(typeof DELIVERY_REFUSAL)[keyof typeof DELIVERY_REFUSAL];

// public-contract: metric names `hobo up`/`down` emit through the TelemetrySink.
export const DELIVERY_METRIC = Object.freeze({
	outcome: "hobo.cli.delivery.outcome",
	passes: "hobo.cli.delivery.passes",
	duration: "hobo.cli.delivery.duration",
} as const);

/** `@hobo/cd/freight` `writeFreightManifest` / `parseFreightManifest`, injected (WP18 binds them). */
export interface FreightManifestCodec {
	write(manifest: FreightManifestRecord): Uint8Array;
	parse(bytes: Uint8Array): Outcome<FreightManifestRecord>;
}

/** The slice of the composed `ContinuousDelivery` facade `hobo up`/`down`/`build` drive. */
export type DeliveryPorts = Pick<
	ContinuousDelivery,
	"freight" | "artifacts" | "desired" | "promotions" | "createReconciler"
>;

export interface YardDelivery {
	readonly cd: DeliveryPorts;
	readonly freightManifest: FreightManifestCodec;
	/** Deployment Camp for a project; defaults to the deployment id. */
	readonly campFor?: (deploymentId: string) => string;
	readonly telemetry?: TelemetrySink;
	/** Injected clock (epoch ms); defaults to the wall clock at this edge. */
	readonly now?: () => number;
	readonly maxPasses?: number;
}

export type DeliveryMode = "up" | "to" | "rollback" | "anonymous" | "down";

/** What `up`/`down` delivered, beside the unchanged UpResult/DownResult. */
export type DeliveryReceipt = Readonly<{
	campId: string;
	mode: DeliveryMode;
	freightId?: string | undefined;
	alias?: string | undefined;
	setId?: string | undefined;
	promotionId?: string | undefined;
	passes: number;
	refusal?: DeliveryRefusalCode | undefined;
	claimHint?: string | undefined;
}>;

export interface DeliverOptions {
	readonly deploymentId: string;
	readonly session: YardSession;
	readonly config?: DeployConfig | undefined;
	/** Bytes of `.hobo/freight.json` when `hobo build` wrote one. */
	readonly freightManifest?: Uint8Array | undefined;
	/** `--to <freight id | alias>`. */
	readonly to?: string | undefined;
	readonly rollback?: boolean | undefined;
	readonly anonymous?: boolean | undefined;
	/** Streamed while the conductor loop runs. */
	readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
}

export interface YardClient {
	readonly planAuthoritatively: (
		bindle: ManifestV1,
		options: {
			deploymentId: string;
			session: YardSession;
			config?: DeployConfig;
		},
	) => Promise<PlanRendered>;
	readonly plan: (
		bindle: ManifestV1,
		options: { deploymentId: string; config?: DeployConfig },
	) => PlanRendered;
	readonly up: (
		bindle: ManifestV1,
		options: {
			deploymentId: string;
			session: YardSession;
			config?: DeployConfig;
		},
	) => Promise<UpResult>;
	readonly down: (
		bindle: ManifestV1,
		options: { deploymentId: string; session: YardSession },
	) => Promise<DownResult>;
	/** `up` with its DeliveryReceipt (present when delivery is wired). */
	readonly deliver: (
		bindle: ManifestV1,
		options: DeliverOptions,
	) => Promise<Readonly<{ result: UpResult; receipt?: DeliveryReceipt }>>;
	/** `down` with its DeliveryReceipt (present when delivery is wired). */
	readonly teardown: (
		bindle: ManifestV1,
		options: Readonly<{
			deploymentId: string;
			session: YardSession;
			onProgress?: (event: ProgressEvent) => void;
		}>,
	) => Promise<Readonly<{ result: DownResult; receipt?: DeliveryReceipt }>>;
}

function progressFrom(events: OrchestratorResult["events"]): ProgressEvent[] {
	const progress: ProgressEvent[] = [];
	for (const event of events) {
		if (
			!event.type.startsWith("exec.") &&
			!event.type.startsWith("resource.")
		) {
			continue;
		}
		// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
		const data = event.data as {
			resourceId?: string;
			summary?: string;
			reason?: string;
		};
		const resourceId = data.resourceId;
		const detail = data.summary ?? data.reason ?? event.type;
		progress.push(
			resourceId !== undefined
				? { type: event.type, resourceId, detail }
				: { type: event.type, detail },
		);
	}
	return progress;
}

interface PlanConfigInput {
	deploymentId: string;
	objective?: string;
	region?: string;
}

function planConfig(
	deploymentId: string,
	config?: DeployConfig,
): PlanConfigInput {
	return {
		deploymentId,
		...(config?.objective !== undefined
			? { objective: config.objective }
			: undefined),
		...(config?.region !== undefined ? { region: config.region } : undefined),
	};
}

export function createYardClient(runtime: YardRuntime): YardClient {
	const gatewayDeps: GatewayDeps = {
		store: runtime.store,
		actorHost: runtime.actorHost,
		registry: runtime.registry,
	};
	if (runtime.hostingBudgetAuthority)
		gatewayDeps.hostingBudgetAuthority = runtime.hostingBudgetAuthority;
	const orchestratorDeps: OrchestratorDeps = {
		store: runtime.store,
		actorHost: runtime.actorHost,
		executor: runtime.executor,
		broker: runtime.broker,
	};

	function pureplan(
		bindle: ManifestV1,
		deploymentId: string,
		config?: DeployConfig,
	): PlanResult {
		return planDeployment(
			bindle,
			planConfig(deploymentId, config),
			runtime.registry,
		);
	}

	const driver = runtime.delivery
		? createDesiredStateDriver(runtime.delivery)
		: undefined;

	const client: YardClient = {
		async planAuthoritatively(bindle, { deploymentId, session, config }) {
			const budgetId = config?.budgetId ?? runtime.defaultHostingBudgetId;
			const authority = runtime.hostingBudgetAuthority;
			if (
				!budgetId ||
				!authority?.resolve ||
				authority.persistence !== "durable-cas"
			)
				return {
					ok: false,
					deploymentId,
					reason: "authoritative hosting budget is not configured",
					remediations: [],
				};
			const evidence = await authority.resolve({
				budgetId,
				tenantId: session.tenant,
				bindle,
				objective:
					config?.objective ??
					manifestHostingPolicy(bindle).budgetPolicy?.objective ??
					"min-cost",
			});
			if (
				evidence.budget.tenantId !== session.tenant ||
				evidence.budget.budgetId !== budgetId
			)
				throw new Error("hosting evidence belongs to another tenant or budget");
			const result = planDeployment(
				bindle,
				{ ...planConfig(deploymentId, config), hostingBudget: evidence },
				runtime.registry,
			);
			return result.ok
				? {
						ok: true,
						deploymentId,
						planHash: result.planHash,
						plan: result.plan,
						resources: result.plan.resources,
						dependencyOrder: result.plan.dependencyOrder,
					}
				: {
						ok: false,
						deploymentId,
						reason: result.reason,
						remediations: result.remediations,
					};
		},
		plan(bindle, { deploymentId, config }) {
			const result = pureplan(bindle, deploymentId, config);
			if (!result.ok) {
				return {
					ok: false,
					deploymentId,
					reason: result.reason,
					remediations: result.remediations,
				};
			}
			return {
				ok: true,
				deploymentId,
				planHash: result.planHash,
				plan: result.plan,
				resources: result.plan.resources,
				dependencyOrder: result.plan.dependencyOrder,
			};
		},

		async up(bindle, options) {
			return (await client.deliver(bindle, options)).result;
		},

		async deliver(bindle, options) {
			const { deploymentId, session, config } = options;
			const budgetId = config?.budgetId ?? runtime.defaultHostingBudgetId;
			const requiresHosting =
				runtime.hostingBudgetRequired === true ||
				budgetId !== undefined ||
				manifestHostingPolicy(bindle).required;
			if (requiresHosting && (!runtime.hostingExecution || !budgetId))
				return {
					result: {
						status: "rejected",
						deploymentId,
						reason:
							"budgeted hosting requires a configured production supervisor and budget ID",
						remediations: [],
					},
				};
			// D13: without budgeted hosting, `up` declares desired state.
			if (!requiresHosting && driver) return driver.up(bindle, options);
			// Revision selection exists only on desired state; never ignore it.
			if (options.to !== undefined || options.rollback) {
				const refused = refusal(
					DELIVERY_REFUSAL.deliveryUnavailable,
					`--to and --rollback select desired state, which this ${requiresHosting ? "budgeted hosting" : "Yard"} lane does not record`,
					requiresHosting
						? "Deploy the revision you want with `hobo up` (budgeted hosting has no revision selector)."
						: "Run against a Yard composed with @hobo/cd delivery (`hobo serve cd` or the default local runtime), or deploy the revision you want with `hobo up`.",
				);
				return {
					result: refusedResult(deploymentId, refused),
					receipt: {
						campId: deploymentId,
						mode: options.rollback ? "rollback" : "to",
						passes: 0,
						refusal: refused.code,
					},
				};
			}
			const context: GatewayContext = {
				tenant: session.tenant,
				actor: session.principal,
				correlationId: `deploy:${deploymentId}`,
			};
			const effectiveConfig = { ...config };
			if (budgetId) effectiveConfig.budgetId = budgetId;
			const deployResult: DeployResult = await deploy(
				gatewayDeps,
				{
					deploymentId,
					bindle,
					config: effectiveConfig,
				},
				context,
			);
			if (deployResult.status === "rejected") {
				return {
					result: {
						status: "rejected",
						deploymentId,
						reason: deployResult.reason,
						remediations: deployResult.remediations,
					},
				};
			}
			if (requiresHosting) {
				if (!deployResult.hostingReservationId || !runtime.hostingExecution)
					throw new Error(
						"budgeted plan has no authoritative reservation or supervisor",
					);
				return {
					result: await runtime.hostingExecution.up({
						admission: deployResult,
						session,
					}),
				};
			}

			const orchestrated = await runOrchestrator(
				orchestratorDeps,
				deployResult.plan,
				deploymentId,
				{
					tenant: session.tenant,
					actor: session.principal,
					correlationId: `deploy:${deploymentId}`,
				},
			);

			return {
				result: {
					status: orchestrated.status,
					deploymentId,
					planHash: deployResult.planHash,
					plan: deployResult.plan,
					provisioned: orchestrated.provisioned,
					progress: progressFrom(orchestrated.events),
				},
			};
		},

		async down(bindle, options) {
			return (await client.teardown(bindle, options)).result;
		},

		async teardown(bindle, options) {
			const { deploymentId, session } = options;
			const history = await collectStream(
				runtime.store,
				`deployment:${deploymentId}`,
			);
			if (
				runtime.hostingBudgetRequired ||
				history.some((event) => event.type === "hosting.BudgetReserved") ||
				manifestHostingPolicy(bindle).required
			) {
				if (!runtime.hostingExecution)
					return {
						result: {
							status: "needs-human",
							deploymentId,
							destroyed: [],
							progress: [],
						},
					};
				return {
					result: await runtime.hostingExecution.down({
						deploymentId,
						session,
						bindle,
					}),
				};
			}
			// D13: `down` is a teardown Delta through the same gate.
			if (driver) return driver.down(options);
			const planResult = pureplan(bindle, deploymentId);
			if (!planResult.ok) {
				return {
					result: {
						status: "needs-human",
						deploymentId,
						destroyed: [],
						progress: [],
					},
				};
			}
			const deploymentPlan = planResult.plan;
			const first = deploymentPlan.resources[0];
			const compensation = await runCompensation(
				orchestratorDeps,
				deploymentPlan,
				deploymentId,
				{
					resourceId: first?.name ?? deploymentId,
					reason: "operator-requested teardown",
				},
				{
					tenant: session.tenant,
					actor: session.principal,
					correlationId: `down:${deploymentId}`,
				},
			);
			const events = await collectStream(
				runtime.store,
				`deployment:${deploymentId}`,
			);
			return {
				result: {
					status:
						compensation.status === "rolled-back" ? "destroyed" : "needs-human",
					deploymentId,
					destroyed: compensation.destroyedOrder,
					progress: progressFrom(events),
				},
			};
		},
	};
	return client;
}

// ── Desired-state driver ────────────────────────────────────────────────────

type DriverUp = Readonly<{ result: UpResult; receipt: DeliveryReceipt }>;
type DriverDown = Readonly<{ result: DownResult; receipt: DeliveryReceipt }>;

interface DesiredStateDriver {
	up(bindle: ManifestV1, options: DeliverOptions): Promise<DriverUp>;
	down(
		options: Readonly<{
			deploymentId: string;
			session: YardSession;
			onProgress?: (event: ProgressEvent) => void;
		}>,
	): Promise<DriverDown>;
}

type Refused = Readonly<{
	refused: true;
	code: DeliveryRefusalCode;
	message: string;
	reasons: readonly ReasonRecord[];
	remediation: string;
}>;

type Converged = Readonly<{
	passes: number;
	set?: SetRecord | undefined;
	observation?: ReconcileObservationRecord | undefined;
	promotion?: PromotionRecord | undefined;
	/** The promotion parked before applying (approval or window). */
	held?: PromotionRecord;
	/** The promotion ended without applying. */
	failed?: PromotionRecord;
}>;

const FAILED_PROMOTION: ReadonlySet<PromotionState> = new Set([
	PromotionState.REJECTED,
	PromotionState.FAILED,
	PromotionState.SUPERSEDED,
]);
const HELD_PROMOTION: ReadonlySet<PromotionState> = new Set([
	PromotionState.AWAITING_APPROVAL,
	PromotionState.AWAITING_WINDOW,
]);

const STATUS_EVENT = {
	[ReconcileStatus.UNSPECIFIED]: "deployment.StatusObserved",
	[ReconcileStatus.CONVERGING]: "deployment.ReconcileStarted",
	[ReconcileStatus.CONVERGED]: "deployment.Converged",
	[ReconcileStatus.BLOCKED]: "deployment.ReconcileBlocked",
	[ReconcileStatus.DRIFTED]: "deployment.StatusObserved",
	[ReconcileStatus.OBSERVED]: "deployment.StatusObserved",
} as const satisfies Readonly<Record<ReconcileStatus, string>>;

const ANONYMOUS_CLAIM_HINT =
	"Claim this deployment: `hobo login` then `hobo up` (local Yard), or `hobo claim <account> --broker <uri> --token <token>` (remote)."; // public-contract: claim next step printed after `hobo up --anonymous`

function remediationOf(
	resource: string,
	code: string,
	remediation: string,
): PlanRemediation {
	return {
		resource,
		code,
		requiredPort: "",
		requiredFeatures: [],
		missing: [],
		remediation,
	};
}

function refusedResult(deploymentId: string, refused: Refused): UpRejected {
	return {
		status: "rejected",
		deploymentId,
		reason: `${refused.code}: ${refused.message}`,
		remediations: [
			remediationOf(deploymentId, refused.code, refused.remediation),
			...refused.reasons.map((item) =>
				remediationOf(
					item.subject === "" ? deploymentId : item.subject,
					item.code,
					item.remediation,
				),
			),
		],
	};
}

function refusal(
	code: DeliveryRefusalCode,
	message: string,
	remediation: string,
	reasons: readonly ReasonRecord[] = [],
): Refused {
	return { refused: true, code, message, remediation, reasons };
}

function resourceNames(
	observation: ReconcileObservationRecord | undefined,
): string[] {
	return observation?.status === ReconcileStatus.CONVERGED
		? observation.resources.map((item) => item.resource).sort()
		: [];
}

function isDigest(value: string): value is Digest {
	return /^sha256:[0-9a-f]{64}$/.test(value);
}

function createDesiredStateDriver(delivery: YardDelivery): DesiredStateDriver {
	const { cd } = delivery;
	const now = delivery.now ?? (() => Date.now());
	const maxPasses = Math.max(1, delivery.maxPasses ?? DELIVERY_MAX_PASSES);
	const campFor = delivery.campFor ?? ((deploymentId: string) => deploymentId);
	const encoder = new TextEncoder();

	function contextFor(session: YardSession): CdContext {
		return { tenant: session.tenant, principal: session.principal, now };
	}

	async function emitMetrics(
		verb: "up" | "down",
		outcome: string,
		passes: number,
		startedMs: number,
		emit: (event: ProgressEvent) => void,
	): Promise<void> {
		if (!delivery.telemetry) return;
		const atMs = now();
		const attributes = { verb, outcome };
		const points: OtelMetricPoint[] = [
			{
				name: DELIVERY_METRIC.outcome,
				kind: "counter",
				value: 1,
				unit: "{delivery}",
				atMs,
				attributes,
			},
			{
				name: DELIVERY_METRIC.passes,
				kind: "histogram",
				value: passes,
				unit: "{pass}",
				atMs,
				attributes,
			},
			{
				name: DELIVERY_METRIC.duration,
				kind: "histogram",
				value: Math.max(0, atMs - startedMs),
				unit: "ms",
				atMs,
				attributes,
			},
		];
		try {
			await delivery.telemetry.metrics(points);
		} catch (error) {
			// Telemetry never decides a delivery, but its loss is visible.
			emit({
				type: "telemetry.Unavailable",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function parseBuiltFreight(
		bytes: Uint8Array,
		bindleName: string,
		declarationHash: Digest,
	): Promise<FreightManifestRecord | Refused> {
		const parsed = delivery.freightManifest.parse(bytes);
		if (!parsed.ok)
			return refusal(
				DELIVERY_REFUSAL.freightInvalid,
				`${FREIGHT_FILE} is not a ${FREIGHT_MANIFEST_SCHEMA} document`,
				`Delete ${FREIGHT_FILE} and run \`hobo build\` again.`,
				parsed.reasons,
			);
		const built = parsed.value;
		if (built.declarationHash !== declarationHash)
			return refusal(
				DELIVERY_REFUSAL.freightStale,
				`${FREIGHT_FILE} was built for declaration ${built.declarationHash}; the project now declares ${declarationHash}`,
				"Run `hobo build` so the Freight matches the current hobo.bindle.json, then `hobo up`.",
			);
		if (built.bindle !== bindleName)
			return refusal(
				DELIVERY_REFUSAL.freightForeign,
				`${FREIGHT_FILE} names Bindle ${built.bindle}; this project is ${bindleName}`,
				"Run `hobo build` in this project so its Freight names this Bindle.",
			);
		for (const artifact of built.artifacts)
			if (
				!isDigest(artifact.digest) ||
				!(await cd.artifacts.has(artifact.digest))
			)
				return refusal(
					DELIVERY_REFUSAL.artifactMissing,
					`artifact ${artifact.name} (${artifact.digest}) is not in the ${cd.artifacts.backend} artifact store`,
					"Run `hobo build` against the configured artifact store, then `hobo up`.",
				);
		return built;
	}

	async function recordLocal(
		bindle: ManifestV1,
		bindleName: string,
		options: DeliverOptions,
		ctx: CdContext,
	): Promise<FreightRecord | Refused> {
		const declarationHash = canonicalManifestHash(bindle);
		const labels: Record<string, string> = options.anonymous
			? { [ANONYMOUS_LABEL]: "true" }
			: {};
		let manifest: FreightManifestRecord;
		if (options.freightManifest) {
			const built = await parseBuiltFreight(
				options.freightManifest,
				bindleName,
				declarationHash,
			);
			if ("refused" in built) return built;
			manifest = create(FreightManifestRecordSchema, {
				...built,
				labels: { ...built.labels, ...labels },
			});
		} else {
			manifest = create(FreightManifestRecordSchema, {
				schemaVersion: FREIGHT_MANIFEST_SCHEMA,
				bindle: bindleName,
				declarationHash,
				artifacts: [],
				labels,
			});
		}
		// The declaration is stored under its own hash so promotion can resolve
		// the Freight on any Camp, including `--to` an earlier revision.
		const stored = await cd.artifacts.put(
			encoder.encode(serializeManifest(bindle)),
			{
				name: DECLARATION_ARTIFACT,
				kind: ArtifactKind.SOURCE_TREE,
				mediaType: DECLARATION_MEDIA_TYPE,
			},
			ctx,
		);
		if (stored.digest !== declarationHash)
			return refusal(
				DELIVERY_REFUSAL.declarationMismatch,
				`the artifact store addressed the declaration as ${stored.digest}, expected ${declarationHash}`,
				"Configure an artifact store that addresses bytes by their sha256 digest.",
			);
		const recorded = await cd.freight.record(
			{ manifest, origin: FreightOrigin.LOCAL_BUILD },
			ctx,
		);
		if (!recorded.ok)
			return refusal(
				DELIVERY_REFUSAL.freightRefused,
				"the Freight ledger refused the LOCAL_BUILD Freight",
				recorded.reasons[0]?.remediation ??
					"Fix the reasons listed, then rerun `hobo up`.",
				recorded.reasons,
			);
		return recorded.value;
	}

	async function selectFreight(
		to: string,
		bindleName: string,
	): Promise<FreightRecord | Refused> {
		const byId = isDigest(to)
			? await cd.freight.get(freightIdOf(to))
			: undefined;
		const found = byId ?? (await cd.freight.getByAlias(to));
		if (!found)
			return refusal(
				DELIVERY_REFUSAL.freightUnknown,
				`no recorded Freight has id or alias ${to}`,
				"List recorded Freight with `hobo deploy freight list` and pass its id or alias to `--to`.",
			);
		if (found.manifest?.bindle !== bindleName)
			return refusal(
				DELIVERY_REFUSAL.freightForeign,
				`Freight ${found.alias} belongs to Bindle ${found.manifest?.bindle ?? ""}, not ${bindleName}`,
				"Pass a revision recorded for this project (`hobo deploy freight list`).",
			);
		return found;
	}

	async function converge(input: {
		campId: CampId;
		baseSetId: string | undefined;
		promotionId: PromotionId | undefined;
		reconciler: CampReconciler;
		ctx: CdContext;
		emit: (event: ProgressEvent) => void;
	}): Promise<Converged> {
		const { campId, ctx, emit } = input;
		let announced = input.baseSetId;
		let lastStatus: ReconcileStatus | undefined;
		let set: SetRecord | undefined;
		let observation: ReconcileObservationRecord | undefined;
		let promotion: PromotionRecord | undefined;
		for (let pass = 1; pass <= maxPasses; pass += 1) {
			await cd.promotions.tick(ctx);
			promotion = input.promotionId
				? await cd.promotions.get(input.promotionId)
				: undefined;
			if (promotion && FAILED_PROMOTION.has(promotion.state))
				return { passes: pass, failed: promotion };
			set = await cd.desired.current(campId);
			if (set && set.setId !== announced) {
				announced = set.setId;
				emit({
					type: "set.Created",
					detail: `${set.setId} (Freight ${set.freightId}, origin ${SetOrigin[set.origin]})`,
				});
			}
			const applied =
				input.promotionId === undefined ||
				(set !== undefined && set.setId !== input.baseSetId);
			if (!applied) {
				if (promotion && HELD_PROMOTION.has(promotion.state))
					return { passes: pass, held: promotion, promotion };
				continue;
			}
			observation = await input.reconciler.reconcileOnce(campId, ctx);
			if (observation.status !== lastStatus) {
				lastStatus = observation.status;
				emit({
					type: STATUS_EVENT[observation.status],
					detail:
						observation.reasons.length > 0
							? observation.reasons
									.map((item) => `${item.code}: ${item.message}`)
									.join("; ")
							: `${ReconcileStatus[observation.status]} ${observation.setId}`,
				});
			}
			if (
				set &&
				observation.setId === set.setId &&
				(observation.status === ReconcileStatus.CONVERGED ||
					observation.status === ReconcileStatus.BLOCKED)
			)
				return { passes: pass, set, observation, promotion };
		}
		return { passes: maxPasses, set, observation, promotion };
	}

	async function planOf(set: SetRecord): Promise<DeploymentPlan> {
		return (await cd.desired.resolved(set)).plan;
	}

	function reconcilerFor(campId: CampId, deploymentId: string): CampReconciler {
		return cd.createReconciler({
			mode: ReconcilerMode.CONDUCTOR,
			reconcilerId: reconcilerIdOf(`hobo-up.${deploymentId}`),
			campIds: [campId],
			holderId: `hobo-up.${process.pid}`,
		});
	}

	function modeOf(options: DeliverOptions): DeliveryMode {
		if (options.rollback) return "rollback";
		if (options.to !== undefined) return "to";
		return options.anonymous ? "anonymous" : "up";
	}

	function statusOf(
		set: SetRecord,
		observation: ReconcileObservationRecord,
	): UpRealized["status"] {
		if (observation.setId !== set.setId) return "waiting";
		if (observation.status === ReconcileStatus.CONVERGED) return "deployed";
		if (observation.status === ReconcileStatus.BLOCKED) return "needs-human";
		return "waiting";
	}

	return {
		async up(bindle, options) {
			const startedMs = now();
			const { deploymentId, session } = options;
			const campId = campIdOf(campFor(deploymentId));
			const ctx = contextFor(session);
			const progress: ProgressEvent[] = [];
			const emit = (event: ProgressEvent) => {
				progress.push(event);
				options.onProgress?.(event);
			};
			const mode = modeOf(options);
			const finish = async (
				result: UpResult,
				receipt: Omit<DeliveryReceipt, "campId" | "mode">,
			): Promise<DriverUp> => {
				await emitMetrics(
					"up",
					result.status === "rejected"
						? `rejected:${receipt.refusal ?? "plan"}`
						: result.status,
					receipt.passes,
					startedMs,
					emit,
				);
				return { result, receipt: { campId, mode, ...receipt } };
			};
			const refuse = (refused: Refused, passes = 0) =>
				finish(refusedResult(deploymentId, refused), {
					passes,
					refusal: refused.code,
				});

			const before = await cd.desired.current(campId);
			const baseline = resourceNames(await cd.desired.status(campId));
			let freight: FreightRecord | undefined;
			let promotionId: PromotionId | undefined;
			if (mode === "rollback") {
				if (
					!before ||
					before.predecessorSetId === "" ||
					before.origin === SetOrigin.TEARDOWN
				)
					return refuse(
						refusal(
							DELIVERY_REFUSAL.rollbackUnavailable,
							`Camp ${campId} has no deployed predecessor Set to roll back to`,
							"Deploy at least two revisions with `hobo up` first, or pin one with `hobo up --to <freight|alias>`.",
						),
					);
				const rolled = await cd.promotions.rollback(
					{
						campId,
						reason: "hobo up --rollback",
						idempotencyKey: `up-rollback|${campId}|${before.setId}`,
					},
					ctx,
				);
				if (!rolled.ok)
					return refuse(
						refusal(
							DELIVERY_REFUSAL.promotionRefused,
							`rollback of Camp ${campId} was refused`,
							rolled.reasons[0]?.remediation ??
								"Fix the reasons listed, then rerun `hobo up --rollback`.",
							rolled.reasons,
						),
					);
				promotionId = promotionIdOf(rolled.value.promotionId);
				emit({
					type: "env.PromoteRequested",
					detail: `rollback ${promotionId} of Camp ${campId}`,
				});
			} else {
				const bindleName = deploymentId;
				const selected =
					options.to !== undefined
						? await selectFreight(options.to, bindleName)
						: await recordLocal(bindle, bindleName, options, ctx);
				if ("refused" in selected) return refuse(selected);
				freight = selected;
				emit({
					type: "freight.Recorded",
					detail: `${freight.freightId} (${freight.alias}) ${FreightOrigin[freight.origin]}`,
				});
				// Re-running `up` on an estate already declaring this Freight only
				// converges: no new promotion, Set or Freight (idempotent).
				const alreadyDesired =
					before !== undefined &&
					before.freightId === freight.freightId &&
					before.origin !== SetOrigin.TEARDOWN;
				if (!alreadyDesired) {
					const promoted = await cd.promotions.promote(
						{
							freightId: freightIdOf(freight.freightId),
							targets: [campId],
							idempotencyKey: `up|${campId}|${freight.freightId}|${before?.setId ?? "genesis"}`,
							intent: "up",
						},
						ctx,
					);
					if (!promoted.ok)
						return refuse(
							refusal(
								DELIVERY_REFUSAL.promotionRefused,
								`promotion of ${freight.alias} into Camp ${campId} was refused`,
								promoted.reasons[0]?.remediation ??
									"Fix the reasons listed, then rerun `hobo up`.",
								promoted.reasons,
							),
						);
					promotionId = promotionIdOf(promoted.value.promotionId);
					emit({
						type: "env.PromoteRequested",
						detail: `${promotionId} ${PromotionState[promoted.value.state]}`,
					});
				}
			}

			const outcome = await converge({
				campId,
				baseSetId: before?.setId,
				promotionId,
				reconciler: reconcilerFor(campId, deploymentId),
				ctx,
				emit,
			});
			if (outcome.failed)
				return refuse(
					refusal(
						DELIVERY_REFUSAL.promotionRefused,
						`promotion ${outcome.failed.promotionId} ended ${PromotionState[outcome.failed.state]}`,
						outcome.failed.reasons[0]?.remediation ??
							"Inspect it with `hobo deploy status`, fix the cause, then rerun `hobo up`.",
						outcome.failed.reasons,
					),
					outcome.passes,
				);
			if (outcome.held || !outcome.set || !outcome.observation) {
				const state =
					outcome.held?.state ??
					outcome.promotion?.state ??
					PromotionState.QUEUED;
				return refuse(
					refusal(
						DELIVERY_REFUSAL.promotionHeld,
						`promotion ${promotionId ?? ""} has not applied (${PromotionState[state]})`,
						"Approve it or wait for the change window (`hobo deploy status` shows it), then rerun `hobo up`.",
						outcome.held?.reasons ?? [],
					),
					outcome.passes,
				);
			}
			const { set, observation } = outcome;
			const provisioned = resourceNames(observation);
			for (const name of provisioned)
				if (!baseline.includes(name))
					emit({
						type: "resource.Provisioned",
						resourceId: name,
						detail: `converged in Camp ${campId}`,
					});
			const selectedFreight =
				freight ?? (await cd.freight.get(freightIdOf(set.freightId)));
			return finish(
				{
					status: statusOf(set, observation),
					deploymentId,
					planHash: set.planHash,
					plan: await planOf(set),
					provisioned,
					progress,
				},
				{
					passes: outcome.passes,
					promotionId,
					freightId: set.freightId,
					alias: selectedFreight?.alias,
					setId: set.setId,
					claimHint: mode === "anonymous" ? ANONYMOUS_CLAIM_HINT : undefined,
				},
			);
		},

		async down({ deploymentId, session, onProgress }) {
			const startedMs = now();
			const campId = campIdOf(campFor(deploymentId));
			const ctx = contextFor(session);
			const progress: ProgressEvent[] = [];
			const emit = (event: ProgressEvent) => {
				progress.push(event);
				onProgress?.(event);
			};
			const finish = async (
				result: DownResult,
				receipt: Omit<DeliveryReceipt, "campId" | "mode">,
			): Promise<DriverDown> => {
				await emitMetrics(
					"down",
					result.status,
					receipt.passes,
					startedMs,
					emit,
				);
				return { result, receipt: { campId, mode: "down", ...receipt } };
			};
			const before = await cd.desired.current(campId);
			const status = await cd.desired.status(campId);
			const nothing = (): DownResult => ({
				status: "destroyed",
				deploymentId,
				destroyed: [],
				progress,
			});
			if (!before) return finish(nothing(), { passes: 0 });
			const tornDown = before.origin === SetOrigin.TEARDOWN;
			if (
				tornDown &&
				status?.setId === before.setId &&
				status.status === ReconcileStatus.CONVERGED
			)
				return finish(nothing(), { passes: 0, setId: before.setId });

			const baseline = resourceNames(status);
			// Dependents tear down before their dependencies.
			const order = tornDown
				? baseline
				: [...(await planOf(before)).dependencyOrder].reverse();
			let promotionId: PromotionId | undefined;
			if (!tornDown) {
				const promoted = await cd.promotions.promote(
					{
						freightId: freightIdOf(before.freightId),
						targets: [campId],
						idempotencyKey: `down|${campId}|${before.setId}`,
						intent: "down",
					},
					ctx,
				);
				if (!promoted.ok) {
					for (const item of promoted.reasons)
						emit({
							type: "env.PromoteRejected",
							detail: `${item.code}: ${item.message} (${item.remediation})`,
						});
					return finish(
						{ status: "needs-human", deploymentId, destroyed: [], progress },
						{ passes: 0, refusal: DELIVERY_REFUSAL.promotionRefused },
					);
				}
				promotionId = promotionIdOf(promoted.value.promotionId);
				emit({
					type: "env.PromoteRequested",
					detail: `teardown ${promotionId} of Camp ${campId}`,
				});
			}
			const outcome = await converge({
				campId,
				baseSetId: promotionId ? before.setId : undefined,
				promotionId,
				reconciler: reconcilerFor(campId, deploymentId),
				ctx,
				emit,
			});
			const converged =
				outcome.set !== undefined &&
				outcome.set.origin === SetOrigin.TEARDOWN &&
				outcome.observation?.setId === outcome.set.setId &&
				outcome.observation.status === ReconcileStatus.CONVERGED;
			const remaining = new Set(resourceNames(outcome.observation));
			const gone = new Set(
				converged ? baseline.filter((name) => !remaining.has(name)) : [],
			);
			const destroyed = [
				...order.filter((name) => gone.has(name)),
				...[...gone].filter((name) => !order.includes(name)).sort(),
			];
			for (const name of destroyed)
				emit({
					type: "resource.Destroyed",
					resourceId: name,
					detail: `removed from Camp ${campId}`,
				});
			const refused = outcome.failed ?? outcome.held;
			return finish(
				{
					status: converged ? "destroyed" : "needs-human",
					deploymentId,
					destroyed,
					progress,
				},
				{
					passes: outcome.passes,
					promotionId,
					freightId: before.freightId,
					setId: outcome.set?.setId,
					refusal: refused ? DELIVERY_REFUSAL.promotionRefused : undefined,
				},
			);
		},
	};
}

// Brands are minted only from ids the CD ports returned or the caller named.
function campIdOf(value: string): CampId {
	// SAFETY: a Camp id is an opaque string; the brand marks where it came from.
	return value as CampId;
}

function freightIdOf(value: string): FreightId {
	// SAFETY: Freight ids come from the ledger or a `--to` the ledger then resolves.
	return value as FreightId;
}

function promotionIdOf(value: string): PromotionId {
	// SAFETY: promotion ids come from the PromotionService's own records.
	return value as PromotionId;
}

function reconcilerIdOf(value: string): ReconcilerId {
	// SAFETY: the conductor id is deterministic per deployment.
	return value as ReconcilerId;
}
