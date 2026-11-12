// HoBo delivering its own CI relay through `@hobo/cd` (plan 0024; ADR-0179
// phase 6).
//
// `hobo ci deploy` is a thin front over this module: the relay build is
// recorded as Freight, promoted through the relay's pipeline (preview, then
// production, which takes only Freight preview qualified) and the CD gate,
// and realized by a conductor reconciler whose realizer is the Vercel git
// deployment of the commit the Freight pins. Verification is the pipeline
// node's HTTP probes of `/healthz` and `/readyz`, failing closed on no data;
// PASS is the only qualification.
//
// What the Freight holds: the relay Bindle (`hobo-ci-relay`), the canonical
// declaration stored under its own hash, and a source pin (repository, ref,
// commit) stored in the CD artifact store, so two commits are two Freight and
// production deploys exactly the commit preview qualified. Provenance: the CI
// run that recorded it (`GITHUB_RUN_ID`, `GITHUB_WORKFLOW_REF`) when present;
// no signed attestation is recorded (Vercel builds from git, so there is no
// built artifact to attest yet).
//
// The records it applies are delivery-as-code beside the relay's Yard
// (`packages/ci-vercel/deploy/delivery.ts`); `hobo deploy pipeline apply
// --file` applies the same file.
//
// Matching: no provider package resolves the relay's queues, schedule, cache
// or config service yet (yard.ts says so). The planner registry here is the
// relay Yard's own declared catalog: a provider `yard:<name>` advertising the
// ports the Yard's binding rows cover, realized only by the relay's git
// deployment (`vercel.json` declares the queues and the schedule; the
// Marketplace attaches the cache). A Yard on any other provider is refused
// before this module runs.
//
// Journal: the shared CD journal `hobo deploy` and `hobo serve cd` use
// (`<HOBO_HOME>/cd/journal.sqlite`, or the store HOBO_CD_SQLITE_PATH /
// HOBO_CD_POSTGRES_URL name). @hobo/cd stores its rollout ledger under the
// `rollout.*` family a durable journal accepts and folds the reconcile
// transport's `{ schema, observation }` status envelope itself, so the relay's
// promotions are ordinary CD records any CD tool reads.
//
// Composition: this is `composeContinuousDelivery` with the same factories,
// adapters, store and artifact selection as `openCdRuntime`, with two host
// inputs that runtime does not take today: the planning declaration digest
// (`canonicalManifestHash`, the digest the Freight names) and the relay's
// Yard-declared registry.

import { create, toJson } from "@bufbuild/protobuf";
import {
	canonicalManifestHash,
	type ManifestV1,
	parseManifest,
	serializeManifest,
} from "@hobo/bindles";
import {
	ArtifactKind,
	type CampId,
	type CdContext,
	type FreightId,
	FreightManifestRecordSchema,
	FreightOrigin,
	type FreightRecord,
	type PromotionId,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
	type Realizer,
	type ReasonRecord,
	ReasonRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	type ReconcilerId,
	ReconcileStatus,
	type SetRecord,
	type TelemetrySink,
} from "@hobo/cd";
import { createCdBaselinePack } from "@hobo/cd/authz";
import {
	composeContinuousDelivery,
	conductorFor,
	createJournalRailCatalog,
	createJournalRailEventReader,
	defaultCdAdapters,
	defaultCdFactories,
	HOBO_CI_COMPONENTS,
	parseCdComposeConfig,
} from "@hobo/cd/compose";
import {
	createRegistryFromProviders,
	type RegistrableProvider,
} from "@hobo/cloud";
import {
	capability,
	createBoundedFetchTransport,
	type HttpTransport,
} from "@hobo/core";
import type { Yard } from "@hobo/yards";
import { type DeliveryModule, loadDeliveryFile } from "./cd-delivery-module.js";
import { cdPrincipal, envCredentials } from "./cd-runtime.js";
import { type CdStoreOpener, openCdStore } from "./cd-store.js";
import { campIdOf, staticTopologyReader, yardTopology } from "./cd-topology.js";
import {
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "./json.js";

// public-contract: the relay's delivery-as-code file, relative to its project.
export const RELAY_DELIVERY_FILE = "deploy/delivery.ts";

// public-contract: the artifact names of the relay's Freight.
export const RELAY_FREIGHT_ARTIFACTS = Object.freeze({
	declaration: "declaration",
	source: "relay/source",
} as const);

// public-contract: media type of the relay's source pin artifact.
export const RELAY_SOURCE_MEDIA_TYPE =
	"application/vnd.hobo.relay-source+json" as const;

const DECLARATION_MEDIA_TYPE = "application/vnd.hobo.bindle+json";
const FREIGHT_MANIFEST_SCHEMA = "hobo.freight-manifest/v1";

// public-contract: typed refusals of the relay's delivery, beside CD's own
// reason codes (which travel in `reasons`).
export const RELAY_DELIVERY_REFUSAL = Object.freeze({
	unavailable: "HOBO_CI_DEPLOY_DELIVERY_UNAVAILABLE",
	recordsInvalid: "HOBO_CI_DEPLOY_DELIVERY_INVALID",
	freightRefused: "HOBO_CI_DEPLOY_FREIGHT_REFUSED",
	notQualified: "HOBO_CI_DEPLOY_NOT_QUALIFIED",
	promotionRefused: "HOBO_CI_DEPLOY_PROMOTION_REFUSED",
	verificationFailed: "HOBO_CI_DEPLOY_VERIFICATION_FAILED",
	incomplete: "HOBO_CI_DEPLOY_INCOMPLETE",
} as const);

export type RelayTargetName = "preview" | "production";

/**
 * The commit a relay Freight pins. A pin without `sha` names a ref only; it is
 * accepted for preview, never for production (`hobo ci deploy` refuses).
 */
export type RelaySourcePin = Readonly<{
	repository: string;
	ref: string;
	sha?: string;
	rootDirectory?: string;
}>;

/** A failed realization: the command result the front returns verbatim. */
export type RelayRealizationFailure = Readonly<{
	ok: false;
	/** The command status (`usage`, `rejected`); absent for a failure. */
	status?: "usage" | "rejected";
	code: string;
	message: string;
	data?: Readonly<Record<string, string | number | boolean>>;
}>;

/** The Vercel side of the realizer, supplied by `ci-relay-deploy.ts`. */
export interface RelayRealization {
	/** Create the git deployment of the pinned commit; the provider's outputs. */
	deploy(
		source: RelaySourcePin,
	): Promise<
		| Readonly<{ ok: true; outputs: Readonly<Record<string, string>> }>
		| RelayRealizationFailure
	>;
	/** The deployment's Vercel ready state (READY, ERROR, CANCELED, BUILDING ...). */
	readyState(deploymentId: string): Promise<string>;
}

export type RelayDeliveryInput = Readonly<{
	/** The relay's project directory (holds `deploy/delivery.ts`). */
	cwd: string;
	env: Readonly<Record<string, string | undefined>>;
	/**
	 * HOBO_HOME. The relay's journal and artifact store are the shared CD
	 * ones under `<home>/cd`, unless the environment names another store.
	 */
	home: string;
	yard: Yard;
	declaration: ManifestV1;
	target: RelayTargetName;
	source: RelaySourcePin;
	realization: RelayRealization;
	/** Transport the verification probes use; bounded fetch when absent. */
	http?: HttpTransport;
	openStore?: CdStoreOpener;
	/** Delivery records; read from `deploy/delivery.ts` when absent. */
	records?: DeliveryModule;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** How long to drive the promotion before reporting it incomplete. */
	limitMs?: number;
	/** How often to drive it. */
	intervalMs?: number;
	/** How long one conductor pass waits for a desired-state change (real time). */
	feedWaitMs?: number;
	/**
	 * Default true: drive the promotion to its end (READY, verification,
	 * qualification). False: return once the conductor has created the
	 * deployment; the promotion stays in flight in the journal.
	 */
	wait?: boolean;
	emitProgress?: (message: string) => void;
}>;

export type RelayDeliveryReport = Readonly<{
	pipeline: string;
	node: RelayTargetName;
	campId: string;
	freightId: string;
	alias: string;
	promotionId?: string;
	state?: string;
	setId?: string;
	reasons: readonly Readonly<{ code: string; message: string }>[];
}>;

export type RelayDeliveryOutcome =
	| Readonly<{
			ok: true;
			report: RelayDeliveryReport;
			handover: Readonly<Record<string, string>>;
	  }>
	| Readonly<{
			ok: false;
			code: string;
			message: string;
			report?: RelayDeliveryReport;
			/** A realization failure, returned by the front as it always was. */
			realization?: RelayRealizationFailure;
			handover?: Readonly<Record<string, string>>;
	  }>;

const DEFAULT_LIMIT_MS = 20 * 60_000;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_FEED_WAIT_MS = 5_000;

const DISCARDING_TELEMETRY: TelemetrySink = Object.freeze({
	spans: async () => {},
	metrics: async () => {},
});

const TERMINAL = new Set<PromotionState>([
	PromotionState.PROMOTED,
	PromotionState.REJECTED,
	PromotionState.FAILED,
	PromotionState.ROLLED_BACK,
	PromotionState.SUPERSEDED,
]);

const HELD = new Set<PromotionState>([
	PromotionState.AWAITING_APPROVAL,
	PromotionState.AWAITING_WINDOW,
]);

function reasonsOf(
	reasons: readonly ReasonRecord[],
): readonly Readonly<{ code: string; message: string }>[] {
	return reasons.map((reason) => ({
		code: reason.code,
		message: reason.message,
	}));
}

function describeReasons(reasons: readonly ReasonRecord[]): string {
	return reasons
		.map((reason) => `${reason.code}: ${reason.message}`)
		.join("; ");
}

/**
 * The relay Yard's declared catalog as a planner provider: the ports its
 * binding rows cover, in its regions, and nothing else. Realized only by the
 * relay's git deployment.
 */
export function relayYardRegistryProvider(yard: Yard): RegistrableProvider {
	const productIds = [
		...new Set(
			yard.bindings
				.map((row) => row.productId)
				.filter((id): id is string => id !== undefined && id !== ""),
		),
	].sort();
	// An HTTP compute entry only when the Yard binds the HTTP API profile.
	const http = yard.bindings.some((row) => row.profile === capability.api.http);
	const ports = ["compute", "data"] as const;
	const none: readonly string[] = [];
	const offered = {
		compute: http ? ["http"] : none,
		data: none,
	} satisfies Record<(typeof ports)[number], readonly string[]>;
	return {
		id: `yard:${yard.name}`,
		regions: [...yard.regions],
		capabilities: ports.map((port) => ({
			port,
			satisfies(request) {
				if (request.port !== port) return { kind: "none" };
				const missing = (request.features ?? []).filter(
					(feature) => !offered[port].includes(feature),
				);
				return missing.length === 0
					? { kind: "full" }
					: { kind: "partial", missing };
			},
			estimateCost() {
				return {
					marginalPrice: "0",
					sku: `${yard.providerId}:${yard.name}`,
					unit: "deployment",
					pricingStatus: "unknown",
				};
			},
		})),
		capabilityManifest() {
			return {
				providerId: `yard:${yard.name}`,
				published: {},
				capabilities: {
					capabilities: ports.map((port) => ({
						port,
						features: [...offered[port]],
						productIds,
						realizedBy: "relay git deployment",
					})),
				},
				cost: { facts: [] },
			};
		},
	};
}

/** The Camp a target names in the relay's Yard, Yard-scoped. */
export function relayCampId(yard: Yard, target: RelayTargetName): CampId {
	const camp = yard.camps.find(
		(candidate) =>
			candidate.name === target ||
			candidate.id === target ||
			candidate.id.endsWith(`/${target}`),
	);
	return campIdOf(yard.name, camp?.id ?? target);
}

function observation(
	input: Readonly<{
		campId: CampId;
		set: SetRecord;
		reconcilerId: ReconcilerId;
		fence: bigint | number | string;
		status: ReconcileStatus;
		now: number;
		reasons?: readonly ReasonRecord[];
		handover?: Readonly<Record<string, string>>;
	}>,
): ReconcileObservationRecord {
	return create(ReconcileObservationRecordSchema, {
		campId: input.campId,
		setId: input.set.setId,
		reconcilerId: input.reconcilerId,
		fenceToken: String(input.fence),
		status: input.status,
		reasons: [...(input.reasons ?? [])],
		observedAt: new Date(input.now).toISOString(),
		handover: { ...input.handover },
	});
}

function reason(code: string, message: string, remediation: string) {
	return create(ReasonRecordSchema, { code, message, remediation });
}

/** The source pin a Freight's `relay/source` artifact holds. */
async function pinOf(
	freight: FreightRecord | undefined,
	read: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>,
): Promise<RelaySourcePin | undefined> {
	const artifact = freight?.manifest?.artifacts.find(
		(candidate) => candidate.name === RELAY_FREIGHT_ARTIFACTS.source,
	);
	if (!artifact?.digest.startsWith("sha256:")) return undefined;
	// SAFETY: checked to carry the sha256: prefix above.
	const bytes = await read(artifact.digest as `sha256:${string}`);
	if (!bytes) return undefined;
	let fields: JsonObject;
	try {
		fields = parseJsonObject(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
	const text = (key: string) => {
		const value = fields[key];
		return isJsonString(value) && value !== "" ? value : undefined;
	};
	const repository = text("repository");
	const ref = text("ref");
	if (!repository || !ref) return undefined;
	const sha = text("sha");
	const rootDirectory = text("rootDirectory");
	return {
		repository,
		ref,
		...(sha !== undefined ? { sha } : undefined),
		...(rootDirectory !== undefined ? { rootDirectory } : undefined),
	};
}

type Realized =
	| Readonly<{
			kind: "deployed";
			deploymentId: string;
			outputs: Readonly<Record<string, string>>;
	  }>
	| Readonly<{ kind: "failed"; failure: RelayRealizationFailure }>;

/**
 * The conductor realizer: the Vercel git deployment of the commit the desired
 * Set's Freight pins. Converged only once Vercel reports the deployment READY.
 */
export function relayRealizer(
	input: Readonly<{
		realization: RelayRealization;
		freight: (id: FreightId) => Promise<FreightRecord | undefined>;
		read: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
		now: () => number;
		/** False: report CONVERGING once deployed, without reading readiness. */
		observeReadiness?: boolean;
	}>,
): Realizer &
	Readonly<{
		failure(setId: string): RelayRealizationFailure | undefined;
		deployed(setId: string): Readonly<Record<string, string>> | undefined;
	}> {
	const realized = new Map<string, Realized>();

	async function observeSet(
		at: Parameters<Realizer["observe"]>[0],
	): Promise<ReconcileObservationRecord> {
		const base = {
			campId: at.campId,
			set: at.desired,
			reconcilerId: at.reconcilerId,
			fence: at.fence,
			now: input.now(),
		};
		const done = realized.get(at.desired.setId);
		if (!done)
			return observation({
				...base,
				status: ReconcileStatus.CONVERGING,
				reasons: [
					reason(
						"relay-not-deployed",
						`Set ${at.desired.setId} has not been deployed by this conductor`,
						"Run hobo ci deploy for the commit; the conductor deploys it.",
					),
				],
			});
		if (done.kind === "failed")
			return observation({
				...base,
				status: ReconcileStatus.BLOCKED,
				reasons: [
					reason(
						done.failure.code,
						done.failure.message,
						"Fix the cause the code names, then run hobo ci deploy again.",
					),
				],
			});
		if (input.observeReadiness === false)
			return observation({
				...base,
				status: ReconcileStatus.CONVERGING,
				handover: done.outputs,
				reasons: [
					reason(
						"relay-readiness-unobserved",
						`deployment ${done.deploymentId} was created; its readiness was not read`,
						"Run hobo ci deploy --wait to observe it and finish the promotion.",
					),
				],
			});
		const state = await input.realization.readyState(done.deploymentId);
		const handover = { ...done.outputs, readyState: state };
		if (state === "READY")
			return observation({
				...base,
				status: ReconcileStatus.CONVERGED,
				handover,
			});
		if (state === "ERROR" || state === "CANCELED")
			return observation({
				...base,
				status: ReconcileStatus.BLOCKED,
				handover,
				reasons: [
					reason(
						"HOBO_CI_DEPLOY_NOT_READY",
						`deployment ${done.deploymentId} ended ${state}, not READY`,
						"Read the deployment's build log on Vercel, fix it, and deploy again.",
					),
				],
			});
		return observation({
			...base,
			status: ReconcileStatus.CONVERGING,
			handover,
		});
	}

	return {
		failure(setId) {
			const done = realized.get(setId);
			return done?.kind === "failed" ? done.failure : undefined;
		},
		deployed(setId) {
			const done = realized.get(setId);
			return done?.kind === "deployed" ? done.outputs : undefined;
		},
		async converge(at) {
			if (!realized.has(at.desired.setId)) {
				// SAFETY: a Set names the Freight id it was resolved from.
				const freight = await input.freight(at.desired.freightId as FreightId);
				const pin = await pinOf(freight, input.read);
				if (!pin) {
					realized.set(at.desired.setId, {
						kind: "failed",
						failure: {
							ok: false,
							code: "HOBO_CI_DEPLOY_SOURCE_UNPINNED",
							message: `Freight ${at.desired.freightId} pins no relay source commit`,
						},
					});
				} else {
					const deployed = await input.realization.deploy(pin);
					realized.set(
						at.desired.setId,
						deployed.ok
							? {
									kind: "deployed",
									deploymentId: deployed.outputs.deploymentId ?? "",
									outputs: deployed.outputs,
								}
							: { kind: "failed", failure: deployed },
					);
				}
			}
			return observeSet(at);
		},
		observe: observeSet,
	};
}

/** Record the relay build as Freight (idempotent: one commit, one Freight). */
async function recordFreight(
	cd: ReturnType<typeof composeContinuousDelivery>,
	input: RelayDeliveryInput,
	ctx: CdContext,
) {
	const encoder = new TextEncoder();
	const declaration = await cd.artifacts.put(
		encoder.encode(serializeManifest(input.declaration)),
		{
			name: RELAY_FREIGHT_ARTIFACTS.declaration,
			kind: ArtifactKind.SOURCE_TREE,
			mediaType: DECLARATION_MEDIA_TYPE,
		},
		ctx,
	);
	const pin = {
		bindle: HOBO_CI_COMPONENTS.relay.bindle,
		repository: input.source.repository,
		ref: input.source.ref,
		...(input.source.sha !== undefined ? { sha: input.source.sha } : undefined),
		...(input.source.rootDirectory !== undefined
			? { rootDirectory: input.source.rootDirectory }
			: undefined),
	};
	const source = await cd.artifacts.put(
		encoder.encode(JSON.stringify(pin)),
		{
			name: RELAY_FREIGHT_ARTIFACTS.source,
			kind: ArtifactKind.SOURCE_TREE,
			mediaType: RELAY_SOURCE_MEDIA_TYPE,
		},
		ctx,
	);
	const runId = input.env.GITHUB_RUN_ID?.trim() ?? "";
	return cd.freight.record(
		{
			manifest: create(FreightManifestRecordSchema, {
				schemaVersion: FREIGHT_MANIFEST_SCHEMA,
				bindle: HOBO_CI_COMPONENTS.relay.bindle,
				declarationHash: canonicalManifestHash(input.declaration),
				artifacts: [declaration, source],
				source: {
					repository: input.source.repository,
					commit: input.source.sha ?? "",
					ref: input.source.ref,
					ciRunId: runId,
					ciSystem: runId !== "" ? "github-actions" : "",
					builderId: input.env.GITHUB_WORKFLOW_REF?.trim() ?? "",
				},
				labels: { "hobo.dev/component": "ci-relay" },
			}),
			origin: FreightOrigin.MANIFEST,
		},
		ctx,
	);
}

async function applyRecords(
	cd: ReturnType<typeof composeContinuousDelivery>,
	records: DeliveryModule,
	ctx: CdContext,
): Promise<readonly ReasonRecord[]> {
	for (const source of records.sources) {
		const defined = await cd.sources.define(source, ctx);
		if (!defined.ok) return defined.reasons;
	}
	for (const pipeline of records.pipelines) {
		const applied = await cd.pipelines.apply(pipeline, ctx);
		if (!applied.ok) return applied.reasons;
	}
	return [];
}

/**
 * Deliver the relay to one Camp: record Freight, promote it through the
 * pipeline node the target names, and drive the promotion (gate, Set,
 * conductor realization, verification, qualification) to its end.
 */
export async function deliverRelay(
	input: RelayDeliveryInput,
): Promise<RelayDeliveryOutcome> {
	const now = input.now ?? (() => Date.now());
	const sleep =
		input.sleep ??
		((ms: number) => new Promise((done) => setTimeout(done, ms)));
	const emit = input.emitProgress ?? (() => {});
	const parsed = parseCdComposeConfig({
		env: input.env,
		home: input.home,
		simulate: false,
	});
	if (!parsed.ok)
		return {
			ok: false,
			code: RELAY_DELIVERY_REFUSAL.unavailable,
			message: `CD could not be configured: ${describeReasons(parsed.reasons)}`,
		};
	const config = parsed.value;
	let opened: Awaited<ReturnType<CdStoreOpener>>;
	try {
		opened = await (input.openStore ?? openCdStore)(config.store, { now });
	} catch (error) {
		return {
			ok: false,
			code: RELAY_DELIVERY_REFUSAL.unavailable,
			message: `The CD journal could not be opened (cd-store-unavailable): ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		return await deliverWith(input, config, opened.store, now, sleep, emit);
	} finally {
		await opened.close();
	}
}

async function deliverWith(
	input: RelayDeliveryInput,
	config: Extract<
		ReturnType<typeof parseCdComposeConfig>,
		{ ok: true }
	>["value"],
	store: Awaited<ReturnType<CdStoreOpener>>["store"],
	now: () => number,
	sleep: (ms: number) => Promise<void>,
	emit: (message: string) => void,
): Promise<RelayDeliveryOutcome> {
	const http =
		input.http ?? createBoundedFetchTransport({ fetchImpl: globalThis.fetch });
	const credentials = envCredentials(input.env);
	const topology = staticTopologyReader(
		yardTopology([input.yard], config.stationId),
	);
	const railCatalog = createJournalRailCatalog({ store });
	const policyPack = createCdBaselinePack();
	const registry = createRegistryFromProviders([
		relayYardRegistryProvider(input.yard),
	]);
	let realizer: ReturnType<typeof relayRealizer> | undefined;
	const cd = composeContinuousDelivery({
		base: { store, tenant: config.tenant, now },
		factories: defaultCdFactories,
		adapters: defaultCdAdapters({
			store,
			railCatalog,
			resolvePack: async () => policyPack,
			packs: async () => [],
			realizers: {
				conductor: (scope) => {
					realizer = relayRealizer({
						realization: input.realization,
						freight: (id) => scope.freight.get(id),
						read: (digest) => scope.artifacts.get(digest),
						now,
						observeReadiness: input.wait !== false,
					});
					return realizer;
				},
			},
			planning: {
				registry,
				declarationDigest: (declaration) => canonicalManifestHash(declaration),
				async declaration(freight) {
					const bytes = await cd.artifacts.get(
						// SAFETY: a Freight's declaration hash is a sha256 digest.
						freight.manifest?.declarationHash as `sha256:${string}`,
					);
					if (!bytes) return undefined;
					return parseManifest(JSON.parse(new TextDecoder().decode(bytes)));
				},
				async camp(campId) {
					const camp = await topology.camp(campId);
					if (!camp) return undefined;
					return {
						environment: camp.envType,
						config: camp.regions[0] ? { region: camp.regions[0] } : {},
					};
				},
			},
			gate: {
				contracts: async () => ({ deployed: [], candidate: [] }),
				subject: async () => ({ classifications: [], residency: [] }),
			},
		}),
		http,
		credentials,
		artifactStore:
			config.artifacts.backend === "filesystem"
				? { backend: "filesystem", root: config.artifacts.root }
				: config.artifacts.backend === "s3-compatible"
					? {
							backend: "s3-compatible",
							endpoint: config.artifacts.endpoint,
							bucket: config.artifacts.bucket,
							region: config.artifacts.region,
							credentialRef: config.artifacts.credentialRef,
							credentials,
							http,
						}
					: { backend: "memory" },
		trustPolicy: {},
		policyPack,
		topology,
		railCatalog,
		readRailEvents: createJournalRailEventReader({ store }),
		// Telemetry is exported only where OTEL_EXPORTER_OTLP_ENDPOINT names a
		// collector (CD.md: "none" by default); otherwise every metric would
		// retry a collector that is not there, with backoff, on every pass.
		...(config.telemetryEndpoint
			? { telemetryEndpoint: config.telemetryEndpoint }
			: { telemetry: DISCARDING_TELEMETRY }),
	});
	const ctx: CdContext = {
		tenant: config.tenant,
		principal: cdPrincipal(input.env),
		now,
	};

	const pipeline = HOBO_CI_COMPONENTS.relay.pipeline;
	const node = input.target;
	const campId = relayCampId(input.yard, input.target);
	const previewCampId = relayCampId(input.yard, "preview");

	let records = input.records;
	if (!records) {
		const loaded = await loadDeliveryFile(RELAY_DELIVERY_FILE, {
			cwd: input.cwd,
		});
		if (!loaded.ok)
			return {
				ok: false,
				code: RELAY_DELIVERY_REFUSAL.recordsInvalid,
				message: `${RELAY_DELIVERY_FILE}: ${loaded.code}: ${loaded.message}. ${loaded.remediation}`,
			};
		records = loaded.value;
	}
	const refusedRecords = await applyRecords(cd, records, ctx);
	if (refusedRecords.length > 0)
		return {
			ok: false,
			code: RELAY_DELIVERY_REFUSAL.recordsInvalid,
			message: `CD refused the relay's delivery records: ${describeReasons(refusedRecords)}`,
		};

	const recorded = await recordFreight(cd, input, ctx);
	if (!recorded.ok)
		return {
			ok: false,
			code: RELAY_DELIVERY_REFUSAL.freightRefused,
			message: `CD refused the relay Freight: ${describeReasons(recorded.reasons)}`,
		};
	const freight = recorded.value;
	const report = (
		promotion?: PromotionRecord,
		set?: SetRecord,
	): RelayDeliveryReport => ({
		pipeline,
		node,
		campId,
		freightId: freight.freightId,
		alias: freight.alias,
		...(promotion
			? {
					promotionId: promotion.promotionId,
					state: PromotionState[promotion.state] ?? String(promotion.state),
				}
			: undefined),
		...(set ? { setId: set.setId } : undefined),
		reasons: reasonsOf(promotion?.reasons ?? []),
	});
	emit(
		`Freight ${freight.alias} (${freight.freightId}) records ${input.source.repository}@${input.source.sha ?? input.source.ref}`,
	);

	// Production takes only Freight preview qualified (the pipeline's
	// from_nodes); refuse before anything reaches Vercel.
	if (node === "production") {
		const available = await cd.pipelines.available({ pipeline, node });
		const ours = available.find(
			(entry) => entry.freightId === freight.freightId,
		);
		if (!ours) {
			const qualified = await cd.freight.qualifications(
				// SAFETY: the ledger's own id.
				freight.freightId as FreightId,
			);
			const atPreview = qualified.some(
				(entry) => entry.campId === previewCampId,
			);
			return {
				ok: false,
				code: RELAY_DELIVERY_REFUSAL.notQualified,
				message: atPreview
					? `Freight ${freight.alias} is qualified at ${previewCampId} but not available to ${pipeline}/production (yanked, or its soak has not elapsed).`
					: `Freight ${freight.alias} (${input.source.sha ?? input.source.ref}) has not been qualified at ${previewCampId}: production takes only Freight preview verified. Run hobo ci deploy --target preview for this commit first.`,
				report: report(),
			};
		}
	}

	const idempotencyKey = `relay:${freight.freightId}:${campId}`;
	const requested = await cd.promotions.promote(
		{
			// SAFETY: the ledger's own id.
			freightId: freight.freightId as FreightId,
			targets: [campId],
			idempotencyKey,
			pipeline,
			node,
			...(node === "production" ? { sourceCampId: previewCampId } : undefined),
		},
		ctx,
	);
	if (!requested.ok)
		return {
			ok: false,
			code: RELAY_DELIVERY_REFUSAL.promotionRefused,
			message: `CD refused to promote ${freight.alias} to ${campId}: ${describeReasons(requested.reasons)}`,
			report: { ...report(), reasons: reasonsOf(requested.reasons) },
		};
	// SAFETY: the promotion service's own id.
	const promotionId = requested.value.promotionId as PromotionId;
	emit(`promotion ${promotionId} of ${freight.alias} to ${campId}`);

	const conductor = conductorFor(cd, {
		campIds: [campId],
		holderId: `hobo-ci-deploy:${process.pid}`,
	});
	const limitMs = input.limitMs ?? DEFAULT_LIMIT_MS;
	const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
	const until = now() + limitMs;
	// A clock that does not move still ends: at most one pass per interval of the limit.
	let passes = Math.ceil(limitMs / Math.max(1, intervalMs)) + 1;
	let promotion: PromotionRecord | undefined = requested.value;
	let last: ReconcileObservationRecord | undefined;
	let lastState: PromotionState | undefined;
	for (;;) {
		// The same steps `hobo serve cd` ticks, for this one promotion.
		await cd.promotions.tick(ctx);
		const set = await cd.desired.current(campId);
		if (set) {
			// A bounded pass: the in-process feed long-polls for a change that
			// may never come (a Delta opened but not applied), so each pass
			// waits at most `feedWaitMs` for it.
			last = await conductor.reconcileOnce(campId, {
				...ctx,
				signal: AbortSignal.timeout(input.feedWaitMs ?? DEFAULT_FEED_WAIT_MS),
			});
			const failure = realizer?.failure(set.setId);
			if (failure)
				return {
					ok: false,
					code: failure.code,
					message: failure.message,
					realization: failure,
					report: report(promotion, set),
				};
			const outputs = realizer?.deployed(set.setId);
			if (input.wait === false && outputs) {
				const current = await cd.promotions.get(promotionId);
				return {
					ok: true,
					report: report(current ?? promotion, set),
					handover: outputs,
				};
			}
		}
		await cd.rollouts.tick(ctx);
		await cd.verification.tick(ctx);
		promotion = await cd.promotions.get(promotionId);
		if (promotion && promotion.state !== lastState) {
			lastState = promotion.state;
			emit(`promotion ${promotionId}: ${PromotionState[promotion.state]}`);
		}
		const handover = last?.setId === set?.setId ? (last?.handover ?? {}) : {};
		if (
			set &&
			last?.setId === set.setId &&
			last.status === ReconcileStatus.BLOCKED &&
			!(promotion && TERMINAL.has(promotion.state))
		) {
			const blocked = last.reasons[0];
			return {
				ok: false,
				code: blocked?.code ?? RELAY_DELIVERY_REFUSAL.incomplete,
				message:
					blocked?.message ??
					`The conductor reported Set ${set.setId} blocked at ${campId}`,
				report: report(promotion, set),
				handover,
			};
		}
		if (promotion && TERMINAL.has(promotion.state)) {
			if (promotion.state === PromotionState.PROMOTED)
				return { ok: true, report: report(promotion, set), handover };
			const verificationFailed = promotion.reasons.some((entry) =>
				entry.code.includes("verification"),
			);
			return {
				ok: false,
				code: verificationFailed
					? RELAY_DELIVERY_REFUSAL.verificationFailed
					: RELAY_DELIVERY_REFUSAL.promotionRefused,
				message: `The promotion of ${freight.alias} to ${campId} ended ${PromotionState[promotion.state]}: ${describeReasons(promotion.reasons)}`,
				report: report(promotion, set),
				handover,
			};
		}
		if (promotion && HELD.has(promotion.state))
			return {
				ok: false,
				code: RELAY_DELIVERY_REFUSAL.incomplete,
				message: `The promotion of ${freight.alias} to ${campId} is held (${PromotionState[promotion.state]}); approve it or wait for its window, then run hobo ci deploy again.`,
				report: report(promotion, set),
				handover,
			};
		passes -= 1;
		if (now() >= until || passes <= 0)
			return {
				ok: false,
				code: RELAY_DELIVERY_REFUSAL.incomplete,
				message: `The promotion of ${freight.alias} to ${campId} had not finished (${promotion ? PromotionState[promotion.state] : "unknown"}) when the wait ran out; run hobo ci deploy again (it is idempotent).`,
				report: report(promotion, set),
				handover,
			};
		await sleep(intervalMs);
	}
}

/** A promotion record as canonical protobuf JSON (for result data). */
export function promotionJson(promotion: PromotionRecord) {
	return toJson(PromotionRecordSchema, promotion);
}
