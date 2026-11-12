// `wireContinuousDelivery` — the pure composition of @hobo/cd (WP18, plan
// 0024, C2). It binds every frozen factory (`CdFactories`) in dependency
// order and returns the `ContinuousDelivery` facade. Nothing here decides
// delivery; every decision stays in the module that owns it.
//
// Cycles in the frozen signatures (pipelines ⇄ promotions, fan-out →
// promotions) are closed with late-bound references (late.ts). Adapters the
// host owns (gate, Matching resolver, ramp engine, traffic, realizers, drift
// policy, approvals, hooks, policy packs) are builders over a `CdComposeScope`
// so they can read the modules built before them.

import { create } from "@bufbuild/protobuf";
import type { PolicyPack } from "@hobo/contracts";
import type { HttpTransport, JsonObject } from "@hobo/core";
import {
	ReconcilerMode,
	type RetentionPolicyRecord,
	RetentionPolicyRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type {
	ApprovalPort,
	ArtifactStore,
	ArtifactStoreConfig,
	CampId,
	CampInventory,
	CampPolicy,
	CampReconciler,
	CdAuthorizer,
	CdBase,
	CdFactories,
	ChangeWindows,
	CiArtifactReader,
	CiEventReader,
	ContinuousDelivery,
	CredentialResolver,
	DeltaLedger,
	DeployGate,
	DesiredStateReader,
	Digest,
	DriftPolicy,
	FanoutController,
	FreightLedger,
	NotificationPort,
	PipelineController,
	PlacementEngine,
	PostureSeriesReader,
	PostureService,
	PreviewEnvironments,
	PromotionService,
	RailDeliveryReader,
	RailEventReader,
	Realizer,
	ReconcilerId,
	ReconcilerTransport,
	RolloutEngine,
	RunbookExecutor,
	SetResolver,
	ShadowRecorder,
	TelemetrySink,
	TopologyReader,
	TrafficShifter,
	VerificationEngine,
	VerifyPort,
} from "../ports.js";
import { ComposeError } from "./errors.js";
import {
	unconfiguredRunbooks,
	unconfiguredSuites,
	unconfiguredTraffic,
	unroutedNotifications,
} from "./fail-closed.js";
import { lateBound } from "./late.js";
import { createRailDeliveryReader, type RailCatalog } from "./rails.js";

// public-contract: metric names the composition root emits.
export const COMPOSE_METRICS = Object.freeze({
	modules: "hobo.cd.compose.modules",
	reconcilers: "hobo.cd.compose.reconcilers",
	failures: "hobo.cd.compose.failures",
});

/** Modules adapter builders may read. Reading one not yet built throws `compose-scope-unbuilt`. */
export type CdComposeScope = Readonly<{
	base: CdBase;
	telemetry: TelemetrySink;
	authorizer: CdAuthorizer;
	artifacts: ArtifactStore;
	freight: FreightLedger;
	desired: DesiredStateReader & DeltaLedger;
	windows: ChangeWindows;
	campPolicy: CampPolicy;
	rails: RailDeliveryReader;
	topology: TopologyReader;
	inventory: CampInventory;
	placement: PlacementEngine;
	posture: PostureService & PostureSeriesReader;
	shadow: ShadowRecorder;
	verification: VerificationEngine;
	fanout: FanoutController;
	pipelines: PipelineController;
	promotions: PromotionService & PreviewEnvironments;
	notify: NotificationPort;
}>;

type Builder<T> = (scope: CdComposeScope) => T;

/** Host-owned adapters. Optional ones fall back to fail-closed adapters (fail-closed.ts). */
export type CdComposeAdapters = Readonly<{
	gate: Builder<DeployGate>;
	resolver: Builder<SetResolver>;
	approvals: Builder<ApprovalPort>;
	rolloutEngine: Builder<RolloutEngine>;
	drift: Builder<DriftPolicy>;
	/** Realizer per reconciler mode; undefined refuses that mode (`compose-realizer-missing`). */
	realizer: (
		mode: ReconcilerMode,
		scope: CdComposeScope,
	) => Realizer | undefined;
	/** Policy pack of a Rail digest (shadow evaluation). */
	resolvePack: (railDigest: Digest) => Promise<PolicyPack>;
	/** Posture packs by name, as policy-IR documents. */
	packs: (names: readonly string[]) => Promise<readonly JsonObject[]>;
	traffic?: Builder<TrafficShifter>;
	runbooks?: Builder<RunbookExecutor>;
	suites?: Builder<VerifyPort>;
	notify?: Builder<NotificationPort>;
}>;

export type CdComposeInput = Readonly<{
	base: CdBase;
	factories: CdFactories;
	adapters: CdComposeAdapters;
	http: HttpTransport;
	credentials: CredentialResolver;
	/** Webhook HMAC secrets for nudges; defaults to `credentials`. */
	webhookSecrets?: CredentialResolver;
	artifactStore: ArtifactStoreConfig;
	/** Provenance trust policy (builder ids, signer identities, Sigstore roots). */
	trustPolicy: JsonObject;
	/** The delivery authorization pack (D15). */
	policyPack: PolicyPack;
	topology: TopologyReader;
	railCatalog: RailCatalog;
	/** CI bridge: HOBO_CI subscriptions read these (C15). */
	readCiEvents?: CiEventReader;
	readCiArtifact?: CiArtifactReader;
	readRailEvents?: RailEventReader;
	/** Telemetry sink; defaults to the factory sink over `telemetryEndpoint`. */
	telemetry?: TelemetrySink;
	telemetryEndpoint?: string;
	telemetryHeaders?: Readonly<Record<string, string>>;
}>;

export type ComposedContinuousDelivery = ContinuousDelivery &
	Readonly<{
		sink: TelemetrySink;
		topology: TopologyReader;
		rails: RailDeliveryReader;
		shadow: ShadowRecorder;
		postureSeries: PostureSeriesReader;
		scope: CdComposeScope;
	}>;

const MODE_NAMES: ReadonlyMap<ReconcilerMode, string> = new Map([
	[ReconcilerMode.CONDUCTOR, "conductor"],
	[ReconcilerMode.AGENT, "agent"],
	[ReconcilerMode.PUBLISHER, "publisher"],
]);

export function reconcilerModeName(mode: ReconcilerMode): string {
	return MODE_NAMES.get(mode) ?? "unspecified";
}

function scopeOver(
	built: Partial<Record<keyof CdComposeScope, unknown>>,
): CdComposeScope {
	return new Proxy(built, {
		get(target, property) {
			if (typeof property !== "string") return undefined;
			if (!(property in target)) {
				throw new ComposeError(
					"compose-scope-unbuilt",
					`adapter read scope.${property} before it was built`,
					property,
				);
			}
			return Reflect.get(target, property);
		},
	}) as unknown as CdComposeScope;
}

export function wireContinuousDelivery(
	input: CdComposeInput,
): ComposedContinuousDelivery {
	const { base, factories: f, adapters: a } = input;
	const built: Partial<Record<keyof CdComposeScope, unknown>> = {};
	const scope = scopeOver(built);
	const put = <K extends keyof CdComposeScope>(
		key: K,
		value: CdComposeScope[K],
	): CdComposeScope[K] => {
		built[key] = value;
		return value;
	};
	put("base", base);
	put("topology", input.topology);

	const sink = put(
		"telemetry",
		input.telemetry ??
			f.createTelemetrySink({
				http: input.http,
				...(input.telemetryEndpoint !== undefined
					? { endpoint: input.telemetryEndpoint }
					: undefined),
				...(input.telemetryHeaders !== undefined
					? { headers: input.telemetryHeaders }
					: undefined),
			}),
	);
	const authorizer = put(
		"authorizer",
		f.createCdAuthorizer({ ...base, policyPack: input.policyPack }),
	);

	// Freight, ingestion, sources, artifacts (WP1–WP3).
	const artifacts = put(
		"artifacts",
		f.createArtifactStore(input.artifactStore, base),
	);
	const artifactVerifier = f.createArtifactVerifier({
		...base,
		artifacts,
		http: input.http,
	});
	const freight = put(
		"freight",
		f.createFreightLedger({
			...base,
			artifacts: artifactVerifier,
			telemetry: sink,
		}),
	);
	const publishers = f.createTrustedPublisherVerifier({
		...base,
		http: input.http,
	});
	const provenance = f.createProvenanceVerifier({
		...base,
		http: input.http,
		trustPolicy: input.trustPolicy,
	});
	const drivers = f.createSubscriptionDrivers({
		http: input.http,
		credentials: input.credentials,
		...(input.readCiEvents ? { readCiEvents: input.readCiEvents } : undefined),
		...(input.readCiArtifact
			? { readCiArtifact: input.readCiArtifact }
			: undefined),
		...(input.readRailEvents
			? { readRailEvents: input.readRailEvents }
			: undefined),
	});
	const sources = f.createFreightSources({
		...base,
		ledger: freight,
		drivers,
		provenance,
		authorizer,
		webhookSecrets: input.webhookSecrets ?? input.credentials,
	});
	const ingest = f.createFreightIngest({
		...base,
		ledger: freight,
		publishers,
		provenance,
		sources,
		authorizer,
	});

	// Desired state, windows, Camp policy, inventory, placement (WP4/5/22/24).
	const desired = put("desired", f.createDesiredState({ ...base, artifacts }));
	const windows = put(
		"windows",
		f.createChangeWindows({ ...base, authorizer }),
	);
	const campPolicy = put(
		"campPolicy",
		f.createCampPolicy({ ...base, authorizer }),
	);
	const rails = put(
		"rails",
		createRailDeliveryReader({
			catalog: input.railCatalog,
			campPolicy,
			topology: input.topology,
			telemetry: sink,
			now: base.now,
		}),
	);
	const inventory = put(
		"inventory",
		f.createCampInventory({
			...base,
			topology: input.topology,
			rails,
			desired,
			authorizer,
			telemetry: sink,
		}),
	);
	const placement = put(
		"placement",
		f.createPlacementEngine({ ...base, inventory, rails, authorizer }),
	);
	const posture = put(
		"posture",
		f.createPostureService({
			...base,
			desired,
			campPolicy,
			rails,
			inventory,
			packs: a.packs,
			authorizer,
			telemetry: sink,
		}),
	);
	const shadow = put(
		"shadow",
		f.createShadowRecorder({ ...base, campPolicy, resolvePack: a.resolvePack }),
	);

	// Verification (WP9). Posture series feed INFORM-node verification (D24).
	const suites = a.suites?.(scope) ?? unconfiguredSuites({ telemetry: sink });
	const healthSources = f.createHealthSources({
		http: input.http,
		credentials: input.credentials,
		posture,
	});
	const verification = put(
		"verification",
		f.createVerificationEngine({
			...base,
			sources: healthSources,
			suites,
			http: input.http,
		}),
	);

	// The cycle: pipelines ⇄ promotions, fan-out → promotions.
	const lateFanout = lateBound<FanoutController>("fanout");
	const latePromotions = lateBound<PromotionService & PreviewEnvironments>(
		"promotions",
	);
	const notify = put(
		"notify",
		a.notify?.(scope) ?? unroutedNotifications({ telemetry: sink }),
	);
	const approvals = a.approvals(scope);
	const traffic =
		a.traffic?.(scope) ?? unconfiguredTraffic({ telemetry: sink });
	const rollouts = f.createRolloutOrchestrator({
		...base,
		engine: a.rolloutEngine(scope),
		traffic,
		verification,
		windows,
		desired,
		approvals,
		telemetry: sink,
	});
	const pipelines = put(
		"pipelines",
		f.createPipelineController({
			...base,
			freight,
			promotions: latePromotions.ref,
			placement,
			fanout: lateFanout.ref,
			topology: input.topology,
			authorizer,
		}),
	);
	const fanout = put(
		"fanout",
		f.createFanoutController({
			...base,
			freight,
			promotions: latePromotions.ref,
			inventory,
			desired,
			windows,
			authorizer,
			telemetry: sink,
		}),
	);
	lateFanout.bind(fanout);
	const promotions = put(
		"promotions",
		f.createPromotionService({
			...base,
			freight,
			pipelines,
			desired,
			resolver: a.resolver(scope),
			gate: a.gate(scope),
			approvals,
			rollouts,
			verification,
			runbooks:
				a.runbooks?.(scope) ?? unconfiguredRunbooks({ telemetry: sink }),
			suites,
			notify,
			campPolicy,
			authorizer,
			telemetry: sink,
		}),
	);
	latePromotions.bind(promotions);

	const failover = f.createFailoverController({
		...base,
		pipelines,
		inventory,
		placement,
		fanout,
		promotions,
		desired,
		topology: input.topology,
		rails,
		traffic,
		authorizer,
		telemetry: sink,
	});

	// Agents and the feed (WP11), telemetry read side (WP19).
	const enrollment = f.createAgentEnrollment({
		...base,
		authorizer,
		rails,
		inventory,
	});
	const feed = f.createDeliveryFeedHandler({
		...base,
		desired,
		enrollment,
		artifacts,
		posture,
		inventory,
		topology: input.topology,
	});
	const telemetry = f.createCdTelemetry(base);
	const drift = a.drift(scope);

	function createReconciler(
		r: Parameters<ContinuousDelivery["createReconciler"]>[0],
	): CampReconciler {
		const realizer = a.realizer(r.mode, scope);
		if (realizer === undefined) {
			sink
				.metrics([
					{
						name: COMPOSE_METRICS.failures,
						kind: "counter",
						value: 1,
						unit: "1",
						atMs: base.now(),
						attributes: {
							"hobo.cd.compose.code": "compose-realizer-missing",
							"hobo.cd.reconciler.mode": reconcilerModeName(r.mode),
						},
					},
				])
				.catch(() => {
					// Best-effort.
				});
			throw new ComposeError(
				"compose-realizer-missing",
				`no realizer for ${reconcilerModeName(r.mode)} reconciler ${r.reconcilerId}`,
				r.reconcilerId,
			);
		}
		const transport: ReconcilerTransport =
			r.transport ??
			f.createInProcessTransport({
				...base,
				desired,
				posture,
				topology: input.topology,
			});
		return f.createCampReconciler({
			...base,
			reconcilerId: r.reconcilerId,
			mode: r.mode,
			campIds: r.campIds,
			holderId: r.holderId,
			transport,
			realizer,
			drift,
			telemetry: sink,
		});
	}

	sink
		.metrics([
			{
				name: COMPOSE_METRICS.modules,
				kind: "gauge",
				value: Object.keys(built).length,
				unit: "1",
				atMs: base.now(),
				attributes: { "hobo.tenant": base.tenant },
			},
		])
		.catch(() => {
			// Best-effort.
		});

	return Object.freeze({
		freight,
		ingest,
		publishers,
		sources,
		artifacts,
		desired,
		deltas: desired,
		pipelines,
		windows,
		promotions,
		rollouts,
		verification,
		enrollment,
		feed,
		telemetry,
		authorizer,
		inventory,
		placement,
		fanout,
		failover,
		campPolicy,
		posture,
		createReconciler,
		sink,
		topology: input.topology,
		rails,
		shadow,
		postureSeries: posture,
		scope,
	});
}

/** One conductor reconciler per Camp list: the in-process path `hobo up` and `hobo serve cd` use. */
export function conductorFor(
	cd: ContinuousDelivery,
	input: Readonly<{
		campIds: readonly CampId[];
		holderId: string;
		reconcilerId?: ReconcilerId;
	}>,
): CampReconciler {
	return cd.createReconciler({
		mode: ReconcilerMode.CONDUCTOR,
		// SAFETY: a conductor's id is derived from its holder; it is never enrolled.
		reconcilerId:
			input.reconcilerId ?? (`conductor:${input.holderId}` as ReconcilerId),
		campIds: input.campIds,
		holderId: input.holderId,
	});
}

/** The default retention policy (D18): CD_DEFAULTS applied to every Bindle (empty bindle). */
export function defaultRetention(bindle = ""): RetentionPolicyRecord {
	return create(RetentionPolicyRecordSchema, {
		bindle,
		keepPerCamp: CD_DEFAULTS.retentionKeepPerCamp,
		keepUnpromotedMs: BigInt(CD_DEFAULTS.retentionKeepUnpromotedMs),
		blobGraceMs: BigInt(CD_DEFAULTS.retentionBlobGraceMs),
		legalHoldLabels: [],
	});
}
