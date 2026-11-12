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
import {
	type CampId,
	type CampReconciler,
	type CdContext,
	type CredentialResolver,
	type FreightRecord,
	type Outcome,
	type Realizer,
	ReasonRecordSchema,
	type ReconcilerId,
	ReconcilerMode,
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
	parseCdComposeConfig,
} from "@hobo/cd/compose";
// binds at merge (plan 0024): drift routing is WP7.
import { createDriftPolicy } from "@hobo/cd/reconcile";
import { createRegistryFromProviders, type PlannerRegistry } from "@hobo/cloud";
import type { PolicyPack } from "@hobo/contracts";
import {
	type JsonObject as CdJsonObject,
	createBoundedFetchTransport,
	type DurableEventStore,
	type HttpTransport,
	type PrincipalRef,
} from "@hobo/core";
import type { Yard } from "@hobo/yards";
import type { CdDeployHost } from "./cd-deploy.js";
import { type CdStoreOpener, openCdStore } from "./cd-store.js";
import {
	mergeTopologyReaders,
	staticTopologyReader,
	yardTopology,
} from "./cd-topology.js";

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
	trustPolicy?: CdJsonObject;
	readCiEvents?: Parameters<
		typeof composeContinuousDelivery
	>[0]["readCiEvents"];
	readCiArtifact?: Parameters<
		typeof composeContinuousDelivery
	>[0]["readCiArtifact"];
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
		staticTopologyReader(yardTopology(options.yards ?? [], config.stationId)),
		...(kube?.value.topology ? [kube.value.topology] : []),
		...(options.topology ?? []),
	]);
	const railCatalog = createJournalRailCatalog({ store });
	// binds at merge (plan 0024): the baseline delivery policy pack (WP19).
	const policyPack = options.policyPack ?? createCdBaselinePack();
	const resolvePack = options.resolvePack ?? (async () => policyPack);
	const realizers: CdHostInputs["realizers"] = {
		...(config.simulate
			? { conductor: () => createSimulatedRealizer() }
			: undefined),
		...(kube?.value.realizer ? { conductor: kube.value.realizer } : undefined),
		...options.realizers,
	};
	const registry = options.registry;
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
			async declaration(freight: FreightRecord) {
				const bytes = await cd.artifacts.get(
					freight.manifest?.declarationHash as `sha256:${string}`,
				);
				if (!bytes) return undefined;
				const { parseManifest } = await import("@hobo/bindles");
				return parseManifest(JSON.parse(new TextDecoder().decode(bytes)));
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
	const cd = composeContinuousDelivery({
		base,
		factories: defaultCdFactories,
		adapters: defaultCdAdapters(host),
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
			: undefined),
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
					const realizer = config.simulate
						? createSimulatedRealizer()
						: kube?.value.realizer?.(cd.scope);
					if (!realizer)
						return refusal(
							"compose-realizer-missing",
							"no agent-local realizer is configured",
							"Configure HOBO_CD_KUBE_FLEET (or another agent-local realizer) on the target, or pass --simulate.",
						);
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

function emptyRegistry(): PlannerRegistry {
	// No providers: Matching finds no offering and the planning adapter
	// refuses with a typed reason, never an invented provider.
	return createRegistryFromProviders([]);
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
		baseUrl: input.feedUrl,
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
		telemetry: defaultCdFactories.createTelemetrySink({
			http,
			...(input.telemetryEndpoint
				? { endpoint: input.telemetryEndpoint }
				: undefined),
		}),
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
