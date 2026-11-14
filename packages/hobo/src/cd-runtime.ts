/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: config files and CLI flags read here are untrusted JSON narrowed before use; @hobo/cd-kube-fleet parses each realizer record itself. */
/**
 * The HoBo host's CD runtime (WP18, plan 0024, C2): opens the journal, builds
 * the declared topology, binds the host adapters and composes `@hobo/cd`
 * through `composeContinuousDelivery`. `hobo deploy`, `hobo incident`,
 * `hobo serve cd` and the `hobo up` delivery seam all open CD here, so there
 * is one composition and one path.
 *
 * Fixtures are reachable only with `--simulate`: the in-memory journal, the
 * in-memory artifact store and the labelled simulated realizer.
 */

import { create } from "@bufbuild/protobuf";
import { canonicalManifestHash } from "@hobo/bindles";
import {
	ArtifactKind,
	type CampId,
	type CampReconciler,
	type CampTopology,
	type CdContext,
	type CredentialResolver,
	DeltaRecordSchema,
	type DesiredStateReader,
	type FreightId,
	FreightOrigin,
	type FreightRecord,
	type FreightSourceRecord,
	type Outcome,
	type RealizeInput,
	type Realizer,
	type ReasonRecord,
	ReasonRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	type ReconcilerId,
	ReconcilerMode,
	ReconcileStatus,
	ResourceObservationSchema,
	type SetResolver,
	type TelemetrySink,
	type TopologyReader,
} from "@hobo/cd";
// binds at merge (plan 0024): the authz baseline pack is WP19.
import { createCdBaselinePack } from "@hobo/cd/authz";
import {
	type CdComposeConfig,
	type CdHostInputs,
	type ComposedContinuousDelivery,
	composeContinuousDelivery,
	conductorFor,
	createJournalRailCatalog,
	createJournalRailEventReader,
	createSimulatedRealizer,
	defaultCdAdapters,
	defaultCdFactories,
	type FanoutCostAuthority,
	parseCdComposeConfig,
	unconfiguredSuites,
} from "@hobo/cd/compose";
import { createPlacementEngine } from "@hobo/cd/placement";
import { deltaIdFor, diffResolvedSets } from "@hobo/cd/promotion";
// binds at merge (plan 0024): drift routing is WP7.
import { createDriftPolicy } from "@hobo/cd/reconcile";
import { definitionDigest } from "@hobo/cd/sources";
import {
	RUNNER_FLEET_BINDLE,
	RUNNER_HOST_PRODUCT_ID,
	type RunnerHostPorts,
	runnerFleetDeclaration,
	runnerHostIdForCamp,
	runnerHostRealizationParameters,
} from "@hobo/ci-gh-actions/runner-host";
import {
	createRegistryFromProviders,
	createResolvedDeploymentSet,
	type PlannerRegistry,
	type RegistrableProvider,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import type { PolicyPack } from "@hobo/contracts";
import {
	type JsonObject as CdJsonObject,
	createBoundedFetchTransport,
	type DurableEventStore,
	type HttpTransport,
	type PrincipalRef,
	ResolverError,
} from "@hobo/core";
import type { Yard } from "@hobo/yards";
import { agentRealizer } from "./cd-agent.js";
import {
	createRunnerHostVerifySuite,
	withRunnerHostHealthIngest,
} from "./cd-agent-runner-host.js";
import {
	declaredRailCatalog,
	loadDeclaredRails,
	memoizedImporter,
} from "./cd-declared-rails.js";
import { defaultModuleImporter } from "./cd-delivery-module.js";
import type { CdDeployHost } from "./cd-deploy.js";
import { type CdStoreOpener, openCdStore } from "./cd-store.js";
import {
	loadTopologyFiles,
	mergeTopologyReaders,
	staticTopologyReader,
	TopologyConflictError,
	yardTopology,
} from "./cd-topology.js";
import {
	CATALOG_REALIZED_PRODUCTS,
	type CatalogCampBinding,
	type CatalogFreight,
	CatalogRealizerError,
	catalogCampBinding,
	catalogRealizedProvider,
} from "./provider-hosting-catalog.js";

export type CdRuntimeOptions = Readonly<{
	env: Readonly<Record<string, string | undefined>>;
	/** HOBO_HOME. */
	home: string;
	cwd: string;
	/** `--simulate`: the only path to fixtures. */
	simulate: boolean;
	now?: () => number;
	principal?: PrincipalRef;
	/** Share an already-open journal (e.g. the Yard runtime's, for `hobo up`). */
	store?: DurableEventStore;
	openStore?: CdStoreOpener;
	yards?: readonly Yard[];
	/**
	 * Topology files (`--yard`, HOBO_CD_TOPOLOGY): Yard modules or delivery
	 * modules exporting `yards`/`camps`, parsed once (cd-topology.ts).
	 */
	topologyFiles?: readonly string[];
	/** Extra topology sources (e.g. an imported ClusterProfile inventory). */
	topology?: readonly TopologyReader[];
	http?: HttpTransport;
	credentials?: CredentialResolver;
	registry?: PlannerRegistry;
	realizers?: CdHostInputs["realizers"];
	routing?: CdHostInputs["routing"];
	gate?: Partial<CdHostInputs["gate"]>;
	policyPack?: PolicyPack;
	resolvePack?: CdHostInputs["resolvePack"];
	packs?: CdHostInputs["packs"];
	/**
	 * The pricing and Station budget authorities the fan-out aggregate gate
	 * reads (D20). Without them every fan-out promotion is refused before any
	 * Camp starts (`fanout-aggregate-quote-missing`); cost is never assumed zero.
	 */
	fanoutCost?: FanoutCostAuthority;
	trustPolicy?: CdJsonObject;
	readCiEvents?: Parameters<
		typeof composeContinuousDelivery
	>[0]["readCiEvents"];
	readCiArtifact?: Parameters<
		typeof composeContinuousDelivery
	>[0]["readCiArtifact"];
	/**
	 * A runner host's job ports (and, optionally, its container port) for
	 * `hobo deploy agent run` with HOBO_CD_RUNNER_HOST (cd-agent.ts). The
	 * container port defaults to the engine CLI; job ports have no default.
	 */
	runnerHost?: RunnerHostPorts;
	/** How an agent's realizer waits between observations (default: a timer). */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Where a failed runner-host health ingest is reported (default: one JSON
	 * line on stderr, event `hobo_cd_runner_host_ingest_failed`).
	 */
	onRunnerHostIngestError?: (error: Error) => void;
}>;

export type CdRuntime = Readonly<{
	cd: ComposedContinuousDelivery;
	config: CdComposeConfig;
	ctx: CdContext;
	host: CdDeployHost;
	store: DurableEventStore;
	conductor(campIds: readonly CampId[], holderId?: string): CampReconciler;
	close(): Promise<void>;
}>;

/** The principal a CLI or MCP session acts as: an agent when HOBO_AGENT_ID is set (proposal-only by default, ADR-0094). */
export function cdPrincipal(
	env: Readonly<Record<string, string | undefined>>,
): PrincipalRef {
	const agent = env.HOBO_AGENT_ID?.trim();
	if (agent) return { kind: "agent", id: agent };
	const user = env.HOBO_USER?.trim() || env.USER?.trim() || "local-operator";
	return { kind: "user", id: user };
}

/** Secret-free credential locators: resolved from the process env for one use, never persisted. */
export function envCredentials(
	env: Readonly<Record<string, string | undefined>>,
): CredentialResolver {
	return {
		async resolve(ref: string) {
			const name = ref.startsWith("env://")
				? ref.slice("env://".length)
				: undefined;
			const value = name ? env[name] : undefined;
			if (name === undefined || value === undefined || value === "")
				throw new Error(
					`credential ${ref} is not resolvable on this host (use env://<NAME>)`,
				);
			return { token: value };
		},
	};
}

/** Telemetry when no OTLP endpoint is configured: nothing leaves the process. */
export const DISABLED_TELEMETRY: TelemetrySink = Object.freeze({
	spans: async () => {},
	metrics: async () => {},
});

function refusal(code: string, message: string, remediation: string) {
	return {
		ok: false as const,
		reasons: [create(ReasonRecordSchema, { code, message, remediation })],
	};
}

/** Open the composed CD runtime. */
export async function openCdRuntime(
	options: CdRuntimeOptions,
): Promise<Outcome<CdRuntime>> {
	const parsed = parseCdComposeConfig({
		env: options.env,
		home: options.home,
		simulate: options.simulate,
	});
	if (!parsed.ok) return parsed;
	const config = parsed.value;
	// Declared topology is read before the journal opens: a malformed file
	// refuses the command with nothing opened.
	const files = options.topologyFiles ?? [];
	// One evaluation per module: Camps and Rails are read from the same files.
	const importModule = memoizedImporter(defaultModuleImporter);
	const declared =
		files.length === 0
			? ({ ok: true, value: [] } as const)
			: await loadTopologyFiles(files, {
					cwd: options.cwd,
					stationId: config.stationId,
					importModule,
				});
	if (!declared.ok)
		return refusal(declared.code, declared.message, declared.remediation);
	const declaredRails =
		files.length === 0
			? ({ ok: true, value: [] } as const)
			: await loadDeclaredRails(files, {
					cwd: options.cwd,
					stationId: config.stationId,
					importModule,
				});
	if (!declaredRails.ok)
		return refusal(
			declaredRails.code,
			declaredRails.message,
			declaredRails.remediation,
		);
	let declaredTopology: TopologyReader;
	try {
		declaredTopology = staticTopologyReader([
			...yardTopology(options.yards ?? [], config.stationId),
			...declared.value,
		]);
	} catch (error) {
		if (error instanceof TopologyConflictError)
			return refusal(error.code, error.message, error.remediation);
		throw error;
	}
	const now = options.now ?? (() => Date.now());
	const principal = options.principal ?? cdPrincipal(options.env);
	let opened: Awaited<ReturnType<CdStoreOpener>> | undefined;
	let store = options.store;
	if (!store) {
		try {
			opened = await (options.openStore ?? openCdStore)(config.store, { now });
		} catch (error) {
			return refusal(
				"cd-store-unavailable",
				error instanceof Error ? error.message : String(error),
				config.store.backend === "postgres"
					? "Check HOBO_CD_POSTGRES_URL reachability and that the server is PostgreSQL 16 or later."
					: "Check that HOBO_HOME is writable (or set HOBO_CD_SQLITE_PATH).",
			);
		}
		store = opened.store;
	}
	const base = { store, tenant: config.tenant, now };
	const http =
		options.http ??
		createBoundedFetchTransport({ fetchImpl: globalThis.fetch });
	const credentials = options.credentials ?? envCredentials(options.env);
	const kube = await openKubeFleet({
		env: options.env,
		cwd: options.cwd,
		http,
		credentials,
		now,
	});
	if (kube && !kube.ok) {
		await opened?.close();
		return kube;
	}
	const topology = mergeTopologyReaders([
		declaredTopology,
		...(kube?.value.topology ? [kube.value.topology] : []),
		...(options.topology ?? []),
	]);
	const rails = declaredRailCatalog(
		createJournalRailCatalog({ store }),
		declaredRails.value,
	);
	if (!rails.ok) {
		await opened?.close();
		return rails;
	}
	const railCatalog = rails.value;
	// binds at merge (plan 0024): the baseline delivery policy pack (WP19).
	const policyPack = options.policyPack ?? createCdBaselinePack();
	const resolvePack = options.resolvePack ?? (async () => policyPack);
	// Camps declared on a catalogued publication provider (npm, OCI registry,
	// GitHub Pages) are realized by that provider's shipped resolver.
	const catalogCamps = (await declaredTopology.camps()).filter(
		(camp) => catalogRealizedProvider(camp.provider) !== undefined,
	);
	// One conductor per runtime: a topology that needs both the kube fleet's
	// realizer and the catalog's is refused, never silently resolved to one.
	if (
		!config.simulate &&
		catalogCamps.length > 0 &&
		kube?.value.realizer &&
		!options.realizers?.conductor
	) {
		await opened?.close();
		return refusal(
			"cd-conductor-conflict",
			`the topology declares publication Camps (${catalogCamps
				.map((camp) => camp.campId)
				.join(", ")}) and a Kubernetes fleet: both need the conductor realizer`,
			"Open publication Camps (--yard) and the Kubernetes fleet (HOBO_CD_KUBE_*) in separate hobo deploy runs, or compose one conductor through options.realizers.",
		);
	}
	const realizers: CdHostInputs["realizers"] = {
		...(!config.simulate && catalogCamps.length > 0
			? {
					conductor: (scope: ComposedContinuousDelivery["scope"]) =>
						createCatalogResolverRealizer({
							topology,
							freight: (id) => scope.freight.get(id),
							artifacts: scope.artifacts,
							http,
							credentials,
							now,
						}),
				}
			: undefined),
		...(config.simulate
			? { conductor: () => createSimulatedRealizer() }
			: undefined),
		...(kube?.value.realizer ? { conductor: kube.value.realizer } : undefined),
		...options.realizers,
	};
	// Matching offers each declared Camp kind exactly its own product: the
	// catalogued publication providers theirs, runner hosts the runner-host
	// product. Nothing else is offered.
	const plannerProviders = [
		...catalogPlannerProviders(catalogCamps),
		...runnerHostPlannerProviders(await declaredTopology.camps()),
	];
	const registry =
		options.registry ??
		(plannerProviders.length > 0
			? createRegistryFromProviders(plannerProviders)
			: undefined);
	// A source-discovered Freight with no declaration member names its source
	// definition (`declaration_hash`); the Bindle's declaration planned with
	// it is bound to that digest here, never to a digest it does not have.
	const sourceBound = new WeakMap<object, `sha256:${string}`>();
	const host: CdHostInputs = {
		store,
		railCatalog,
		resolvePack,
		packs: options.packs ?? (async () => []),
		realizers,
		...(options.routing ? { routing: options.routing } : undefined),
		planning: {
			// A Freight's declaration is the Bindle the build stored under its
			// declaration hash (`hobo build`, D13); planning refuses when absent.
			registry: registry ?? emptyRegistry(),
			// The digest `hobo build` records as `declaration_hash` (D13), or the
			// source definition's for a Bindle declared with its source.
			declarationDigest: (declaration) =>
				sourceBound.get(declaration) ?? canonicalManifestHash(declaration),
			async declaration(freight: FreightRecord) {
				const bytes = await cd.artifacts.get(
					freight.manifest?.declarationHash as `sha256:${string}`,
				);
				const { parseManifest } = await import("@hobo/bindles");
				if (bytes)
					return parseManifest(JSON.parse(new TextDecoder().decode(bytes)));
				const declared = sourceDeclaredBindle(freight, await cd.sources.list());
				if (!declared) return undefined;
				const declaration = parseManifest(declared.declaration);
				sourceBound.set(declaration, declared.digest);
				return declaration;
			},
			async camp(campId: CampId) {
				const camp = await topology.camp(campId);
				if (!camp) return undefined;
				return {
					environment: camp.envType,
					config: camp.regions[0] ? { region: camp.regions[0] } : {},
				};
			},
		},
		gate: {
			// Contracts come from the declaration the gate is handed; without a
			// contract reader both sets are empty and can-deploy is vacuous.
			contracts: async () => ({ deployed: [], candidate: [] }),
			subject: async () => ({ classifications: [], residency: [] }),
			...options.gate,
		},
	};
	// The Station's Rail decides provider approval for Placement (I5): the
	// active declared Rail's approvedProviders, else undefined (fail closed).
	// Accepted runner-host reports also reach Camp inventory as health.
	const factories = withRunnerHostHealthIngest(
		{
			...defaultCdFactories,
			createPlacementEngine: (deps) =>
				createPlacementEngine({
					...deps,
					approvedProviders: (stationId) =>
						railCatalog.approvedProviders(stationId),
				}),
		},
		options.onRunnerHostIngestError ?? reportRunnerHostIngestError,
	);
	const fanoutCost = options.fanoutCost;
	const adapters = defaultCdAdapters(host);
	const cd = composeContinuousDelivery({
		base,
		factories,
		adapters: {
			...adapters,
			// A runner-host row carries the controller its Freight pins.
			resolver: (scope) =>
				withRunnerHostRealization(adapters.resolver(scope), scope.desired),
			// A runner host verifies from its agent's own reports; every other
			// suite stays fail-closed (no runner is composed for it).
			suites: (scope) =>
				createRunnerHostVerifySuite({
					desired: scope.desired,
					inventory: scope.inventory,
					otherwise: adapters.suites?.(scope) ?? unconfiguredSuites(),
				}),
			// Fan-out promotions read placed Camps from the recorded decision
			// and the aggregate gate from these authorities (compose/wire.ts).
			...(fanoutCost !== undefined
				? { fanoutCost: () => fanoutCost }
				: undefined),
		},
		http,
		credentials,
		artifactStore:
			config.artifacts.backend === "memory"
				? { backend: "memory" }
				: config.artifacts.backend === "filesystem"
					? { backend: "filesystem", root: config.artifacts.root }
					: {
							backend: "s3-compatible",
							endpoint: config.artifacts.endpoint,
							bucket: config.artifacts.bucket,
							region: config.artifacts.region,
							credentialRef: config.artifacts.credentialRef,
							credentials,
							http,
						},
		trustPolicy: options.trustPolicy ?? {},
		policyPack,
		topology,
		railCatalog,
		readRailEvents: createJournalRailEventReader({ store }),
		...(options.readCiEvents
			? { readCiEvents: options.readCiEvents }
			: undefined),
		...(options.readCiArtifact
			? { readCiArtifact: options.readCiArtifact }
			: undefined),
		// Telemetry is opt-in (CD.md): without an OTLP endpoint nothing is
		// exported, rather than the sink's localhost default being retried.
		...(config.telemetryEndpoint
			? { telemetryEndpoint: config.telemetryEndpoint }
			: { telemetry: DISABLED_TELEMETRY }),
	});
	const ctx: CdContext = { tenant: config.tenant, principal, now };
	const conductor = (
		campIds: readonly CampId[],
		holderId = `hobo-cli:${process.pid}`,
	) => conductorFor(cd, { campIds, holderId });
	return {
		ok: true,
		value: Object.freeze({
			cd,
			config,
			ctx,
			store,
			conductor,
			host: {
				cd,
				ctx,
				cwd: options.cwd,
				simulated: config.simulate,
				conductor: (campIds) => conductor(campIds),
				runAgent: async ({ flags }) => {
					const kubeRealizer = kube?.value.realizer;
					const chosen = await agentRealizer({
						simulate: config.simulate,
						env: options.env,
						cwd: options.cwd,
						now,
						campIds: campsOf(flags),
						simulated: createSimulatedRealizer,
						kube: kubeRealizer ? () => kubeRealizer(cd.scope) : undefined,
						runnerHost: options.runnerHost,
						sleep: options.sleep,
					});
					if (!chosen.ok) return chosen;
					const realizer = chosen.value;
					return runAgentProcess({
						flags,
						cwd: options.cwd,
						realizer,
						store,
						tenant: config.tenant,
						now,
						http,
						env: options.env,
					});
				},
			},
			close: async () => {
				await opened?.close();
			},
		}),
	};
}

/** A failed health ingest leaves readiness stale: say so on stderr. */
function reportRunnerHostIngestError(error: Error): void {
	process.stderr.write(
		`${JSON.stringify({
			level: "warn",
			event: "hobo_cd_runner_host_ingest_failed",
			message: error.message,
		})}\n`,
	);
}

function emptyRegistry(): PlannerRegistry {
	// No providers: Matching finds no offering and the planning adapter
	// refuses with a typed reason, never an invented provider.
	return createRegistryFromProviders([]);
}

/**
 * `--feed` names the Station's delivery feed (`https://station/v1/cd/`, as
 * the usage and the runner fleet's agent.env document it); the agent
 * transport takes the Station origin and adds `/v1/cd/` itself. Any other
 * path is passed through for the transport to refuse.
 */
export function stationOriginOf(feedUrl: string): string {
	try {
		const url = new URL(feedUrl);
		if (
			(url.pathname === "/v1/cd/" || url.pathname === "/v1/cd") &&
			!url.search &&
			!url.hash
		)
			return url.origin;
	} catch {
		// Unparsable: the transport refuses it with its own reason.
	}
	return feedUrl;
}

/**
 * Planner offerings of the declared publication Camps: each catalogued
 * provider offers exactly its one resolver product as a port, so a
 * declaration resource `{ type: "data.v1", port: "hobo:<productId>" }`
 * matches only a Camp that provider realizes. Nothing else is offered.
 */
export function catalogPlannerProviders(
	camps: readonly CampTopology[],
): RegistrableProvider[] {
	const byProvider = new Map<string, Set<string>>();
	for (const camp of camps) {
		const id = catalogRealizedProvider(camp.provider);
		if (!id) continue;
		const regions = byProvider.get(id) ?? new Set<string>();
		for (const region of camp.regions) regions.add(region);
		byProvider.set(id, regions);
	}
	return [...byProvider.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([id, regions]) => {
			// SAFETY: keys come from catalogRealizedProvider above.
			const port =
				CATALOG_REALIZED_PRODUCTS[id as keyof typeof CATALOG_REALIZED_PRODUCTS];
			return {
				id,
				regions: [...regions].sort(),
				capabilities: [
					{
						port,
						satisfies(request) {
							if (request.port !== port) return { kind: "none" };
							return (request.features ?? []).length === 0
								? { kind: "full" }
								: { kind: "partial", missing: [...(request.features ?? [])] };
						},
						estimateCost() {
							return {
								marginalPrice: "0",
								sku: port,
								unit: "publication",
								pricingStatus: "unknown",
							};
						},
					},
				],
				capabilityManifest() {
					return {
						providerId: id,
						published: {},
						capabilities: {
							capabilities: [
								{
									port,
									features: [],
									productIds: [port],
									realizedBy: "catalog resolver realizer",
								},
							],
						},
						cost: { facts: [] },
					};
				},
			} satisfies RegistrableProvider;
		});
}

/**
 * Planner offerings of the declared runner host Camps (`hobo-ci-runners/<host>`):
 * each Camp provider offers exactly the runner-host product as a port, so the
 * runner fleet's declared resource (`{ type: "data.v1", port:
 * "hobo:hobo-ci.runner-host/v1" }`, `runnerFleetDeclaration`) matches only a
 * runner host's offering, and the plan row carries the product id the
 * runner-host realizer acts on. Nothing else is offered.
 */
export function runnerHostPlannerProviders(
	camps: readonly CampTopology[],
): RegistrableProvider[] {
	const byProvider = new Map<string, Set<string>>();
	for (const camp of camps) {
		if (runnerHostIdForCamp(camp.campId) === undefined) continue;
		const regions = byProvider.get(camp.provider) ?? new Set<string>();
		for (const region of camp.regions) regions.add(region);
		byProvider.set(camp.provider, regions);
	}
	const port = RUNNER_HOST_PRODUCT_ID;
	return [...byProvider.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([id, regions]) => ({
			id,
			regions: [...regions].sort(),
			capabilities: [
				{
					port,
					satisfies(request) {
						if (request.port !== port) return { kind: "none" };
						return (request.features ?? []).length === 0
							? { kind: "full" }
							: { kind: "partial", missing: [...(request.features ?? [])] };
					},
					estimateCost() {
						// The host is the operator's own machine: no metered price.
						return {
							marginalPrice: "0",
							sku: port,
							unit: "runner-host",
							pricingStatus: "unknown",
						};
					},
				},
			],
			capabilityManifest() {
				return {
					providerId: id,
					published: {},
					capabilities: {
						capabilities: [
							{
								port,
								features: [],
								productId: port,
								realizedBy: "runner-host realizer (hobo deploy agent run)",
							},
						],
					},
					cost: { facts: [] },
				};
			},
		}));
}

/**
 * The planning declaration of a Bindle declared with its source, for a
 * Freight that source discovered with no declaration member (its
 * `declaration_hash` is the source definition's digest, `@hobo/cd/sources`).
 * Only while the source, as applied now, still has exactly that digest: a
 * redefined source no longer names this Freight's declaration, and planning
 * then refuses `planning-declaration-missing` rather than plan it anew.
 * Today one Bindle is declared this way: the runner fleet's controller.
 */
export function sourceDeclaredBindle(
	freight: FreightRecord,
	sources: readonly FreightSourceRecord[],
):
	| Readonly<{ declaration: CdJsonObject; digest: `sha256:${string}` }>
	| undefined {
	const manifest = freight.manifest;
	if (!manifest || manifest.bindle !== RUNNER_FLEET_BINDLE) return undefined;
	if (freight.origin !== FreightOrigin.SOURCE_DISCOVERY) return undefined;
	const source = sources.find((entry) => entry.name === freight.sourceName);
	if (!source || source.bindle !== manifest.bindle) return undefined;
	const digest = definitionDigest(source);
	if (digest !== manifest.declarationHash || !isSha256(digest))
		return undefined;
	return { declaration: { ...runnerFleetDeclaration() }, digest };
}

const isSha256 = (value: string): value is `sha256:${string}` =>
	/^sha256:[0-9a-f]{64}$/u.test(value);

function resolveRefusal(
	campId: CampId,
	code: string,
	message: string,
	remediation: string,
) {
	return {
		ok: false as const,
		reasons: [
			create(ReasonRecordSchema, {
				code,
				message,
				remediation,
				subject: campId,
			}),
		],
	};
}

/**
 * The Set resolver with each runner-host row bound to the controller its
 * Freight pins: Matching decides the row (`hobo-ci.runner-host/v1` on the
 * Camp's provider); its realization parameters are the Freight's own
 * artifacts (`runnerHostRealizationParameters`: the image by manifest
 * digest, and each paired release by its bytes' digest). The Delta is
 * recomputed over the bound Set. A runner-host row for a Camp outside the
 * runner fleet, or a Freight with no digest-pinned image, is refused; every
 * other Set passes through unchanged.
 */
export function withRunnerHostRealization(
	inner: SetResolver,
	desired: DesiredStateReader,
): SetResolver {
	const resolver: SetResolver = {
		async resolve(input, ctx) {
			const outcome = await inner.resolve(input, ctx);
			if (!outcome.ok) return outcome;
			if (input.intent === "down" || input.intent === "depart") return outcome;
			const planned = outcome.value.resolved;
			if (
				!planned.plan.resources.some(
					(resource) => resource.productId === RUNNER_HOST_PRODUCT_ID,
				)
			)
				return outcome;
			if (runnerHostIdForCamp(input.campId) === undefined)
				return resolveRefusal(
					input.campId,
					"runner-host-camp-unbound",
					`Camp ${input.campId} is not a runner host, but its Set resolved a ${RUNNER_HOST_PRODUCT_ID} row`,
					"Promote the runner fleet's Freight only to its Camps (hobo-ci-runners/<host id>).",
				);
			const parameters = runnerHostRealizationParameters(
				input.freight.manifest?.artifacts ?? [],
			);
			if (!parameters)
				return resolveRefusal(
					input.campId,
					"runner-host-image-unresolved",
					`Freight ${input.freight.freightId} carries no hobo-ci-worker image pinned by @sha256 digest`,
					"Promote Freight from the runner fleet's source (hobo-ci-runner-image), whose image artifact is pinned by its manifest digest.",
				);
			const resolved = createResolvedDeploymentSet({
				tenant: planned.tenant,
				environment: planned.environment,
				campId: planned.campId,
				plan: {
					...planned.plan,
					resources: planned.plan.resources.map((resource) =>
						resource.productId === RUNNER_HOST_PRODUCT_ID
							? { ...resource, realizationParameters: { ...parameters } }
							: resource,
					),
				},
				matches: planned.matches,
				gatekeeper: planned.gatekeeper,
				secretRefs: planned.secretRefs,
				...(planned.progressive !== undefined
					? { progressive: planned.progressive }
					: undefined),
			});
			const delta = outcome.value.delta;
			const base = input.base ?? (await desired.current(input.campId));
			const before = base ? await desired.resolved(base) : undefined;
			const source =
				input.sourceCampId && input.sourceCampId !== input.campId
					? await desired.current(input.sourceCampId)
					: undefined;
			const sourceResolved: ResolvedDeploymentSet | undefined = source
				? await desired.resolved(source)
				: undefined;
			return {
				ok: true as const,
				value: {
					resolved,
					delta: create(DeltaRecordSchema, {
						...delta,
						deltaId: deltaIdFor({
							campId: input.campId,
							freightId: input.freight.freightId,
							intent: input.intent,
							baseSetId: base?.setId ?? "",
							contentHash: resolved.contentHash,
						}),
						changes: diffResolvedSets(before, resolved),
						infrastructureDiff: sourceResolved
							? diffResolvedSets(sourceResolved, resolved)
							: delta.infrastructureDiff,
					}),
				},
			};
		},
	};
	return Object.freeze(resolver);
}

/** A thrown resolver refusal (or any failure) as a typed code and message. */
function refusalOf(error: Error) {
	return {
		code:
			error instanceof ResolverError || error instanceof CatalogRealizerError
				? error.code
				: "realize-failed",
		message: error.message,
	};
}

function realizerReason(code: string, message: string, remediation: string) {
	return create(ReasonRecordSchema, { code, message, remediation });
}

/**
 * The conductor realizer for publication Camps: the Set's Freight is realized
 * by the Camp's catalogued resolver (`catalogCampBinding`), one resolve
 * request per artifact. CONVERGED is reported only from the resolvers' own
 * observed outcomes (I5); a resolver refusal is a BLOCKED observation that
 * carries its typed code, never a success.
 */
export function createCatalogResolverRealizer(
	deps: Readonly<{
		topology: TopologyReader;
		freight: (id: FreightId) => Promise<FreightRecord | undefined>;
		artifacts: { get(digest: string): Promise<Uint8Array | undefined> };
		http: HttpTransport;
		credentials: CredentialResolver;
		now: () => number;
	}>,
): Realizer {
	async function bindingOf(input: RealizeInput): Promise<
		| Readonly<{
				binding: CatalogCampBinding;
				freight: CatalogFreight;
		  }>
		| readonly ReasonRecord[]
	> {
		const camp = await deps.topology.camp(input.campId);
		if (!camp)
			return [
				realizerReason(
					"catalog-camp-unknown",
					`Camp ${input.campId} is not declared`,
					"Declare the Camp in the topology (--yard, HOBO_CD_TOPOLOGY).",
				),
			];
		const binding = catalogCampBinding(camp, {
			artifacts: {
				get: (digest) => deps.artifacts.get(digest as `sha256:${string}`),
			},
			resolveCredential: (ref) =>
				deps.credentials.resolve(ref, `cd-realize:${input.campId}`),
		});
		if (!binding)
			return [
				realizerReason(
					"compose-realizer-missing",
					`Camp ${input.campId} (provider ${camp.provider}) has no catalog resolver realizer`,
					"Declare the Camp on @hobo/provider-npm, @hobo/provider-oci-registry or @hobo/provider-github, or compose another conductor realizer.",
				),
			];
		// SAFETY: a Set names the Freight id it was resolved from.
		const record = await deps.freight(input.desired.freightId as FreightId);
		if (!record?.manifest)
			return [
				realizerReason(
					"catalog-freight-missing",
					`Freight ${input.desired.freightId} of Set ${input.desired.setId} is not recorded`,
					"Record the Freight before promoting it.",
				),
			];
		return {
			binding,
			freight: {
				freightId: record.freightId,
				labels: { ...record.manifest.labels },
				artifacts: record.manifest.artifacts.map((artifact) => ({
					name: artifact.name,
					kind: ArtifactKind[artifact.kind] ?? "",
					digest: artifact.digest,
					coordinate: artifact.coordinate,
				})),
			},
		};
	}

	function observation(
		input: RealizeInput,
		status: ReconcileStatus,
		reasons: readonly ReasonRecord[],
		resources: readonly Readonly<{
			resource: string;
			physicalId: string;
			healthy: boolean;
		}>[] = [],
	): ReconcileObservationRecord {
		return create(ReconcileObservationRecordSchema, {
			campId: input.campId,
			setId: input.desired.setId,
			reconcilerId: input.reconcilerId,
			fenceToken: String(input.fence),
			status,
			reasons: [...reasons],
			observedAt: new Date(deps.now()).toISOString(),
			resources: resources.map((r) =>
				create(ResourceObservationSchema, {
					...r,
					kind: "catalog-resolver",
				}),
			),
		});
	}

	// Per Camp, what a binding remembers across passes (acknowledged uploads).
	const memories = new Map<string, Set<string>>();

	async function pass(
		input: RealizeInput,
		asked: "converge" | "observe",
	): Promise<ReconcileObservationRecord> {
		let bound: Awaited<ReturnType<typeof bindingOf>>;
		try {
			bound = await bindingOf(input);
		} catch (error) {
			return blocked(
				input,
				refusalOf(error instanceof Error ? error : new Error(String(error))),
			);
		}
		if (!("binding" in bound))
			return observation(input, ReconcileStatus.BLOCKED, bound);
		const { binding, freight } = bound;
		// An observe-mode Camp never writes, whatever the pass asks.
		const mode = binding.mode === "observe" ? "observe" : asked;
		let memory = memories.get(input.campId);
		if (!memory) {
			memory = new Set<string>();
			memories.set(input.campId, memory);
		}
		const http = binding.transport?.(deps.http, memory) ?? deps.http;
		const resources: {
			resource: string;
			physicalId: string;
			healthy: boolean;
		}[] = [];
		try {
			const requests = binding.requests(freight);
			if (requests.length === 0)
				return observation(input, ReconcileStatus.BLOCKED, [
					realizerReason(
						"catalog-freight-empty",
						`Freight ${freight.freightId} has no artifact ${binding.providerId} realizes`,
						"Record the artifacts this Camp publishes in the Freight.",
					),
				]);
			const resolver = binding.registry.get(binding.productId);
			if (!resolver)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`${binding.providerId} registry has no ${binding.productId} resolver`,
				);
			let pending = false;
			for (const request of requests) {
				const outcome =
					mode === "converge"
						? await resolver.reconcile(request, http)
						: await resolver.read?.(request, http);
				// Ready only as the resolver observed it: every realized product
				// reports `outputs.ready` from its own read (digest and every tag,
				// dist-tag, or the published tree and its build).
				const ready = outcome?.outputs.ready === true;
				if (!ready) pending = true;
				resources.push({
					resource: request.ref.logicalId,
					physicalId: outcome?.physicalId ?? "",
					healthy: ready,
				});
			}
			return pending
				? observation(input, ReconcileStatus.CONVERGING, [], resources)
				: observation(input, ReconcileStatus.CONVERGED, [], resources);
		} catch (error) {
			return blocked(
				input,
				refusalOf(error instanceof Error ? error : new Error(String(error))),
				resources,
			);
		}
	}

	function blocked(
		input: RealizeInput,
		{ code, message }: Readonly<{ code: string; message: string }>,
		resources: Parameters<typeof observation>[3] = [],
	): ReconcileObservationRecord {
		return observation(
			input,
			ReconcileStatus.BLOCKED,
			[
				realizerReason(
					code,
					message,
					"Fix the cause the resolver names; the next pass re-observes and is idempotent.",
				),
			],
			resources,
		);
	}

	return Object.freeze({
		converge: (input: RealizeInput, _ctx: CdContext) => pass(input, "converge"),
		observe: (input: RealizeInput, _ctx: CdContext) => pass(input, "observe"),
	} satisfies Realizer);
}

/** An agent-mode reconciler for `hobo deploy agent run` (outbound HTTPS only, I3). */
export function agentReconciler(
	input: Readonly<{
		feedUrl: string;
		reconcilerId: string;
		privateJwk: CdJsonObject;
		svid: string;
		campIds: readonly CampId[];
		realizer: Realizer;
		store: DurableEventStore;
		tenant: string;
		now: () => number;
		http?: HttpTransport;
		telemetryEndpoint?: string;
	}>,
): CampReconciler {
	const http =
		input.http ?? createBoundedFetchTransport({ fetchImpl: globalThis.fetch });
	// SAFETY: an enrolled reconciler id (the feed verifies it on every request).
	const reconcilerId = input.reconcilerId as ReconcilerId;
	const transport = defaultCdFactories.createHttpTransport({
		baseUrl: stationOriginOf(input.feedUrl),
		http,
		reconcilerId,
		privateJwk: input.privateJwk,
		svid: input.svid,
		now: input.now,
	});
	return defaultCdFactories.createCampReconciler({
		store: input.store,
		tenant: input.tenant,
		now: input.now,
		reconcilerId,
		mode: ReconcilerMode.AGENT,
		campIds: input.campIds,
		holderId: `agent:${input.reconcilerId}`,
		transport,
		realizer: input.realizer,
		drift: createDriftPolicy(),
		telemetry: input.telemetryEndpoint
			? defaultCdFactories.createTelemetrySink({
					http,
					endpoint: input.telemetryEndpoint,
				})
			: DISABLED_TELEMETRY,
	});
}

/**
 * The `hobo up` delivery seam (D13): the slice of the composed facade that
 * `hobo up`/`down`/`build` drive, with the Freight manifest codec. It is
 * structurally the `YardDelivery` of `@hobo/cli` (WP15); `attachCdDelivery`
 * puts it on a YardRuntime so `up` records LOCAL_BUILD Freight, promotes it
 * into the deployment Camp and an in-process conductor converges it.
 */
export async function cdYardDelivery(runtime: CdRuntime) {
	// binds at merge (plan 0024): the manifest codec is WP1.
	const { parseFreightManifest, writeFreightManifest } = await import(
		"@hobo/cd/freight"
	);
	return Object.freeze({
		cd: {
			freight: runtime.cd.freight,
			artifacts: runtime.cd.artifacts,
			desired: runtime.cd.desired,
			promotions: runtime.cd.promotions,
			createReconciler: runtime.cd.createReconciler,
		},
		freightManifest: {
			write: writeFreightManifest,
			parse: (bytes: Uint8Array) => parseFreightManifest(bytes),
		},
		telemetry: runtime.cd.sink,
		now: runtime.ctx.now,
	});
}

/** Attach CD delivery to a Yard runtime (D13). The Yard and CD share one journal. */
export function attachCdDelivery<R extends object, D>(
	yardRuntime: R,
	delivery: D,
): R & Readonly<{ delivery: D }> {
	// binds at merge (plan 0024): YardRuntime.delivery is WP15's field.
	return Object.freeze({ ...yardRuntime, delivery });
}

// public-contract: env var naming the @hobo/cd-kube-fleet config file (D26).
export const CD_KUBE_FLEET_ENV = "HOBO_CD_KUBE_FLEET";

/**
 * When HOBO_CD_KUBE_FLEET names a JSON file, wire `@hobo/cd-kube-fleet`
 * (D26): `{ "ocm": OcmRealizerRecord } | { "karmada": KarmadaRealizerRecord }`
 * as the conductor realizer, plus an optional `clusterProfiles`
 * ClusterProfileImportRecord imported as OBSERVE_ONLY Camps. Fleet managers
 * are transports and inventory, never schedulers.
 */
async function openKubeFleet(
	input: Readonly<{
		env: Readonly<Record<string, string | undefined>>;
		cwd: string;
		http: HttpTransport;
		credentials: CredentialResolver;
		now: () => number;
	}>,
): Promise<
	| Outcome<
			Readonly<{
				realizer?: (scope: ComposedContinuousDelivery["scope"]) => Realizer;
				topology?: TopologyReader;
			}>
	  >
	| undefined
> {
	const file = input.env[CD_KUBE_FLEET_ENV]?.trim();
	if (!file) return undefined;
	try {
		const { readFile } = await import("node:fs/promises");
		const { resolve } = await import("node:path");
		const parsed: unknown = JSON.parse(
			await readFile(resolve(input.cwd, file), "utf8"),
		);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error(`${file} must hold a JSON object`);
		// SAFETY: a JSON object, parsed member by member by @hobo/cd-kube-fleet below.
		const config = parsed as Record<string, CdJsonObject | undefined>;
		// binds at merge (plan 0024): @hobo/cd-kube-fleet is WP25.
		const fleet = await import("@hobo/cd-kube-fleet");
		const deps = { http: input.http, credentials: input.credentials };
		let realizer:
			| ((scope: ComposedContinuousDelivery["scope"]) => Realizer)
			| undefined;
		if (config.ocm && config.karmada)
			throw new Error("configure exactly one of ocm or karmada per Station");
		if (config.ocm) {
			const parsedConfig = fleet.parseOcmRealizerConfig(config.ocm);
			realizer = (scope) =>
				fleet.ocmRealizer({
					...deps,
					config: parsedConfig,
					telemetry: scope.telemetry,
					observeFields: (campId: CampId) =>
						scope.posture.observeFields(campId),
				});
		} else if (config.karmada) {
			const parsedConfig = fleet.parseKarmadaRealizerConfig(config.karmada);
			realizer = (scope) =>
				fleet.karmadaRealizer({
					...deps,
					config: parsedConfig,
					telemetry: scope.telemetry,
					observeFields: (campId: CampId) =>
						scope.posture.observeFields(campId),
				});
		}
		let topology: TopologyReader | undefined;
		if (config.clusterProfiles) {
			const inventory = fleet.clusterProfileInventory({
				...deps,
				config: fleet.parseClusterProfileImport(config.clusterProfiles),
				now: input.now,
			});
			await inventory.list();
			topology = inventory.topology();
		}
		return {
			ok: true,
			value: {
				...(realizer ? { realizer } : undefined),
				...(topology ? { topology } : undefined),
			},
		};
	} catch (error) {
		return refusal(
			"cd-kube-fleet-invalid",
			error instanceof Error ? error.message : String(error),
			"Fix the HOBO_CD_KUBE_FLEET file: one of ocm|karmada realizer records, and optionally clusterProfiles (see packages/hobo/CD.md).",
		);
	}
}

/** The `--camp` list of `agent run`. */
function campsOf(flags: CdJsonObject): CampId[] {
	const value = flags.camp;
	// SAFETY: opaque Camp ids; the feed refuses Camps the agent was not accepted for.
	return (typeof value === "string" ? value : "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "") as CampId[];
}

/** `hobo deploy agent run`: an agent-mode reconciler loop until SIGINT/SIGTERM. */
async function runAgentProcess(
	input: Readonly<{
		flags: CdJsonObject;
		cwd: string;
		realizer: Realizer;
		store: DurableEventStore;
		tenant: string;
		now: () => number;
		http: HttpTransport;
		env: Readonly<Record<string, string | undefined>>;
	}>,
): Promise<Outcome<Readonly<{ reconcilerId: string; stoppedAt: string }>>> {
	const text = (name: string) => {
		const v = input.flags[name];
		return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
	};
	const feedUrl = text("feed");
	const reconcilerId = text("reconciler");
	const keyFile = text("key-file");
	const svidFile = text("svid-file");
	const camps = (text("camp") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (
		!feedUrl?.startsWith("https://") ||
		!reconcilerId ||
		!keyFile ||
		!svidFile ||
		camps.length === 0
	)
		return refusal(
			"agent-run-usage",
			"agent run needs --feed https://…/v1/cd/, --reconciler, --key-file, --svid-file and --camp",
			"hobo deploy agent run --feed <https://station/v1/cd/> --reconciler <id> --key-file <private.jwk.json> --svid-file <svid> --camp <a,b>",
		);
	const { readFile } = await import("node:fs/promises");
	const { resolve } = await import("node:path");
	const parsedKey: unknown = JSON.parse(
		await readFile(resolve(input.cwd, keyFile), "utf8"),
	);
	if (
		typeof parsedKey !== "object" ||
		parsedKey === null ||
		Array.isArray(parsedKey)
	)
		return refusal(
			"agent-jwk-invalid",
			`${keyFile} is not a JWK object`,
			"Pass the agent's private JWK file; it never leaves the agent.",
		);
	const svid = (await readFile(resolve(input.cwd, svidFile), "utf8")).trim();
	const reconciler = agentReconciler({
		feedUrl,
		reconcilerId,
		// SAFETY: checked to be a JSON object above.
		privateJwk: parsedKey as CdJsonObject,
		svid,
		// SAFETY: opaque Camp ids; the feed refuses Camps the agent was not accepted for.
		campIds: camps as CampId[],
		realizer: input.realizer,
		store: input.store,
		tenant: input.tenant,
		now: input.now,
		http: input.http,
		...(input.env.OTEL_EXPORTER_OTLP_ENDPOINT
			? { telemetryEndpoint: input.env.OTEL_EXPORTER_OTLP_ENDPOINT }
			: undefined),
	});
	const abort = new AbortController();
	const stop = () => abort.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await reconciler.run(abort.signal);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
	return {
		ok: true,
		value: { reconcilerId, stoppedAt: new Date(input.now()).toISOString() },
	};
}
