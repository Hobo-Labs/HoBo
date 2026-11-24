import type { CollectionTarget } from "@hobo/bindles";
import {
	type CommandModule,
	createBuildCommand,
	createCollectCommand,
	createDevCommand,
	createDownCommand,
	createHoboCli,
	createLifecycleFamilyCommand,
	createPlanCommand,
	type DevRuntime,
	type HoboCli,
	type YardRuntime,
} from "@hobo/cli";
import type { SharedHostingBudgetAuthority } from "@hobo/cloud";
import { type DeviceClock, prepareVercelConnection } from "@hobo/hobo-cd";
import {
	machineRunner,
	type OwnerChannel,
	prepareGithubConnection,
	whichOnPath,
} from "@hobo/hobo-ci";
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
import {
	createAddCommand,
	installableProvidersFor,
	registerInstallable,
} from "./add-command.js";
import { createAttestCommand } from "./attest-command.js";
import { createAuthMdIdentityCommand } from "./auth-md-command.js";
import { normalizeComponentHostKind } from "./bare-metal-yard.js";
import { createBrokerCommand } from "./broker-command.js";
import { createBrokerAwareUpCommand } from "./broker-up-command.js";
import { createCanDeployCommand } from "./can-deploy-command.js";
import { defaultJournalProvisioners } from "./cd-journal-provisioners.js";
import {
	cdPlacementRuntime,
	createCdPlanCommand,
	createCdVercelUpCommand,
	retainPreparedOnDown,
} from "./cd-placement.js";
import { createCiCommand } from "./ci-command.js";
import { secretStoreOwnershipVerifier } from "./ci-secret-store.js";
import {
	createCiRelayPlanCommand,
	createCiRelayUpCommand,
} from "./ci-up-relay.js";
import { createClaimCommand } from "./claim-command.js";
import {
	createDefaultYardRuntime,
	deployEnvironment,
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
import { resolveCdProject, resolveCiProject } from "./family-projects.js";
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
import type { OwnerStoreSessions } from "./owner-store-session.js";
import { createProviderCeremonyUp } from "./provider-ceremony.js";
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
import { createSecretStoreProvider } from "./secret-store-providers.js";
import { createServeControlCommand } from "./serve-control-command.js";
import { createStationCommand } from "./station-command.js";
import { createTrailsCommand } from "./trails-command.js";
import { createVerifyCommand } from "./verify-command.js";
import { serveProjectOnLocalYard } from "./wasm-host.js";
import { createYardCommand } from "./yard-command.js";

export { removeOwnedDirsOnSignals } from "./owned-temp-dir.js";

export interface ComposedHoboCliOptions {
	/**
	 * How a ceremony reaches an owner who is not at this machine (the HoBo MCP
	 * server's channel); without it, a remote run says where to run instead.
	 */
	readonly ownerChannel?: OwnerChannel;
	readonly ownerSession?: Pick<
		OwnerStoreSessions,
		"credentials" | "status" | "entries"
	>;
	/**
	 * The clock steps that wait on a provider use (the Vercel device grant's
	 * polling, RFC 8628): the system's by default; a spec drives it virtually.
	 */
	readonly clock?: DeviceClock;
	readonly hosting?: {
		readonly budgetId: string;
		readonly authority: SharedHostingBudgetAuthority;
		readonly supervisor: ReturnType<typeof createProductionHostingExecution>;
	};
	readonly yardRuntime?: YardRuntime;
	readonly requireRealExecution?: boolean;
	readonly authMdFetch?: typeof fetch;
	readonly devRuntime?: DevRuntime;
	readonly collectionTarget?: CollectionTarget;
}

registerInstallable("aws", () => toRegistrableProvider(createAwsProvider()));
registerInstallable("azure", () =>
	toRegistrableProvider(createAzureProvider()),
);
registerInstallable("gcp", () => toRegistrableProvider(createGcpProvider()));
registerInstallable("digitalocean", () =>
	toRegistrableProvider(createDigitalOceanProvider()),
);
registerInstallable("hetzner", () =>
	toRegistrableProvider(createHetznerProvider()),
);
registerInstallable("hostinger", () =>
	toRegistrableProvider(createHostingerProvider()),
);
registerInstallable("kubernetes", () =>
	toRegistrableProvider(createKubernetesProvider()),
);
registerInstallable(
	"lakebed",
	() => toRegistrableProvider(createLakebedProvider()),
	{ defaultHold: true },
);
registerInstallable("runner-github", () => createGithubRunnerCatalogEntry());
registerInstallable("runner-blacksmith", () => createBlacksmithCatalogEntry());
registerInstallable("runner-depot", () => createDepotCatalogEntry());
// The owner's secret stores serve the `secretRef` port with references only,
// each in a Yard of its own: `hobo add infisical | bitwarden | 1password`.
registerInstallable("infisical", () => createSecretStoreProvider("infisical"));
registerInstallable("bitwarden", () => createSecretStoreProvider("bitwarden"));
registerInstallable("1password", () => createSecretStoreProvider("1password"));
registerInstallable("local", () => createLocalProvider());
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
	const deployEnv = deployEnvironment();
	const cloudConfigured =
		options.hosting !== undefined ||
		deployEnv.HOBO_PULUMI_LIVE === "1" ||
		Boolean(
			(deployEnv.CLOUDFLARE_API_TOKEN && deployEnv.CLOUDFLARE_ACCOUNT_ID) ||
				deployEnv.VERCEL_TOKEN,
		);
	const deployRuntime =
		explicitFixture || cloudConfigured ? runtime : undefined;
	const sandbox = createSandboxCommand();
	const add = createAddCommand({ runtime });
	// Every infra `up` holds a ceremony for what it is missing: a resource no
	// connected provider serves opens the setup page, offers the installable
	// providers for its port, connects the chosen ones and runs up again.
	const up = createProviderCeremonyUp(
		createBrokerAwareUpCommand({
			...(deployRuntime ? { runtime: deployRuntime } : undefined),
			persistentLocal: !explicitFixture,
			authMdFetch: options.authMdFetch ?? fetch,
		}),
		{ add, candidates: installableProvidersFor },
	);
	const down = createLocalDeploymentDownCommand(
		deployRuntime ? createDownCommand({ runtime: deployRuntime }) : undefined,
	);
	// Delivery and hosting supervisors own their own executors, so wrapping the
	// local executor cannot prove that they retain the prepared journal and store.
	const cdUnavailableResult = (action: "up" | "down") => ({
		ok: false,
		status: "unavailable",
		code: "HOBO_CD_PREPARED_PLACEMENT_UNAVAILABLE",
		message: `hobo cd ${action} cannot safely manage prepared resources with this runtime.`,
		remediation: [
			"Use a runtime that can retain the CD journal and owner store during teardown.",
		],
	});
	const cdUnavailable = (action: "up" | "down"): CommandModule => ({
		implemented: true,
		run: async () => cdUnavailableResult(action),
	});
	const cdDownFallback =
		!deployRuntime || deployRuntime.delivery || deployRuntime.hostingExecution
			? cdUnavailable("down")
			: createDownCommand({
					runtime: {
						...cdPlacementRuntime(deployRuntime),
						executor: retainPreparedOnDown(deployRuntime.executor),
					},
				});
	const cdDown = createLocalDeploymentDownCommand(cdDownFallback);
	// `plan` (and every `--what-if`) never opens a page, but a rejection for a
	// missing provider says which `hobo add` would satisfy each resource.
	const plan = createProviderCeremonyUp(createPlanCommand({ runtime }), {
		add,
		candidates: installableProvidersFor,
		interactive: false,
	});
	const ci = createCiCommand({
		runtime,
		...(options.ownerSession !== undefined
			? {
					fleetCredentials: options.ownerSession.credentials,
					ownerEntries: options.ownerSession.entries,
				}
			: undefined),
	});
	const deploy = createDeployCommand({
		hosting: options.hosting?.supervisor,
		...(options.ownerSession !== undefined
			? { credentialsFor: options.ownerSession.credentials }
			: undefined),
	});

	return createHoboCli({
		commands: {
			ci: createLifecycleFamilyCommand({
				family: "ci",
				resolveProject: resolveCiProject,
				up,
				down,
				// The machine: install and run the chosen store's CLI.
				prepare: (input) =>
					prepareGithubConnection(input, {
						runCommand: machineRunner(),
						...(options.ownerChannel !== undefined
							? { ownerChannel: options.ownerChannel }
							: undefined),
						...(options.clock !== undefined
							? { now: options.clock.now, sleep: options.clock.sleep }
							: undefined),
						which: (bin) => whichOnPath(bin),
					}),
				// The relay is placed through its own Yards (the Vercel project
				// hobo-ci and the Yards its junction joins), and `up` delivers it.
				plan: createCiRelayPlanCommand(runtime, plan),
				upWith: (credentials) => createCiRelayUpCommand(credentials, up),
				status: ci,
				fallback: ci,
			}),
			cd: createLifecycleFamilyCommand({
				family: "cd",
				resolveProject: resolveCdProject,
				up,
				down: cdDown,
				// The journal and config are placed on the Yards cd up makes for
				// them (the journal's fleet, the owner's config service).
				plan: createCdPlanCommand(runtime, (placed) =>
					createProviderCeremonyUp(createPlanCommand({ runtime: placed }), {
						add,
						candidates: installableProvidersFor,
						interactive: false,
					}),
				),
				// hobo cd up also provisions the CD journal's fleet.
				prepare: (input) =>
					!input.whatIf && (runtime.delivery || runtime.hostingExecution)
						? Promise.resolve({
								kind: "refused" as const,
								result: cdUnavailableResult("up"),
							})
						: prepareVercelConnection(input, {
								journalProvisioners: defaultJournalProvisioners(),
								runCommand: machineRunner(),
								...(options.ownerChannel !== undefined
									? { ownerChannel: options.ownerChannel }
									: undefined),
								...(options.clock !== undefined
									? { now: options.clock.now, sleep: options.clock.sleep }
									: undefined),
								which: (bin) => whichOnPath(bin),
							}),
				upWith: (credentials) =>
					runtime.delivery || runtime.hostingExecution
						? cdUnavailable("up")
						: createCdVercelUpCommand({
								credentials,
								runtime,
								prebuilt: { env: process.env },
								upWith: (placed) =>
									createBrokerAwareUpCommand({
										runtime: placed,
										persistentLocal: !explicitFixture,
										authMdFetch: options.authMdFetch ?? fetch,
									}),
							}),
				fallback: deploy,
			}),
			build: createBuildCommand({ requireRealComponentize: true }),
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
									...(hostEnv !== undefined && hostEnv.length > 0
										? { componentHost: normalizeComponentHostKind(hostEnv) }
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
			plan,
			up,
			login: createBrokerAwareLoginCommand({ fetchImpl: fetch }),
			connection: createConnectionCommand(),
			identity: createAuthMdIdentityCommand({
				fallback: createIdentityCommand(),
				fetchImpl: options.authMdFetch ?? fetch,
				store: runtime.store,
			}),
			trails: createTrailsCommand(),
			access: createAccessCommand(),
			feature: createFeatureCommand(),
			deploy,
			incident: createIncidentCommand(),
			down,
			doctor: createDoctorCommand(
				options.ownerSession !== undefined
					? {
							store: runtime.store,
							ownerSession: options.ownerSession.status,
						}
					: { store: runtime.store },
			),
			messaging: createMessagingCommand(),
			verify: createVerifyCommand(),
			"can-deploy": createCanDeployCommand(),
			broker: createBrokerCommand({ catalog: runtime.registry }),
			yard: createYardCommand(),
			station: createStationCommand(),
			replay: createReplayCommand(),
			serve: createServeControlCommand(),
			inspect: createInspectCommand({ runtime }),
			drift: createDriftCommand({ runtime }),
			attest: createAttestCommand({ runtime }),
			claim: createClaimCommand({
				runtime,
				fetchImpl: options.authMdFetch ?? fetch,
				verifyOwnership: secretStoreOwnershipVerifier({ env: process.env }),
			}),
			recipes: createRecipesCommand(),
			offer: createOfferCommand({ runtime }),
			registry: createRegistryCommand({ runtime }),
			add,
			import: createImportCommand({ runtime }),
			generate: createGenerateCommand({ runtime }),
			derivative: createDerivativeCommand(),
			logs: createLogsCommand(),
			runbook: createRunbookCommand({ runtime }),
			erase: createEraseCommand({ runtime }),
			sandbox,
			test: sandbox,
		},
	});
}
