import type { CollectionTarget } from "@hobo/bindles";
import {
	createBuildCommand,
	createCollectCommand,
	createDevCommand,
	createDownCommand,
	createHoboCli,
	createPlanCommand,
	type DevRuntime,
	type HoboCli,
	type YardRuntime,
} from "@hobo/cli";
import type { SharedHostingBudgetAuthority } from "@hobo/cloud";
import { createAwsProvider } from "@hobo/provider-aws";
import { createAzureProvider } from "@hobo/provider-azure";
import { createDigitalOceanProvider } from "@hobo/provider-digitalocean";
import { createGcpProvider } from "@hobo/provider-gcp";
import { createHetznerProvider } from "@hobo/provider-hetzner";
import { createHostingerProvider } from "@hobo/provider-hostinger";
import { createKubernetesProvider } from "@hobo/provider-kubernetes";
import { createLakebedProvider } from "@hobo/provider-lakebed";
import { createBlacksmithCatalogEntry } from "@hobo/runner-blacksmith";
import { createDepotCatalogEntry } from "@hobo/runner-depot";
import { createGithubRunnerCatalogEntry } from "@hobo/runner-github";
import { createAccessCommand } from "./access-command.js";
import { createAddCommand, registerInstallable } from "./add-command.js";
import { createAttestCommand } from "./attest-command.js";
import { createAuthMdIdentityCommand } from "./auth-md-command.js";
import { createBrokerCommand } from "./broker-command.js";
import { createBrokerAwareUpCommand } from "./broker-up-command.js";
import { createCanDeployCommand } from "./can-deploy-command.js";
import { createCiCommand } from "./ci-command.js";
import { createClaimCommand } from "./claim-command.js";
import {
	createDefaultYardRuntime,
	resolveProjectCollectionTarget,
	resolveProjectDevRuntime,
	toRegistrableProvider,
} from "./compose.js";
import { createConnectionCommand } from "./connection-command.js";
import { createDeployCommand } from "./deploy-command.js";
import { createDerivativeCommand } from "./derivative-command.js";
import { createDoctorCommand } from "./doctor-command.js";
import { createDriftCommand } from "./drift-command.js";
import { createEraseCommand } from "./erase-command.js";
import { createFeatureCommand } from "./feature-command.js";
import { createGenerateCommand } from "./generate-command.js";
import type { createProductionHostingExecution } from "./hosting-execution.js";
import { createIdentityCommand } from "./identity-command.js";
import { createImportCommand } from "./import-command.js";
import { createIncidentCommand } from "./incident-command.js";
import { createInspectCommand } from "./inspect-command.js";
import { isJsonString } from "./json.js";
import { createLocalDeploymentDownCommand } from "./local-deployment.js";
import { createLocalProvider } from "./local-provider.js";
import { createBrokerAwareLoginCommand } from "./login-command.js";
import { createLogsCommand } from "./logs-command.js";
import { createMessagingCommand } from "./messaging-command.js";
import { createOfferCommand } from "./offer-command.js";
import { createRecipesCommand } from "./recipes-command.js";
import { createRegistryCommand } from "./registry-command.js";
import { createReplayCommand } from "./replay-command.js";
import { createRunbookCommand } from "./runbook-command.js";
import {
	createCloudNativeRuntimeCatalogEntry,
	createLocalRuntimeCatalogEntry,
	createOciRuntimeCatalogEntry,
	createWasmRuntimeCatalogEntry,
} from "./runtime-catalog.js";
import { createSandboxCommand } from "./sandbox-command.js";
import { createServeControlCommand } from "./serve-control-command.js";
import { createStationCommand } from "./station-command.js";
import { createTrailsCommand } from "./trails-command.js";
import { createVerifyCommand } from "./verify-command.js";
import { serveProjectOnLocalYard } from "./wasm-host.js";
import { createYardCommand } from "./yard-command.js";

// For an entry point that composes this CLI in its own process (a shell that
// loads this module from another package): the directories the
// composition owns are removed on SIGTERM, SIGHUP, SIGINT and SIGQUIT too. A
// no-op in a worker thread; a library never calls it.
export { removeOwnedDirsOnSignals } from "./owned-temp-dir.js";

export interface ComposedHoboCliOptions {
	/** The production host supplies trusted financial and provider wiring. */
	readonly hosting?: {
		readonly budgetId: string;
		readonly authority: SharedHostingBudgetAuthority;
		readonly supervisor: ReturnType<typeof createProductionHostingExecution>;
	};
	// Override the default local/mocked YardRuntime shared across plan/up/down.
	// Injecting one lets a caller (e.g. a test) hold the runtime so it can close
	// `runtime.store` afterward.
	readonly yardRuntime?: YardRuntime;
	/** Binaries set this even when injecting the assembled production runtime. */
	readonly requireRealExecution?: boolean;
	/** Host transport injection for agent-principal discovery and TLS trust. */
	readonly authMdFetch?: typeof fetch;
	// Override the default offline DevRuntime `hobo dev` boots.
	readonly devRuntime?: DevRuntime;
	// Override the default `hobo collect` target.
	readonly collectionTarget?: CollectionTarget;
}

// The composed `hobo` CLI. It reuses `createHoboCli` from @hobo/cli and injects
// the DEFAULT runtimes into the command factories that would otherwise fall back
// to shell stubs when un-injected. ONE YardRuntime is shared across plan/up/down
// so `up` then `down` operate on the same event store. `login`/`new`/`build`/
// `codegen` keep @hobo/cli's defaults — they already work un-injected.
// Default-provider catalog entries (M1+ adapter slices): each real provider
// registers itself as `hobo add`-able here at the composition root, keeping
// add-command free of adapter imports. Approval semantics stay with HOBO-710
// (`hobo add aws` registers + approves; `--hold` defers approval).
registerInstallable("aws", () => toRegistrableProvider(createAwsProvider()));
registerInstallable("azure", () =>
	toRegistrableProvider(createAzureProvider()),
);
registerInstallable("gcp", () => toRegistrableProvider(createGcpProvider()));
registerInstallable("digitalocean", () =>
	toRegistrableProvider(createDigitalOceanProvider()),
);
// Hetzner declares two capability ports rather than six, and Hostinger two as
// well: neither sells a managed database, cache or queue (Hostinger's MySQL
// aside), so Matching answers `none` for the rest instead of a near-miss.
registerInstallable("hetzner", () =>
	toRegistrableProvider(createHetznerProvider()),
);
registerInstallable("hostinger", () =>
	toRegistrableProvider(createHostingerProvider()),
);
// The cluster provider: `hobo add kubernetes` registers the compute port a
// Deployment satisfies. Everything else a cluster can host arrives through
// operators, which this adapter does not install or claim.
registerInstallable("kubernetes", () =>
	toRegistrableProvider(createKubernetesProvider()),
);
// The competitor deploy target registers HELD by default (ADR-0127): a second
// `hobo add lakebed` records the explicit approval.
registerInstallable(
	"lakebed",
	() => toRegistrableProvider(createLakebedProvider()),
	{ defaultHold: true },
);
// The GitHub Actions execution-host adapter (M3): both `hobo:runner` and
// `hobo:build-machine` ports register from one catalog entry so the
// Dispatcher can cost-route jobs/builds across registered hosts (ADR-0071).
registerInstallable("runner-github", () => createGithubRunnerCatalogEntry());
// The Blacksmith fast-runner sibling: same job model, cheaper runs-on
// substrate — registering both gives the Dispatcher a real price choice.
registerInstallable("runner-blacksmith", () => createBlacksmithCatalogEntry());
// The Depot remote-build specialist: shared-cache economics make its warm
// builds competitive with "free" cold options (HOBO-720).
registerInstallable("runner-depot", () => createDepotCatalogEntry());
// Local provider — installable via `hobo add local`; default provider id for
// local Yard topologies (`hobo yard init`).
registerInstallable("local", () => createLocalProvider());
// Camp component-host runtimes (installable; broker hard-fails when missing).
registerInstallable("runtime-local", () => createLocalRuntimeCatalogEntry());
registerInstallable("runtime-wasm", () => createWasmRuntimeCatalogEntry());
registerInstallable("runtime-oci", () => createOciRuntimeCatalogEntry());
registerInstallable("runtime-cloud-native", () =>
	createCloudNativeRuntimeCatalogEntry(),
);

export function createComposedHoboCli(
	options: ComposedHoboCliOptions = {},
): HoboCli {
	const baseRuntime = options.yardRuntime ?? createDefaultYardRuntime();
	const runtime: YardRuntime = options.hosting
		? {
				...baseRuntime,
				hostingBudgetAuthority: options.hosting.authority,
				defaultHostingBudgetId: options.hosting.budgetId,
				hostingBudgetRequired: true,
				hostingExecution: options.hosting.supervisor.execution,
			}
		: baseRuntime;
	const explicitFixture =
		options.yardRuntime !== undefined && options.requireRealExecution !== true;
	const cloudConfigured =
		options.hosting !== undefined ||
		process.env.HOBO_PULUMI_LIVE === "1" ||
		Boolean(
			(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) ||
				process.env.VERCEL_TOKEN,
		);
	const deployRuntime =
		explicitFixture || cloudConfigured ? runtime : undefined;
	// `sandbox` and its `test` alias share one command; each run() boots its OWN
	// fresh runtime-local Camp (isolation), so no shared runtime is threaded here.
	const sandbox = createSandboxCommand();

	return createHoboCli({
		commands: {
			ci: createCiCommand(),
			build: createBuildCommand({ requireRealComponentize: true }),
			// Local loop: open the Yard, place the Bindle into a Camp, run the Camp's
			// component host (services__* + bindle env + external-only TCP).
			dev: createDevCommand(
				options.devRuntime !== undefined
					? { runtime: options.devRuntime }
					: {
							resolveRuntime: resolveProjectDevRuntime,
							serveProject: async ({ projectDir, port, emitProgress }) => {
								const hoboHome = process.env.HOBO_HOME;
								const hostEnv = process.env.HOBO_YARD_HOST;
								const serve = await serveProjectOnLocalYard({
									projectDir,
									...(port !== undefined ? { port } : undefined),
									...(isJsonString(hoboHome) && hoboHome.length > 0
										? { hoboHome }
										: undefined),
									...(hostEnv === "local" ||
									hostEnv === "wasm" ||
									hostEnv === "oci" ||
									hostEnv === "cloud-native" ||
									hostEnv === "isolated-wasm" ||
									hostEnv === "bare-metal" ||
									hostEnv === "runtime-local"
										? { componentHost: hostEnv }
										: undefined),
									emitProgress,
								});
								return {
									primaryUrl: serve.primaryUrl,
									bindleName: serve.bindleName,
									campId: serve.campId,
									yardName: serve.yard.name,
									providerId: serve.yard.providerId,
									endpoints: serve.endpoints,
									exposedEndpoints: serve.exposedEndpoints,
									serviceDiscovery: serve.serviceDiscovery,
									bindleEnv: serve.bindleEnv,
									...(serve.namedEndpoints !== undefined
										? { namedEndpoints: serve.namedEndpoints }
										: undefined),
									...(serve.primaryNamedUrl !== undefined
										? { primaryNamedUrl: serve.primaryNamedUrl }
										: undefined),
									probe: serve.probe,
									close: serve.close,
									waitUntilStopped: serve.waitUntilStopped,
									componentHost: serve.componentHost,
								};
							},
						},
			),
			collect: createCollectCommand(
				options.collectionTarget !== undefined
					? { target: options.collectionTarget }
					: { resolveTarget: resolveProjectCollectionTarget },
			),
			plan: createPlanCommand({ runtime }),
			// Always place through the embedded broker-runtime (prefer wasm-sandbox yards).
			// Remote --broker / --anonymous paths use discovery + credential presenter.
			// The cloud mock `createUpCommand` remains for tests that wire it directly.
			up: createBrokerAwareUpCommand({
				...(deployRuntime ? { runtime: deployRuntime } : undefined),
				persistentLocal: !explicitFixture,
				authMdFetch: options.authMdFetch ?? fetch,
			}),
			// Identity plane: persist profile + optional default broker association.
			// The composition root injects the platform fetch — the login/grant
			// modules never reach for the global, so tests drive them offline.
			login: createBrokerAwareLoginCommand({ fetchImpl: fetch }),
			// Durable Connections: authorize once, mint short-lived tokens thereafter.
			connection: createConnectionCommand(),
			// Continuous identity migration observe surface (Matching/policy-driven; zero Bindle config).
			identity: createAuthMdIdentityCommand({
				fallback: createIdentityCommand(),
				fetchImpl: options.authMdFetch ?? fetch,
				store: runtime.store,
			}),
			// Continuous migration Trails observe surface (identity hands-off + app-authored recipes).
			trails: createTrailsCommand(),
			// Elevated / cross-env access request + break-glass (short-lived capability).
			access: createAccessCommand(),
			// OpenFeature flags + canary/experiment observe (Harness ADR-0083).
			feature: createFeatureCommand(),
			// Continuous delivery observe / rollback (attested apply plane).
			deploy: createDeployCommand({ hosting: options.hosting?.supervisor }),
			// CD failure disposition (A2H default / sandboxed self-heal).
			incident: createIncidentCommand(),
			down: createLocalDeploymentDownCommand(
				deployRuntime
					? createDownCommand({ runtime: deployRuntime })
					: undefined,
			),
			doctor: createDoctorCommand(),
			messaging: createMessagingCommand(),
			verify: createVerifyCommand(),
			"can-deploy": createCanDeployCommand(),
			// The broker (the Conductor) resolves against the same live,
			// approval-gated registry the Planner matches over.
			broker: createBrokerCommand({ catalog: runtime.registry }),
			// Install/inspect the default bare-metal yard (`hobo yard init|status`).
			yard: createYardCommand(),
			// Station occupancy setup/ops (main control-plane setup path; not lifecycle).
			station: createStationCommand(),
			// Session Replay (DOM/session reconstruction; distinct from event-log replay).
			replay: createReplayCommand(),
			// Local control-plane HTTP+SSE for Yard game UI (ADR-0150).
			serve: createServeControlCommand(),
			inspect: createInspectCommand({ runtime }),
			drift: createDriftCommand({ runtime }),
			attest: createAttestCommand({ runtime }),
			claim: createClaimCommand({
				runtime,
				fetchImpl: options.authMdFetch ?? fetch,
			}),
			// Anonymous-to-owned: what HoBo can deploy before a provider login,
			// and the proposal a human consents to before anything is created.
			recipes: createRecipesCommand(),
			offer: createOfferCommand({ runtime }),
			registry: createRegistryCommand({ runtime }),
			add: createAddCommand({ runtime }),
			import: createImportCommand({ runtime }),
			generate: createGenerateCommand({ runtime }),
			derivative: createDerivativeCommand({ runtime }),
			logs: createLogsCommand(),
			runbook: createRunbookCommand({ runtime }),
			erase: createEraseCommand({ runtime }),
			sandbox,
			test: sandbox,
		},
	});
}
