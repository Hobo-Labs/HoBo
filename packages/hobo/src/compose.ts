import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

interface HostContext {
	callImport: (
		importInterface: InterfaceId,
		operation: string,
		payload?: JsonValue,
	) => Promise<JsonValue>;
}

interface IncomingHttpRequest {
	readonly method: string;
	readonly path: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body: string;
}

function hostContextFrom(value: JsonValue | undefined): HostContext {
	if (!isJsonObject(value)) {
		throw new Error("component host context missing");
	}
	const callImport = Object.getOwnPropertyDescriptor(
		value,
		"callImport",
	)?.value;
	if (!(callImport instanceof Function)) {
		throw new Error("component host context missing callImport");
	}
	return { callImport };
}

function incomingHttpRequestFrom(
	value: JsonValue | undefined,
): IncomingHttpRequest {
	if (!isJsonObject(value)) {
		throw new Error("incoming http request missing");
	}
	const method = isJsonString(value.method) ? value.method : "GET";
	const path = isJsonString(value.path) ? value.path : "/";
	const body = isJsonString(value.body) ? value.body : "";
	const headers = Array.isArray(value.headers)
		? value.headers.flatMap((entry) => {
				if (!Array.isArray(entry) || entry.length < 2) return [];
				const name = entry[0];
				const headerValue = entry[1];
				if (!isJsonString(name) || !isJsonString(headerValue)) return [];
				return [[name, headerValue] as const];
			})
		: [];
	return { method, path, headers, body };
}

import { basename, isAbsolute } from "node:path";
import type {
	BindleDefinition,
	CollectionContext,
	CollectionTarget,
} from "@hobo/bindles";
import {
	type DevRuntime,
	loadBindleDefinition,
	loadProjectCollectionTarget,
	type YardRuntime,
} from "@hobo/cli";
import type { IacProvider } from "@hobo/cloud";
import {
	approveProviderFact,
	collectStream,
	createEventBackedRegistry,
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
	foldRegistryStream,
	type PlannerRegistry,
	type RegistrableProvider,
	registerProviderFact,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import type {
	CloudProvider,
	ComponentHostEvent,
	DurableEventStore,
	EventStore,
	HttpTransport,
	InterfaceId,
	ParsedComponentDescriptor,
	ProviderDescriptor,
} from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createPulumiAutomationAdapter,
	createPulumiAutomationApiEngine,
	createPulumiCliAutomationEngine,
} from "@hobo/iac-pulumi";
import {
	cloudflareResolverRegistry,
	createCloudflareProvider,
	guardedCloudflareTransport,
} from "@hobo/provider-cloudflare";
import { vercelResolverRegistry } from "@hobo/provider-vercel";
import {
	createLocalStreamer,
	createManualClock,
	createRuntimeLocalComponentHost,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { REGISTRY_STREAM } from "./add-command.js";
import type { CloudflareFetch } from "./cloudflare-client.js";
import {
	refuseUnbrokeredLane,
	requireOpenSesameSurrogate,
	usesOpenSesameCredentials,
} from "./credentials-opensesame.js";
import {
	createProductionHostingExecution,
	type ProductionHostingExecutionOptions,
} from "./hosting-execution.js";
import { ownedTempDir } from "./owned-temp-dir.js";
import {
	createPulumiBackedIacProvider,
	type PulumiAutomationAdapter,
} from "./pulumi-iac-provider.js";
import {
	createFetchHttpTransport,
	createResolverBackedIacProvider,
} from "./resolver-iac-provider.js";
import type { FetchHandler } from "./servable-entrypoints.js";

function asFetchHandler(
	value: FetchHandler | JsonValue | undefined,
): FetchHandler | null {
	if (!(value instanceof Function)) {
		return null;
	}
	// SAFETY: Bindle entrypoint returned a fetch handler at the serve boundary.
	return value as FetchHandler;
}

import type { VercelFetch } from "./vercel-client.js";
import { normalizeVercelTeamId } from "./vercel-client.js";

// @hobo/hobo — the composition root (apps layer). It wires HoBo's default
// runtimes so the composed `hobo` binary runs the cloud verbs end to end in the
// LOCAL/MOCKED lane. Every constructor below is REUSED from an adapter/runtime
// package; nothing here reimplements a command or a runtime — this is pure
// composition. Importing adapters here is INWARD (layer 3 -> layer 2) and
// boundary-legal, which is exactly why the default wiring lives at this root
// rather than inside adapter-free `@hobo/cli`.

// ---------------------------------------------------------------------------
// The REAL IaC backend on the deploy path.
//
// The default runtime now drives the REAL @hobo/iac-pulumi adapter via the REAL
// @hobo/provider-cloudflare `realize()` — see `createPulumiBackedIacProvider`.
// The kernel Executor still speaks its shape-A `IacProgram` execution descriptor;
// the bridge resolves each resource's real ResourcePlan from the durable
// `deployment.Planned` fact, lowers it with `provider.realize()` to a
// `hobo.iac-program/v1` program, and applies it through the real adapter. There
// is NO mock IacProvider. HONEST SCOPE: the DEFAULT backend is the in-memory
// Automation-API stand-in (offline, deterministic); `HOBO_PULUMI_LIVE=1` swaps
// in the REAL Pulumi Automation API engine (@pulumi/pulumi LocalWorkspace,
// HOBO-715 — engine-binary- and credential-gated), with
// `HOBO_PULUMI_LIVE_ENGINE=cli` (or the HOBO_PULUMI_BIN test seam) selecting
// the pinned `pulumi` CLI engine instead — see selectIacProvider and the
// deploy-hello-bindle-pulumi workflow lane.

// @hobo/provider-cloudflare types its capability-manifest fields more loosely
// (PublishedManifestDocuments / JsonObject) than @hobo/cloud's
// RegistrableProvider narrows them (Record<string, string> / arrays). The runtime
// shapes already line up — the @hobo/cloud + @hobo/cli registry tests drive
// exactly this provider — so this composition-root adapter simply re-presents the
// CloudProvider as a RegistrableProvider without changing any behavior.
export function toRegistrableProvider(
	// Structural pick: registration needs the manifest surface only, so
	// providers whose realize() emits a driver program (e.g. Lakebed,
	// ADR-0127) register through the same seam as IaC-realizing providers.
	provider: Pick<
		CloudProvider,
		"id" | "regions" | "capabilities" | "capabilityManifest"
	>,
): RegistrableProvider {
	return {
		id: provider.id,
		regions: [...provider.regions],
		capabilities: provider.capabilities,
		capabilityManifest: () => {
			const manifest = provider.capabilityManifest();
			return {
				providerId: manifest.providerId,
				// PublishedManifestDocuments has four fixed string keys but no index
				// signature, so TS needs the unknown hop to reach Record<string, string>.
				// SAFETY: assertion required at this I/O or test boundary.
				published: manifest.published as Record<string, string>,
				// SAFETY: assertion required at this I/O or test boundary.
				capabilities: manifest.capabilities as {
					capabilities?: Array<JsonObject>;
				},
				// SAFETY: assertion required at this I/O or test boundary.
				cost: manifest.cost as { facts?: Array<JsonObject> },
			};
		},
	};
}

export interface DefaultYardRuntimeOptions {
	// Durable event-store data directory. Defaults to a fresh OS temp dir
	// (`hobo-yard-*`; the mocked lane is ephemeral) that this process owns and
	// removes when it exits, an uncaught error included (owned-temp-dir.ts), so no
	// caller, binary or library, leaves one behind on a normal end. On a signal it
	// is removed where the entry point asked for that (`removeOwnedDirsOnSignals`,
	// as both binaries do); a library leaves its host's signals alone. A directory
	// given here is the caller's and is never removed: provide a stable one to
	// inspect the event log across runs. Callers that create the runtime directly
	// own closing `runtime.store` when done.
	readonly dataDir?: string;
	// The @hobo/iac-pulumi adapter the deploy path drives. Defaults to a fresh
	// real `createPulumiAutomationAdapter()` (in-memory backend). Injectable so a
	// test can observe/spy the real adapter the composed `up`/`down` runs.
	//
	// NOTE: providing this override FORCES the in-memory Pulumi-backed provider
	// even when `VERCEL_TOKEN` is set — the adapter is a Pulumi adapter, so the
	// override is only meaningful on that lane. Env-based Vercel selection applies
	// to the DEFAULT (un-overridden) path.
	readonly iacAdapter?: PulumiAutomationAdapter;
	// The environment consulted for deploy credentials (`VERCEL_TOKEN`,
	// `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`). Defaults to `process.env`.
	// Inject a snapshot to drive the REAL Vercel/Cloudflare deploy lane through
	// the composed runtime without mutating the ambient process environment.
	readonly env?: Record<string, string | undefined>;
	// Injected transport for the Vercel client. Lets a test prove `hobo up` routes
	// end to end into the real Vercel provider's HTTP call without a live token or
	// a real socket (mock records the request). Ignored on the in-memory lane.
	readonly vercelFetch?: VercelFetch;
	// Injected transport for the Cloudflare client — same purpose as `vercelFetch`
	// for the Cloudflare Workers deploy lane.
	readonly cloudflareFetch?: CloudflareFetch;
}

export interface SelectIacProviderDeps {
	// The durable event store the Pulumi-backed provider reads plans from.
	readonly store: EventStore;
	// The real CloudProviders whose `realize()` the Pulumi bridge drives.
	readonly providers: readonly CloudProvider[];
	// Optional Pulumi adapter override (forces the Pulumi lane; see above).
	readonly adapter?: PulumiAutomationAdapter;
	// The environment consulted for `VERCEL_TOKEN` (and `VERCEL_TEAM_ID` /
	// `VERCEL_ORG_ID`) /
	// `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Defaults to `process.env`.
	readonly env?: Record<string, string | undefined>;
	// Optional injected transport for the Vercel client (tests mock the network).
	readonly vercelFetch?: VercelFetch;
	// Optional injected transport for the Cloudflare client (tests mock the network).
	readonly cloudflareFetch?: CloudflareFetch;
	// Optional injected HTTP transport for the exact-resource resolver plane. Defaults to a `globalThis.fetch` adapter. Inject
	// a fake to drive the REAL resolvers over a modelled provider account without
	// a live token or a real socket.
	readonly resolverTransport?: HttpTransport;
}

// Per-store, per-lane Pulumi adapter memo. Sharing ONE adapter (and therefore
// ONE state backend) across every command that composes against the same event
// store is what makes `hobo drift`/`hobo import` able to read the estate a
// prior `hobo up` actually provisioned — in the same process on the in-memory
// lane, and against a stable `HOBO_PULUMI_WORKDIR` on the live CLI lane.
const pulumiAdaptersByStore = new WeakMap<
	EventStore,
	Map<string, PulumiAutomationAdapter>
>();

function memoizedPulumiAdapter(
	store: EventStore,
	lane: "memory" | "live",
	create: () => PulumiAutomationAdapter,
): PulumiAutomationAdapter {
	let byLane = pulumiAdaptersByStore.get(store);
	if (byLane === undefined) {
		byLane = new Map();
		pulumiAdaptersByStore.set(store, byLane);
	}
	let adapter = byLane.get(lane);
	if (adapter === undefined) {
		adapter = create();
		byLane.set(lane, adapter);
	}
	return adapter;
}

// The live lane's workspace when HOBO_PULUMI_WORKDIR names none: a directory of
// this process's own, which no later run could find, removed when it exits, and
// on a signal in the binaries (owned-temp-dir.ts). Its file:// state is the
// only record of what the lane deployed, so that is said once, on stderr.
function temporaryLiveWorkDir(): string {
	const dir = ownedTempDir("hobo-pulumi-live-");
	process.stderr.write(
		`hobo: the live Pulumi lane keeps its programs and state in ${dir}, which is removed when this process ends; set HOBO_PULUMI_WORKDIR to a directory to keep them\n`,
	);
	return dir;
}

// Resolve the SHARED Pulumi adapter (the estate seam) for this store + env, or
// `undefined` when the environment selects a non-Pulumi deploy provider
// (Cloudflare/Vercel) whose state HoBo holds in the DeploymentView instead.
// An explicit `adapter` override always wins and is memoized so later callers
// (drift/import) observe the same backend the deploy path drove.
export function selectPulumiEstateAdapter(
	deps: Pick<SelectIacProviderDeps, "store" | "env" | "adapter">,
): PulumiAutomationAdapter | undefined {
	const env = deps.env ?? process.env;
	if (deps.adapter !== undefined) {
		const byLane = pulumiAdaptersByStore.get(deps.store) ?? new Map();
		byLane.set("memory", deps.adapter);
		pulumiAdaptersByStore.set(deps.store, byLane);
		return deps.adapter;
	}
	if (env.HOBO_PULUMI_LIVE === "1") {
		// Under OpenSesame (ADR-0170) the live lane is refused: its engine would
		// authenticate with credentials found outside OpenSesame.
		refuseUnbrokeredLane(env);
		return memoizedPulumiAdapter(deps.store, "live", () => {
			// HOBO_PULUMI_WORKDIR keeps the lane's programs and file:// state, and is
			// never removed.
			const workDir = env.HOBO_PULUMI_WORKDIR ?? temporaryLiveWorkDir();
			// Default live engine = the REAL Pulumi Automation API (LocalWorkspace,
			// HOBO-715). `HOBO_PULUMI_LIVE_ENGINE=cli` keeps the pinned CLI engine;
			// the HOBO_PULUMI_BIN test seam implies the CLI engine (the Automation
			// API embeds its own engine and takes no binary override).
			const useCliEngine =
				env.HOBO_PULUMI_LIVE_ENGINE === "cli" ||
				env.HOBO_PULUMI_BIN !== undefined;
			const engine = useCliEngine
				? createPulumiCliAutomationEngine({
						workDir,
						env,
						// Test seam mirroring the engine's own binary gate: point at a
						// non-existent binary to exercise the typed fail-closed path.
						...(env.HOBO_PULUMI_BIN !== undefined
							? { pulumiBin: env.HOBO_PULUMI_BIN }
							: undefined),
					})
				: createPulumiAutomationApiEngine({ workDir, env });
			// SAFETY: assertion required at this I/O or test boundary.
			return createPulumiAutomationAdapter({
				engine,
			}) as PulumiAutomationAdapter;
		});
	}
	if (
		(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) ||
		env.VERCEL_TOKEN
	) {
		return undefined;
	}
	return memoizedPulumiAdapter(
		deps.store,
		"memory",
		// SAFETY: assertion required at this I/O or test boundary.
		() => createPulumiAutomationAdapter() as PulumiAutomationAdapter,
	);
}

// domain-view: one resource's state as read from the IaC state backend (the
// estate). A parsed, derived view over the adapter's loose snapshot shape so
// drift/import consume trusted records instead of re-checking DTO fields.
export interface EstateResourceState {
	readonly resource: string;
	readonly stackKey: string;
	readonly externalId: string;
	readonly status: string;
	readonly outputs: JsonObject;
}

// Read the estate the adapter's state backend holds for one deployment (its
// per-resource stacks are keyed `${deploymentId}/${resourceName}`). Parse,
// don't validate: loose snapshot records become frozen EstateResourceState
// derived values. Propagates the engine's typed fail-closed errors (e.g.
// PulumiEngineUnavailableError when the live pulumi binary is missing).
export function readPulumiEstate(
	adapter: PulumiAutomationAdapter,
	deploymentId: string,
): readonly EstateResourceState[] {
	if (!(adapter.snapshotState instanceof Function)) {
		return [];
	}
	const snapshot = adapter.snapshotState();
	const estate: EstateResourceState[] = [];
	for (const [stackKey, state] of Object.entries(snapshot)) {
		if (!stackKey.startsWith(`${deploymentId}/`)) {
			continue;
		}
		const resources =
			// SAFETY: assertion required at this I/O or test boundary.
			(state as { resources?: JsonObject } | undefined)?.resources ?? {};
		for (const [resource, record] of Object.entries(resources)) {
			// SAFETY: assertion required at this I/O or test boundary.
			const parsed = record as {
				id?: unknown;
				status?: unknown;
				outputs?: JsonObject;
			};
			estate.push(
				Object.freeze({
					resource,
					stackKey,
					externalId: isJsonString(parsed.id)
						? parsed.id
						: `pulumi:${stackKey}`,
					status: isJsonString(parsed.status) ? parsed.status : "provisioned",
					outputs: Object.freeze({ ...parsed.outputs }),
				}),
			);
		}
	}
	return estate.sort((a, b) => a.resource.localeCompare(b.resource));
}

// Credential LOCATORS for the resolver lane. The composition root is the host:
// it read the env var, so it holds the material and hands the resolvers only a
// name for it. These locators use the `hobo-token` scheme because that is what
// `@hobo/bindings`' `parseSecretRef` (which the Vercel resolvers apply) accepts.
// Under `HOBO_CREDENTIALS=opensesame` (ADR-0170) the material is the run's `osr_`
// surrogate, not a token: the process was relaunched under OpenSesame's proxied
// run (credentials-opensesame.ts), `VERCEL_TOKEN` holds what only its proxy can
// redeem at api.vercel.com, and `fetch` reaches it through `HTTPS_PROXY`
// (`NODE_USE_ENV_PROXY=1`). Nothing below changes for that; selectIacProvider
// only refuses to start a lane on anything but a surrogate.
const CLOUDFLARE_RESOLVER_CREDENTIAL_REF = "hobo-token://cloudflare/api-token";
const VERCEL_RESOLVER_CREDENTIAL_REF = "hobo-token://vercel/deploy";

// The host half of the credential law: resolve exactly one locator, and refuse
// any other rather than serving the wrong token to whoever asked. The material
// lives only in this closure — it never reaches a record, a plan, or a log.
function hostCredentialResolver(
	locator: string,
	material: string,
): (asked: string) => Promise<string> {
	return async (asked: string): Promise<string> => {
		if (asked !== locator) {
			throw new Error(
				`unknown credential locator ${JSON.stringify(asked)}: this host answers for ${JSON.stringify(locator)} only`,
			);
		}
		return material;
	};
}

// The Vercel team the environment names: `VERCEL_TEAM_ID` (the name
// `scripts/staging-cutover-demo.mts` already uses), else `VERCEL_ORG_ID`
// (the Vercel CLI's) when it is a team id. Each is trimmed and taken as unset
// when blank, the rule `createVercelClient` and `createVercelDeployProvider`
// apply to their own `teamId`; `undefined` when neither names a team. The
// Vercel resolver plane reads it, and the resolvers compare it with the
// canonical `team_…` accountId Vercel returns, so a slug or bare `team_`
// here would read as a different team on every later read: refuse it now,
// before anything is sent, instead of after a create succeeded.
function vercelTeamIdOf(
	env: Record<string, string | undefined>,
): string | undefined {
	const named = normalizeVercelTeamId(env.VERCEL_TEAM_ID);
	if (named !== undefined) {
		if (named === "team_" || !named.startsWith("team_")) {
			throw new Error(
				"VERCEL_TEAM_ID must be the canonical team id (team_ and the rest), not a slug, a name, or a bare team_: nothing was sent to Vercel. Set VERCEL_TEAM_ID to the team_ id, or unset it to work in the token's own scope",
			);
		}
		return named;
	}
	return vercelOrgTeamIdOf(env.VERCEL_ORG_ID);
}

// The Vercel CLI writes the id of the team or of the personal account a
// directory is linked to into `VERCEL_ORG_ID`, and the Vercel CLI treats an
// `orgId` that starts with `team_` as a team and any other as the user (its
// `getOrgById`, packages/cli/src/util/projects/get-org-by-id.ts in
// vercel/vercel). So does this: anything else is an account's, and an account
// is not a team, so it is no `teamId` at all. A bare `team_` is neither, and is
// refused here rather than sent as `?teamId=team_`. Read only when
// `VERCEL_TEAM_ID` names no team.
function vercelOrgTeamIdOf(orgId: string | undefined): string | undefined {
	const id = normalizeVercelTeamId(orgId);
	if (id === "team_") {
		throw new Error(
			'VERCEL_ORG_ID is "team_" with no id after it, so it names no team and no account: nothing was sent to Vercel. Set VERCEL_ORG_ID to the whole team id the Vercel CLI wrote (team_ and the rest), or set VERCEL_TEAM_ID',
		);
	}
	return id?.startsWith("team_") ? id : undefined;
}

// Build the exact-artifact resolver-backed deploy provider for whichever cloud the
// environment has credentials for, or `undefined` when it has none. Cloudflare
// resolvers take a transport the host must wrap in the Cloudflare guard policy;
// the Vercel resolvers apply their own guard internally, so the raw transport is
// handed over there and wrapped once rather than twice.
function resolverBackedProviderFor(
	deps: SelectIacProviderDeps,
	env: Record<string, string | undefined>,
): IacProvider | undefined {
	const transport =
		deps.resolverTransport ?? createFetchHttpTransport(globalThis.fetch);
	const cloudflareToken = env.CLOUDFLARE_API_TOKEN;
	const cloudflareAccountId = env.CLOUDFLARE_ACCOUNT_ID;
	if (cloudflareToken && cloudflareAccountId) {
		return createResolverBackedIacProvider({
			store: deps.store,
			registry: cloudflareResolverRegistry({
				accountId: cloudflareAccountId,
				resolveCredential: hostCredentialResolver(
					CLOUDFLARE_RESOLVER_CREDENTIAL_REF,
					cloudflareToken,
				),
			}),
			transport: guardedCloudflareTransport(transport),
			credentialRef: CLOUDFLARE_RESOLVER_CREDENTIAL_REF,
		});
	}
	const vercelToken = env.VERCEL_TOKEN;
	if (vercelToken) {
		const teamId = vercelTeamIdOf(env);
		return createResolverBackedIacProvider({
			store: deps.store,
			registry: vercelResolverRegistry({
				resolveCredential: hostCredentialResolver(
					VERCEL_RESOLVER_CREDENTIAL_REF,
					vercelToken,
				),
				...(teamId !== undefined ? { teamId } : undefined),
			}),
			transport,
			credentialRef: VERCEL_RESOLVER_CREDENTIAL_REF,
		});
	}
	return undefined;
}

// Live credentials select the exact-resource resolver plane. Fixture upload
// helpers are explicitly opt-in demonstrations and never selected here.
//
// The Vercel resolver plane works in the team `VERCEL_TEAM_ID`, else a `team_`
// `VERCEL_ORG_ID`, names, or in the token's own scope when neither does
// (`vercelTeamIdOf`).
export function selectIacProvider(deps: SelectIacProviderDeps): IacProvider {
	const env = deps.env ?? process.env;
	if (usesOpenSesameCredentials(env)) requireOpenSesameSurrogate(env);
	const estateAdapter = selectPulumiEstateAdapter(deps);
	if (estateAdapter !== undefined) {
		return createPulumiBackedIacProvider({
			store: deps.store,
			providers: deps.providers,
			adapter: estateAdapter,
		});
	}
	const resolverBacked = resolverBackedProviderFor(deps, env);
	if (resolverBacked !== undefined) return resolverBacked;
	throw new Error(
		"live hosting requires an exact provider resolver configuration",
	);
}

// Assemble the default `YardRuntime` the cloud verbs (plan/up/down) drive. This
// mirrors the composition the @hobo/cloud orchestrator + @hobo/cli cloud-verb
// tests use: a runtime-local event store (manual clock), an in-memory actor
// host, the in-process executor over the real @hobo/iac-pulumi adapter with its
// DEFAULT in-memory stand-in backend (not live cloud apply), the in-process
// credential broker, and a provider registry built from the real
// @hobo/provider-cloudflare provider. LOCAL lane — no real cloud calls unless
// HOBO_PULUMI_LIVE / cloud tokens unlock the credential-gated path.
export function createDefaultYardRuntime(
	options: DefaultYardRuntimeOptions = {},
): YardRuntime {
	const dataDir = options.dataDir ?? ownedTempDir("hobo-yard-");
	const store = createRuntimeLocalEventStore({
		dataDir,
		clock: createManualClock(),
	});
	return createYardRuntimeOverStore(options, store);
}

function createYardRuntimeOverStore(
	options: DefaultYardRuntimeOptions,
	store: ReturnType<typeof createRuntimeLocalEventStore>,
): YardRuntime {
	// One CloudProvider instance, shared between the planner registry (capability
	// negotiation) and the IaC bridge (realize() on the deploy path).
	const cloudflare = createCloudflareProvider();
	const environment = options.env ?? process.env;
	const hostingBudgetRequired =
		options.iacAdapter === undefined &&
		(environment.HOBO_PULUMI_LIVE === "1" ||
			Boolean(
				environment.CLOUDFLARE_API_TOKEN && environment.CLOUDFLARE_ACCOUNT_ID,
			) ||
			Boolean(environment.VERCEL_TOKEN));
	return {
		hostingBudgetRequired,
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({
			// Env-gated backend selection (see `selectIacProvider`): REAL Vercel when
			// `VERCEL_TOKEN` is set, in-memory Pulumi-backed provider otherwise.
			iac: selectIacProvider({
				store,
				providers: [cloudflare],
				...(options.iacAdapter !== undefined
					? { adapter: options.iacAdapter }
					: undefined),
				...(options.env !== undefined ? { env: options.env } : undefined),
				...(options.vercelFetch !== undefined
					? { vercelFetch: options.vercelFetch }
					: undefined),
				...(options.cloudflareFetch !== undefined
					? { cloudflareFetch: options.cloudflareFetch }
					: undefined),
			}),
		}),
		broker: createInProcessCredentialBroker(),
		// Base (in-code) providers PLUS whatever `hobo add` has installed and
		// approved in the durable registry stream — the read model the Planner
		// matches against, rebuildable from zero (HOBO-710). The cloud verbs
		// call `registry.refresh()` before planning to fold the latest facts.
		registry: createEventBackedRegistry({
			store,
			streamId: REGISTRY_STREAM,
			base: createRegistryFromProviders([toRegistrableProvider(cloudflare)]),
		}),
	};
}

export interface ProductionYardRuntimeOptions
	extends DefaultYardRuntimeOptions {
	/** Caller-owned persistent directory. Production state never uses an exit-cleaned temporary store. */
	readonly dataDir: string;
	readonly nowMs: () => number;
	configureHosting(input: {
		readonly store: DurableEventStore;
		readonly defaultRegistry: PlannerRegistry;
	}): Promise<{
		readonly registry: PlannerRegistry;
		readonly authority: SharedHostingBudgetAuthority;
		readonly budgetId: string;
		readonly execution: Omit<
			ProductionHostingExecutionOptions,
			"store" | "budget" | "budgetId" | "nowMs"
		>;
	}>;
}

/** Async production composition shares one persistent event partition among
 * gateway admission, mutation journals and the execution supervisor. Verified
 * credential leases and native financial readers can be acquired in configureHosting. */
export async function createProductionYardRuntime(
	options: ProductionYardRuntimeOptions,
) {
	if (!options.dataDir || !isAbsolute(options.dataDir))
		throw new Error(
			"production hosting requires an absolute persistent data directory",
		);
	const now = () => {
		const value = options.nowMs();
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error("production hosting requires a valid trusted clock");
		return value;
	};
	const store = createRuntimeLocalEventStore({
		dataDir: options.dataDir,
		clock: { now: () => new Date(now()).toISOString() },
	});
	try {
		const base = createYardRuntimeOverStore(options, store);
		const configured = await options.configureHosting({
			store,
			defaultRegistry: base.registry,
		});
		if (
			configured.authority.persistence !== "durable-cas" ||
			!configured.authority.resolve ||
			!configured.budgetId ||
			configured.execution.provider.requiresDestinationLiabilityProof !== true
		)
			throw new Error(
				"production hosting requires durable financial admission, trusted quotes and native liability verification",
			);
		const hostingController = createProductionHostingExecution({
			...configured.execution,
			store,
			budget: configured.authority,
			budgetId: configured.budgetId,
			nowMs: now,
		});
		return {
			...base,
			store,
			registry: configured.registry,
			hostingBudgetRequired: true,
			hostingBudgetAuthority: configured.authority,
			defaultHostingBudgetId: configured.budgetId,
			hostingExecution: hostingController.execution,
			hostingController,
			close: () => store.close(),
		};
	} catch (error) {
		store.close();
		throw error;
	}
}

// Idempotently record the DEFAULT provider set as durable registration +
// approval facts (walkthrough Part 0/2: a cloud exists once its default
// providers are approved — a fact trail, not config). Providers already
// present in the stream are skipped, so re-running a boot never duplicates
// facts. The composed binary runs this before dispatching a verb.
export async function bootstrapDefaultProviders(
	runtime: { store: EventStore; registry: YardRuntime["registry"] },
	providers: readonly RegistrableProvider[] = [
		toRegistrableProvider(createCloudflareProvider()),
	],
): Promise<string[]> {
	const events = await collectStream(runtime.store, REGISTRY_STREAM);
	const fold = foldRegistryStream(events);
	let lastSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0;
	const recorded: string[] = [];

	for (const provider of providers) {
		const facts = [];
		if (!fold.installed.has(provider.id))
			facts.push(registerProviderFact(provider));
		if (!fold.approved.has(provider.id))
			facts.push(approveProviderFact(provider.id, "yard/bootstrap"));
		if (facts.length === 0) continue;
		const appended = await runtime.store.append(REGISTRY_STREAM, facts, {
			expectedSeq: lastSeq,
			actor: { kind: "system", id: "yard/bootstrap" },
			tenant: "hobo-dev",
		});
		lastSeq = appended.appended[appended.appended.length - 1]?.seq ?? lastSeq;
		recorded.push(provider.id);
	}

	await runtime.registry.refresh?.();
	return recorded;
}

const HTTP_INCOMING_INTERFACE =
	// SAFETY: assertion required at this I/O or test boundary.
	"wasi:http/incoming-handler@0.2.0" as InterfaceId;
// SAFETY: assertion required at this I/O or test boundary.
const KV_STORE_INTERFACE = "wasi:keyvalue/store@0.2.0" as InterfaceId;

export interface DefaultDevRuntimeOptions {
	// The greeting the offline hello-bindle guest reads from its linked KV
	// provider. Defaults to "world" (guest serves `hello world`).
	readonly greeting?: string;
}

// Assemble the default `DevRuntime` the `hobo dev` command boots. This mirrors
// the @hobo/cli dev-verb test wiring: a runtime-local component host + local
// Streamer, a hello-bindle guest that reads a greeting from a linked KV
// provider and serves it over HTTP, the static link table, and a probe request.
// Fully in-process and offline (no cloud account, no network).
export function createDefaultDevRuntime(
	options: DefaultDevRuntimeOptions = {},
): DevRuntime {
	const greeting = options.greeting ?? "world";
	const events: ComponentHostEvent[] = [];
	const componentHost = createRuntimeLocalComponentHost({
		appendEvent: (event) => {
			events.push(event);
		},
	});
	const streamer = createLocalStreamer();

	const component: ParsedComponentDescriptor = {
		parsed: true,
		id: "hello-bindle",
		imports: [KV_STORE_INTERFACE],
		exports: {
			[HTTP_INCOMING_INTERFACE]: {
				// SAFETY: component host table is untyped at the descriptor boundary.
				handle: (async (...args: JsonValue[]): Promise<JsonValue> => {
					const context = hostContextFrom(args[1]);
					const resolved = await context.callImport(KV_STORE_INTERFACE, "get", {
						key: "greeting",
					});
					return { status: 200, headers: [], body: `hello ${resolved}` };
				}) as ParsedComponentDescriptor["exports"][string][string],
			},
		},
	};

	const provider: ProviderDescriptor = {
		id: "local-kv",
		exports: {
			[KV_STORE_INTERFACE]: {
				get: async () => greeting,
			},
		},
	};

	return {
		componentHost,
		streamer,
		plan: {
			component,
			providers: [provider],
			links: [
				{
					componentId: "hello-bindle",
					importInterface: KV_STORE_INTERFACE,
					providerId: "local-kv",
					exportInterface: KV_STORE_INTERFACE,
				},
			],
			probe: { method: "GET", path: "/", headers: [], body: "" },
		},
		readEvents: () => events,
	};
}

// The project-aware dev-runtime resolver `hobo dev` boots in the composed CLI
// (docs/plans/0006 item 3-1). When the invoked project's bindle source loads
// and its first api/web resource carries an app-host entrypoint (the
// `b.api(() => app.fetch)` handler), the local Camp serves THAT handler:
// the component descriptor's HTTP export converts the host's HttpRequest to a
// web Request, invokes the project's fetch handler in-process, and folds the
// Response back. No entrypoint (or no loadable source) falls back to the
// offline hello-bindle guest so composed `dev` never regresses to the stub.
export async function resolveProjectDevRuntime(
	projectDir: string,
): Promise<DevRuntime> {
	const definition = await loadBindleDefinition(projectDir);
	const entry =
		definition === null ? null : firstServableEntrypoint(definition);
	if (definition === null || entry === null) {
		return createDefaultDevRuntime();
	}

	const events: ComponentHostEvent[] = [];
	const componentHost = createRuntimeLocalComponentHost({
		appendEvent: (event) => {
			events.push(event);
		},
	});
	const streamer = createLocalStreamer();

	const component: ParsedComponentDescriptor = {
		parsed: true,
		id: definition.name,
		imports: [],
		exports: {
			[HTTP_INCOMING_INTERFACE]: {
				// SAFETY: component host table is untyped at the descriptor boundary.
				handle: (async (...args: JsonValue[]): Promise<JsonValue> => {
					const request = incomingHttpRequestFrom(args[0]);
					const fetchHandler = entry.handler();
					const response = await fetchHandler(
						new Request(`http://localhost:4000${request.path || "/"}`, {
							method: request.method,
							headers: Object.fromEntries(request.headers ?? []),
							...(request.body ? { body: request.body } : undefined),
						}),
					);
					return {
						status: response.status,
						headers: [...response.headers.entries()],
						body: await response.text(),
					};
				}) as ParsedComponentDescriptor["exports"][string][string],
			},
		},
	};

	return {
		componentHost,
		streamer,
		plan: {
			component,
			providers: [],
			links: [],
			probe: { method: "GET", path: "/", headers: [], body: "" },
		},
		readEvents: () => events,
	};
}

function firstServableEntrypoint(
	definition: BindleDefinition,
): { readonly name: string; readonly handler: () => FetchHandler } | null {
	if (!(definition.entrypoint instanceof Function)) {
		return null;
	}
	for (const [name, record] of Object.entries(definition.resources)) {
		if (record.kind !== "api" && record.kind !== "web") {
			continue;
		}
		const handler = definition.entrypoint(name);
		if (!(handler instanceof Function)) {
			continue;
		}
		const inner = handler();
		if (!(inner instanceof Function)) {
			continue;
		}
		const resolved = asFetchHandler(inner);
		if (resolved === null) {
			continue;
		}
		return { name, handler: () => resolved };
	}
	return null;
}

// Assemble the default `CollectionTarget` the `hobo collect` command runs
// resource collection against when the project has NO loadable bindle source:
// a representative hello-bindle (a service bound to a data resource) so
// `collect` emits a real manifest IR rather than the shell stub. Projects with
// a `src/bindle.ts` (or built `dist/bindle.js`) get their OWN target via
// `resolveProjectCollectionTarget`. LOCAL/MOCKED lane.
export function createDefaultCollectionTarget(
	projectDir?: string,
): CollectionTarget {
	const bindleId =
		projectDir !== undefined
			? basename(projectDir) || "hello-bindle"
			: "hello-bindle";
	return {
		bindleId,
		componentHost: { kind: "wasmtime", version: "46.0.1" },
		define(collect: CollectionContext): void {
			const db = collect.data("db", { paradigm: "relational" });
			collect.service("api", {
				image: "oci://registry.example.com/api@sha256:abc123",
				bind: { db },
			});
		},
	};
}

// The project-aware target resolver `hobo collect` runs with in the composed
// CLI (docs/plans/0006 item 3-1): the invoked project's own bindle source wins
// (TS loader → run-to-collect); the representative hello-bindle target remains
// the fallback so composed `collect` never regresses to the shell stub.
export async function resolveProjectCollectionTarget(
	projectDir: string,
): Promise<CollectionTarget> {
	const fromSource = await loadProjectCollectionTarget(projectDir);
	return fromSource ?? createDefaultCollectionTarget(projectDir);
}
