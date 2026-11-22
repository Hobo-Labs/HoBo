/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */

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
import {
	type CdSecretReader,
	type CdStoreOpener,
	openCdStore,
} from "./cd-store.js";
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
	home: string;
	cwd: string;
	simulate: boolean;
	now?: () => number;
	principal?: PrincipalRef;
	store?: DurableEventStore;
	openStore?: CdStoreOpener;
	/**
	 * Reads the owner's secret store (a fleet member's connection string); a
	 * journal on a fleet cannot open without it.
	 */
	readSecret?: CdSecretReader;
	yards?: readonly Yard[];
	topologyFiles?: readonly string[];
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
	fanoutCost?: FanoutCostAuthority;
	trustPolicy?: CdJsonObject;
	readCiEvents?: Parameters<
		typeof composeContinuousDelivery
	>[0]["readCiEvents"];
	readCiArtifact?: Parameters<
		typeof composeContinuousDelivery
	>[0]["readCiArtifact"];
	runnerHost?: RunnerHostPorts;
	sleep?: (ms: number) => Promise<void>;
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

export function cdPrincipal(
	env: Readonly<Record<string, string | undefined>>,
): PrincipalRef {
	const agent = env.HOBO_AGENT_ID?.trim();
	if (agent) return { kind: "agent", id: agent };
	const user = env.HOBO_USER?.trim() || env.USER?.trim() || "local-operator";
	return { kind: "user", id: user };
}

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
	const files = options.topologyFiles ?? [];
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
			opened = await (options.openStore ?? openCdStore)(
				config.store,
				{ now },
				options.readSecret,
			);
		} catch (error) {
			return refusal(
				"cd-store-unavailable",
				error instanceof Error ? error.message : String(error),
				config.store.backend === "postgres-fleet"
					? "Keep each member's connection string in the secret store (entry HOBO_CD_POSTGRES_URL_<ID>), give the runtime access to the store, and check that a majority of members and witnesses are reachable on PostgreSQL 16 or later."
					: config.store.backend === "postgres"
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
	const policyPack = options.policyPack ?? createCdBaselinePack();
	const resolvePack = options.resolvePack ?? (async () => policyPack);
	const catalogCamps = (await declaredTopology.camps()).filter(
		(camp) => catalogRealizedProvider(camp.provider) !== undefined,
	);
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
	const plannerProviders = [
		...catalogPlannerProviders(catalogCamps),
		...runnerHostPlannerProviders(await declaredTopology.camps()),
	];
	const registry =
		options.registry ??
		(plannerProviders.length > 0
			? createRegistryFromProviders(plannerProviders)
			: undefined);
	const sourceBound = new WeakMap<object, `sha256:${string}`>();
	const host: CdHostInputs = {
		store,
		railCatalog,
		resolvePack,
		packs: options.packs ?? (async () => []),
		realizers,
		...(options.routing ? { routing: options.routing } : undefined),
		planning: {
			registry: registry ?? emptyRegistry(),
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
			contracts: async () => ({ deployed: [], candidate: [] }),
			subject: async () => ({ classifications: [], residency: [] }),
			...options.gate,
		},
	};
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
			resolver: (scope) =>
				withRunnerHostRealization(adapters.resolver(scope), scope.desired),
			suites: (scope) =>
				createRunnerHostVerifySuite({
					desired: scope.desired,
					inventory: scope.inventory,
					otherwise: adapters.suites?.(scope) ?? unconfiguredSuites(),
				}),
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
	return createRegistryFromProviders([]);
}

export function stationOriginOf(feedUrl: string): string {
	try {
		const url = new URL(feedUrl);
		if (
			(url.pathname === "/v1/cd/" || url.pathname === "/v1/cd") &&
			!url.search &&
			!url.hash
		)
			return url.origin;
	} catch {}
	return feedUrl;
}

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

export async function cdYardDelivery(runtime: CdRuntime) {
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

export function attachCdDelivery<R extends object, D>(
	yardRuntime: R,
	delivery: D,
): R & Readonly<{ delivery: D }> {
	return Object.freeze({ ...yardRuntime, delivery });
}

export const CD_KUBE_FLEET_ENV = "HOBO_CD_KUBE_FLEET";

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
		const config = parsed as Record<string, CdJsonObject | undefined>;
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

function campsOf(flags: CdJsonObject): CampId[] {
	const value = flags.camp;
	return (typeof value === "string" ? value : "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "") as CampId[];
}

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
		privateJwk: parsedKey as CdJsonObject,
		svid,
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
