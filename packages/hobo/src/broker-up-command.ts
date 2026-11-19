import {
	presentAuthMdCredential,
	recordAuthMdDeployment,
} from "./auth-md-command.js";

import { createServer } from "node:net";
import {
	type CommandModule,
	createUpCommand,
	externalBoundaryRefusal,
	loadBindleDefinition,
	loadProjectManifest,
	type YardRuntime,
} from "@hobo/cli";
import { manifestHostingPolicy } from "@hobo/cloud";
import {
	defaultHoboHome,
	initBareMetalYard,
	loadBareMetalYardConfig,
} from "./bare-metal-yard.js";
import {
	type BrokerDiscoveryClient,
	type BrokerDiscoveryDocument,
	BrokerDiscoveryError,
	createBrokerDiscoveryClient,
} from "./broker-discovery.js";
import {
	createMockRemoteBrokerState,
	createRemoteBrokerClient,
	type MockRemoteBrokerState,
	type RemoteBrokerClient,
	RemoteBrokerClientError,
} from "./broker-remote-client.js";
import {
	ensureEmbeddedBroker,
	resolveBindlePlacement,
} from "./broker-runtime.js";
import { resolveBrokerTarget, wantsAnonymousMode } from "./broker-target.js";
import {
	type CredentialPresenter,
	createCredentialPresenter,
} from "./credential-presenter.js";
import { isJsonString, type JsonObject } from "./json.js";
import { startLocalDeployment } from "./local-deployment.js";
import { serveProjectOnLocalYard } from "./wasm-host.js";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr === null || isJsonString(addr)) {
				server.close();
				reject(new Error("failed to allocate port"));
				return;
			}
			const port = addr.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
		server.once("error", reject);
	});
}

export interface BrokerAwareUpCommandDeps {
	readonly authMdFetch?: typeof fetch;
	readonly discovery?: BrokerDiscoveryClient;
	readonly presenter?: CredentialPresenter;
	readonly createRemoteClient?: (brokerUri: string) => RemoteBrokerClient;
	readonly mockRemote?: MockRemoteBrokerState;
	readonly env?: NodeJS.ProcessEnv;
	readonly runtime?: YardRuntime;
	readonly persistentLocal?: boolean;
	readonly startLocalDeployment?: typeof startLocalDeployment;
}

export function createBrokerAwareUpCommand(
	deps: BrokerAwareUpCommandDeps = {},
): CommandModule {
	const presenter = deps.presenter ?? createCredentialPresenter();
	const yardUp =
		deps.runtime !== undefined
			? createUpCommand({ runtime: deps.runtime })
			: null;

	return {
		implemented: true,
		run: async (input) => {
			const { context, flags, emitProgress } = input;
			const env =
				deps.env ?? (context as { env?: NodeJS.ProcessEnv }).env ?? process.env;
			const projectDir =
				(context as { projectDir?: string }).projectDir ??
				(isJsonString(flags.cwd) ? flags.cwd : context.cwd);
			const hoboHome =
				isJsonString(flags.home) && flags.home.length > 0
					? flags.home
					: defaultHoboHome(env);

			const boundary = await externalBoundaryRefusal(projectDir, "up");
			if (boundary !== undefined) return boundary;
			try {
				const target = resolveBrokerTarget({
					flags: {
						broker: flags.broker,
						brokerUri: flags.brokerUri,
						anonymous: flags.anonymous,
						temporary: flags.temporary,
					},
					env,
					hoboHome,
				});
				const financialManifest = await loadProjectManifest(projectDir);
				const financialRequired = Boolean(
					deps.runtime?.hostingBudgetRequired ||
						flags.budgetId ||
						deps.runtime?.defaultHostingBudgetId ||
						(financialManifest &&
							manifestHostingPolicy(financialManifest).required),
				);
				if (financialRequired && (target.kind !== "local" || !yardUp))
					return {
						ok: false,
						status: "rejected",
						code: "HOBO_HOSTING_AUTHORITY_REQUIRED",
						message:
							"budgeted hosting requires a configured authoritative hosting runtime; placement and local fallback cannot waive financial admission",
						data: { command: "up", budgetRequired: true },
					};
				const unsupportedMode = () => ({
					ok: false,
					status: "rejected",
					code: "HOBO_DEPLOYMENT_MODE_UNSUPPORTED",
					message: "This broker placement does not support --mode.",
					remediation: [
						"Omit --mode, or use a Yard with desired-state delivery.",
					],
					data: { command: "up" },
				});
				if (flags.mode && target.kind !== "local") return unsupportedMode();

				if (flags.whatIf) {
					if (target.kind !== "local")
						return {
							ok: false,
							status: "usage_error",
							code: "HOBO_USAGE",
							message:
								"hobo up --what-if is answered by the local Yard; a remote broker has no side-effect-free preview",
							remediation: ["Run `hobo plan` against the local Yard instead."],
							data: { command: "up", whatIf: true },
						};
					if (yardUp) {
						const planned = await yardUp.run(input);
						if (planned.code !== "HOBO_CLI_STUB") return planned;
					}
					if (flags.mode) return unsupportedMode();
					const definition = await loadBindleDefinition(projectDir);
					return definition === null
						? {
								ok: false,
								status: "no_bindle",
								code: "HOBO_UP_NO_BINDLE",
								message: `hobo up --what-if: no loadable bindle in ${projectDir}`,
								data: { command: "up", whatIf: true, projectDir },
							}
						: {
								ok: true,
								status: "ok",
								code: "HOBO_OK",
								message: `hobo up --what-if would place bindle ${definition.name} on the local Yard`,
								data: {
									command: "up",
									whatIf: true,
									mode: "local",
									projectDir,
									bindle: definition.name,
								},
							};
				}

				if (target.kind === "local") {
					if (yardUp) {
						const yardResult = await yardUp.run(input);
						const isStub =
							yardResult.code === "HOBO_CLI_STUB" ||
							(yardResult.ok === false && yardResult.status === "stub");
						if (!isStub) {
							return {
								...yardResult,
								data: {
									...(yardResult.data as JsonObject),
									mode: "local",
								},
							};
						}
					}
					if (flags.mode) return unsupportedMode();

					const definition = await loadBindleDefinition(projectDir);
					if (definition === null) {
						return {
							ok: false,
							status: "no_bindle",
							code: "HOBO_UP_NO_BINDLE",
							message: `hobo up: no loadable bindle in ${projectDir}`,
							remediation: [
								"Add src/bindle.ts (or dist/bindle.js) exporting a default bindle.",
								"Or hobo.bindle.json for the local Yard event-sourced lane.",
								"See examples/hello-bindle for the minimal shape.",
							],
							data: { command: "up", projectDir, mode: "local" },
						};
					}
					return await runLocalUp({
						projectDir,
						hoboHome,
						definitionName: definition.name,
						definition,
						emitProgress,
						persistent: deps.persistentLocal === true,
						start: deps.startLocalDeployment ?? startLocalDeployment,
						ttlSeconds: wantsAnonymousMode(flags)
							? localTtlSeconds(env.HOBO_LOCAL_DEPLOYMENT_TTL_SECONDS)
							: 0,
					});
				}

				const definition = await loadBindleDefinition(projectDir);
				if (definition === null) {
					return {
						ok: false,
						status: "no_bindle",
						code: "HOBO_UP_NO_BINDLE",
						message: `hobo up: no loadable bindle in ${projectDir}`,
						remediation: [
							"Add src/bindle.ts (or dist/bindle.js) exporting a default bindle.",
							"See examples/hello-bindle for the minimal shape.",
						],
						data: { command: "up", projectDir },
					};
				}

				emitProgress(
					`hobo up: remote broker ${target.uri} (mode=${target.mode}, source=${target.source})`,
				);

				const client =
					deps.createRemoteClient?.(target.uri) ??
					createRemoteBrokerClient({
						brokerUri: target.uri,
						...(deps.authMdFetch === undefined
							? undefined
							: { fetchImpl: deps.authMdFetch }),
						...(deps.discovery ? { discovery: deps.discovery } : undefined),
						...(deps.mockRemote
							? { mock: deps.mockRemote }
							: deps.createRemoteClient
								? undefined
								: {}),
					});

				let discovery: BrokerDiscoveryDocument;
				try {
					discovery = await client.discover();
				} catch (error) {
					if (error instanceof BrokerDiscoveryError) {
						return {
							ok: false,
							status: "discovery_failed",
							code: error.code,
							message: `hobo up: ${error.message}`,
							remediation: [
								"Verify the broker URI is reachable and serves /.well-known/hobo-broker.",
								"Run `hobo up` without --broker for the local embedded path.",
								`Try \`hobo login --broker ${target.uri}\` for authenticated remote use.`,
							],
							data: {
								command: "up",
								projectDir,
								brokerUri: target.uri,
							},
						};
					}
					throw error;
				}

				const agentCredential =
					discovery.resourceMetadataUrl === undefined
						? null
						: await presentAuthMdCredential({
								hoboHome,
								resource: target.uri,
								metadataUrl: discovery.resourceMetadataUrl,
								project: env.HOBO_PROJECT ?? definition.name,
								...(env.HOBO_TENANT === undefined
									? undefined
									: { tenant: env.HOBO_TENANT }),
								...(deps.authMdFetch === undefined
									? undefined
									: { fetchImpl: deps.authMdFetch }),
								operationUrl: new URL(
									discovery.placeEndpoint,
									`${target.uri}/`,
								).toString(),
							});
				const wantAnonymous = target.mode === "anonymous";
				if (wantAnonymous) {
					if (!discovery.supportsAnonymous) {
						return {
							ok: false,
							status: "anonymous_not_supported",
							code: "HOBO_ANON_NOT_SUPPORTED",
							message: `hobo up: broker ${discovery.brokerId} does not advertise anonymous/temporary deploy`,
							remediation: [
								`Run \`hobo login --broker ${target.uri}\` then \`hobo up --broker ${target.uri}\`.`,
								"Pick a broker that advertises supportsAnonymous in discovery.",
								"Fall back to local: `hobo up` with no --broker flags.",
							],
							data: {
								command: "up",
								projectDir,
								brokerUri: target.uri,
								brokerId: discovery.brokerId,
								authMethods: discovery.authMethods,
								supportsAnonymous: false,
							},
						};
					}

					emitProgress(
						"hobo up: requesting anonymous/temporary session (discovery allows)",
					);
					const session = await client.createAnonymousSession({
						bindleName: definition.name,
					});
					const credential =
						agentCredential ??
						presenter.presentAnonymous({
							audience: discovery.issuer,
							ephemeralPrincipal: session.ephemeralPrincipal,
							accessToken: session.accessToken,
							expiresAt: session.expiresAt,
						});
					const placed = await client.place({
						bindleName: definition.name,
						projectDir,
						camp: flags.camp,
						credential,
						anonymous: true,
						claimToken: session.claimToken,
					});

					await recordAuthMdDeployment(
						hoboHome,
						credential,
						placed.deploymentId,
					);

					const claimHint = `hobo claim <account> --broker ${target.uri} --token ${session.claimToken}`;
					emitProgress(
						`hobo up: temporary deployment ${placed.primaryUrl} — claim before ${session.expiresAt}`,
					);
					emitProgress(`hobo up: claim with: ${claimHint}`);

					return {
						ok: true,
						status: "deployed_anonymous",
						code: "HOBO_OK",
						message: `hobo up: anonymous deploy of ${definition.name} at ${placed.primaryUrl} (claim by ${session.expiresAt})`,
						data: {
							command: "up",
							projectDir,
							bindleName: definition.name,
							brokerUri: target.uri,
							brokerId: discovery.brokerId,
							mode: "anonymous",
							deploymentId: placed.deploymentId,
							primaryUrl: placed.primaryUrl,
							claimToken: session.claimToken,
							claimUrl: session.claimUrl,
							expiresAt: session.expiresAt,
							ttlSeconds: session.ttlSeconds,
							restrictions: session.restrictions,
							principal: credential.principal,
							principalKind: credential.principal.kind,
							credentialScheme: credential.scheme,
							resources: placed.resources,
							claimHint,
						},
					};
				}

				const credential =
					agentCredential ??
					(await presenter.presentAuthenticated({
						audience: discovery.issuer,
						hoboHome,
						env,
						requirePrincipal: true,
					}));
				if (credential === null) {
					return {
						ok: false,
						status: "no_principal",
						code: "HOBO_UP_NO_PRINCIPAL",
						message:
							"hobo up: authenticated remote deploy needs a principal (login or agent SVID)",
						remediation: [
							`Run \`hobo login --broker ${target.uri}\`.`,
							"Or set HOBO_AGENT_SVID / HOBO_AGENT_ID for a workload principal.",
							"Or use `--anonymous` / `--temporary` if the broker advertises support.",
							"Local fallback: `hobo up` with no --broker flags.",
						],
						data: {
							command: "up",
							projectDir,
							brokerUri: target.uri,
							brokerId: discovery.brokerId,
						},
					};
				}

				emitProgress(
					`hobo up: authenticated as ${credential.principal.kind}:${credential.principal.id} (${credential.scheme})`,
				);
				const placed = await client.place({
					bindleName: definition.name,
					projectDir,
					camp: flags.camp,
					credential,
					anonymous: false,
				});

				await recordAuthMdDeployment(hoboHome, credential, placed.deploymentId);

				return {
					ok: true,
					status: "deployed",
					code: "HOBO_OK",
					message: `hobo up: placed ${definition.name} on remote broker ${discovery.brokerId} as ${credential.principal.id}`,
					data: {
						command: "up",
						projectDir,
						bindleName: definition.name,
						brokerUri: target.uri,
						brokerId: discovery.brokerId,
						mode: "auth",
						deploymentId: placed.deploymentId,
						primaryUrl: placed.primaryUrl,
						principal: credential.principal,
						principalKind: credential.principal.kind,
						...(credential.humanPrincipal
							? {
									humanPrincipal: credential.humanPrincipal,
									humanPrincipalKind: credential.humanPrincipal.kind,
								}
							: undefined),
						credentialScheme: credential.scheme,
						resources: placed.resources,
						dualPrincipal: credential.humanPrincipal !== undefined,
					},
				};
			} catch (error) {
				if (error instanceof RemoteBrokerClientError) {
					return {
						ok: false,
						status: "remote_error",
						code: error.code,
						message: `hobo up: ${error.message}`,
						remediation: [
							`Run \`hobo login --broker <uri>\` for authenticated remote use.`,
							"Check discovery/anonymous support on the target broker.",
							"Local fallback: `hobo up` with no --broker flags.",
						],
						data: {
							command: "up",
							projectDir,
							hoboHome,
							...error.data,
						},
					};
				}
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					status: "error",
					code: "HOBO_UP_FAILED",
					message: `hobo up: ${message}`,
					remediation: [
						"Run `hobo yard ensure` if isolated-wasm tooling is missing.",
						"Use `hobo dev` for a long-lived serve on a free port.",
						"Re-run with --verbose for progress lines.",
					],
					data: { command: "up", projectDir, hoboHome, error: message },
				};
			}
		},
	};
}

function localTtlSeconds(raw: string | undefined): number {
	const value = raw === undefined ? 3600 : Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > 604800)
		throw new Error(
			"HOBO_LOCAL_DEPLOYMENT_TTL_SECONDS must be an integer from 1 to 604800",
		);
	return value;
}

async function runLocalUp(input: {
	readonly projectDir: string;
	readonly hoboHome: string;
	readonly definitionName: string;
	readonly persistent?: boolean;
	readonly start: typeof startLocalDeployment;
	readonly ttlSeconds?: number;
	readonly definition: NonNullable<
		Awaited<ReturnType<typeof loadBindleDefinition>>
	>;
	readonly emitProgress: (message: string) => void;
}) {
	const { projectDir, hoboHome, definition, emitProgress } = input;

	if (loadBareMetalYardConfig(hoboHome) === null) {
		emitProgress("hobo up: no Yard yet — installing local Yard + broker");
		initBareMetalYard({ hoboHome });
	}
	await ensureEmbeddedBroker({ hoboHome, emitProgress });

	const placement = await resolveBindlePlacement({
		definition,
		hoboHome,
		emitProgress,
	});
	if (placement.outcome === "rejected") {
		return {
			ok: false,
			status: "broker_rejected",
			code: "HOBO_UP_BROKER_REJECTED",
			message: `hobo up: ${placement.message}`,
			...(placement.remediation
				? { remediation: [...placement.remediation] }
				: undefined),
			data: {
				command: "up",
				projectDir,
				mode: "local",
				brokerId: placement.brokerId,
				rejection: placement.resolution.rejection,
			},
		};
	}

	emitProgress(`hobo up: ${placement.message}`);

	const port = await freePort();
	if (input.persistent) {
		const { receipt, reused } = await input.start({
			projectDir,
			hoboHome,
			componentHost: placement.componentHost,
			port,
			ttlSeconds: input.ttlSeconds ?? 0,
			bindleName: definition.name,
			brokerId: placement.brokerId,
			campId: placement.campId,
			providerId: placement.providerId,
		});
		return {
			ok: true,
			status: "deployed",
			code: "HOBO_OK",
			message: `hobo up: ${reused ? "reusing" : "running"} ${definition.name} at ${receipt.primaryUrl}`,
			data: {
				command: "up",
				projectDir,
				mode: "local",
				bindleName: definition.name,
				brokerId: receipt.brokerId,
				campId: receipt.campId,
				providerId: receipt.providerId,
				componentHost: receipt.componentHost,
				primaryUrl: receipt.primaryUrl,
				deploymentId: receipt.leaseId,
				pid: receipt.pid,
				persistent: true,
				reused,
				...(receipt.expiresAt ? { expiresAt: receipt.expiresAt } : undefined),
				probe: { status: receipt.probeStatus },
			},
		};
	}
	const serve = await serveProjectOnLocalYard({
		projectDir,
		hoboHome,
		componentHost: placement.componentHost,
		port,
		emitProgress,
	});
	const primaryUrl = serve.primaryUrl;
	const exposedEndpoints = serve.exposedEndpoints;
	const serviceDiscovery = serve.serviceDiscovery;
	const probe = serve.probe;
	await serve.close();

	return {
		ok: true,
		status: "deployed",
		code: "HOBO_OK",
		message: `hobo up: placed ${definition.name} via broker on ${placement.providerId} (camp ${placement.campId}, host ${placement.componentHost})`,
		data: {
			command: "up",
			projectDir,
			mode: "local",
			bindleName: definition.name,
			brokerId: placement.brokerId,
			campId: placement.campId,
			yardName: placement.yardName,
			providerId: placement.providerId,
			componentHost: placement.componentHost,
			placements: placement.resolution.receipt?.placements ?? [],
			primaryUrl,
			exposedEndpoints,
			serviceDiscovery,
			probe,
		},
	};
}

export function createBrokerAwareUpCommandWithMock(options?: {
	readonly supportsAnonymous?: boolean;
	readonly brokerUri?: string;
}) {
	const mock = createMockRemoteBrokerState({
		brokerUri: options?.brokerUri ?? "https://public.example.com",
		...(options?.supportsAnonymous !== undefined
			? { supportsAnonymous: options.supportsAnonymous }
			: undefined),
	});
	const discovery = createBrokerDiscoveryClient({
		fixed: new Map([
			[mock.discovery.issuer.replace(/\/+$/, ""), mock.discovery],
		]),
	});
	return {
		mock,
		command: createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery,
		}),
	};
}
