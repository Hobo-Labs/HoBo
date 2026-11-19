import type { CollectionTarget } from "@hobo/bindles";
import {
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
import { createInProcessExecutor } from "@hobo/cloud";
import { prepareVercelConnection } from "@hobo/hobo-cd";
import { prepareGithubConnection } from "@hobo/hobo-ci";
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
import { normalizeComponentHostKind } from "./bare-metal-yard.js";
import { createBrokerCommand } from "./broker-command.js";
import { createBrokerAwareUpCommand } from "./broker-up-command.js";
import { createCanDeployCommand } from "./can-deploy-command.js";
import { createCiCommand } from "./ci-command.js";
import { secretStoreOwnershipVerifier } from "./ci-secret-store.js";
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
import { createVercelDeployProvider } from "./vercel-deploy-provider.js";
import { createVerifyCommand } from "./verify-command.js";
import { serveProjectOnLocalYard } from "./wasm-host.js";
import { createYardCommand } from "./yard-command.js";

export { removeOwnedDirsOnSignals } from "./owned-temp-dir.js";

export interface ComposedHoboCliOptions {
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
	const cloudConfigured =
		options.hosting !== undefined ||
		process.env.HOBO_PULUMI_LIVE === "1" ||
		Boolean(
			(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) ||
				process.env.VERCEL_TOKEN,
		);
	const deployRuntime =
		explicitFixture || cloudConfigured ? runtime : undefined;
	const sandbox = createSandboxCommand();
	const up = createBrokerAwareUpCommand({
		...(deployRuntime ? { runtime: deployRuntime } : undefined),
		persistentLocal: !explicitFixture,
		authMdFetch: options.authMdFetch ?? fetch,
	});
	const down = createLocalDeploymentDownCommand(
		deployRuntime ? createDownCommand({ runtime: deployRuntime }) : undefined,
	);
	const plan = createPlanCommand({ runtime });
	const ci = createCiCommand({ runtime });
	const deploy = createDeployCommand({ hosting: options.hosting?.supervisor });

	return createHoboCli({
		commands: {
			ci: createLifecycleFamilyCommand({
				family: "ci",
				resolveProject: resolveCiProject,
				up,
				down,
				plan,
				prepare: (input) => prepareGithubConnection(input),
				status: ci,
				fallback: ci,
			}),
			cd: createLifecycleFamilyCommand({
				family: "cd",
				resolveProject: resolveCdProject,
				up,
				down,
				plan,
				prepare: (input) => prepareVercelConnection(input),
				upWith: (junctionEnv) =>
					createBrokerAwareUpCommand({
						runtime: {
							...runtime,
							executor: createInProcessExecutor({
								iac: createVercelDeployProvider({
									token: junctionEnv.VERCEL_TOKEN ?? "",
									...(junctionEnv.VERCEL_TEAM_ID !== undefined
										? { teamId: junctionEnv.VERCEL_TEAM_ID }
										: undefined),
									projectName: "hobo-cd",
								}),
							}),
						},
						persistentLocal: !explicitFixture,
						authMdFetch: options.authMdFetch ?? fetch,
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
			doctor: createDoctorCommand({ store: runtime.store }),
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
			add: createAddCommand({ runtime }),
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
