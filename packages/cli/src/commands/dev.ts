import {
	deploymentIdFor,
	loadProjectManifest,
	missingProjectBindle,
} from "../cloud/manifest.js";
import { stubResult } from "../cloud/stub.js";
import {
	bootLocalCamp,
	DEV_COLD_BUDGET_MS,
	type DevRuntime,
} from "../dev/local-camp.js";
import { isJsonNumber, isJsonString } from "../json.js";
import type { CommandModule } from "../shell/registry.js";

export interface DevServeResult {
	readonly primaryUrl: string;
	readonly bindleName: string;
	readonly campId: string;
	readonly yardName: string;
	readonly providerId: string;
	readonly endpoints: readonly {
		readonly resourceName: string;
		readonly kind: string;
		readonly url: string;
		readonly port: number | null;
		readonly external: boolean;
		readonly serviceDiscoveryKey: string;
	}[];
	readonly exposedEndpoints?: readonly {
		readonly resourceName: string;
		readonly kind: string;
		readonly url: string;
		readonly port: number | null;
		readonly external: boolean;
		readonly serviceDiscoveryKey: string;
	}[];
	readonly serviceDiscovery: Readonly<Record<string, string>>;
	readonly bindleEnv?: Readonly<Record<string, string>>;
	readonly namedEndpoints?: readonly {
		readonly resourceName: string;
		readonly hostname: string;
		readonly url: string;
		readonly backendUrl: string;
		readonly mode: "local" | "overlay";
		readonly external: boolean;
		readonly serviceDiscoveryKey: string;
	}[];
	readonly primaryNamedUrl?: string | null;
	readonly componentHost?: string;
	readonly probe: { readonly status: number; readonly body: string };
	readonly close: () => Promise<void>;
	readonly waitUntilStopped: () => Promise<void>;
}

export interface DevCommandDeps {
	readonly runtime?: DevRuntime;
	readonly resolveRuntime?: (projectDir: string) => Promise<DevRuntime | null>;
	readonly serveProject?: (input: {
		readonly projectDir: string;
		readonly port?: number;
		readonly once: boolean;
		readonly emitProgress: (message: string) => void;
	}) => Promise<DevServeResult>;
}

export function createDevCommand(deps: DevCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(
			deps.serveProject ?? deps.runtime ?? deps.resolveRuntime,
		),
		run: async ({ context, flags, emitProgress }) => {
			const projectDir = context.projectDir ?? context.cwd;
			const forceServe = flags.serve === true;
			const once =
				flags.once === true ||
				flags.json === true ||
				(!forceServe && (!process.stdin.isTTY || !process.stdout.isTTY));
			if (
				once &&
				flags.once !== true &&
				flags.json !== true &&
				!forceServe &&
				(!process.stdin.isTTY || !process.stdout.isTTY)
			) {
				emitProgress(
					"hobo dev: non-interactive terminal detected — running one-shot probe and exiting. Run `hobo dev` in an interactive terminal, or pass `--serve`, for the long-lived dev server.",
				);
			}
			const portRaw = flags.port;
			const port =
				isJsonString(portRaw) || isJsonNumber(portRaw)
					? Number(portRaw)
					: undefined;

			if (deps.serveProject) {
				const startedAt = Date.now();
				try {
					const serve = await deps.serveProject({
						projectDir,
						...(port !== undefined && Number.isInteger(port)
							? { port }
							: undefined),
						once,
						emitProgress,
					});
					const bootMs = Date.now() - startedAt;
					const ok = serve.probe.status === 200 && bootMs <= DEV_COLD_BUDGET_MS;
					if (!once) {
						emitProgress(
							`hobo dev: listening on ${serve.primaryUrl} (Ctrl-C to stop)`,
						);
						await serve.waitUntilStopped();
					} else {
						await serve.close();
					}
					return {
						ok,
						status: ok ? "serving" : "degraded",
						code: ok ? "HOBO_OK" : "HOBO_DEV_DEGRADED",
						message: ok
							? `hobo dev serving ${serve.primaryUrl} on Yard '${serve.yardName}' Camp ${serve.campId} componentHost=${serve.componentHost ?? "local"} (bindle ${serve.bindleName}, booted in ${bootMs}ms)`
							: `hobo dev booted but did not serve cleanly (status ${serve.probe.status}, ${bootMs}ms)`,
						data: {
							command: "dev",
							mode: "local-yard",
							componentHost: serve.componentHost ?? "local",
							deploymentId: deploymentIdFor(projectDir),
							localUrl: serve.primaryUrl,
							runtime:
								serve.componentHost === "isolated-wasm"
									? "isolated-wasm"
									: "local",
							yard: serve.yardName,
							campId: serve.campId,
							providerId: serve.providerId,
							bindleName: serve.bindleName,
							endpoints: serve.endpoints,
							...(serve.exposedEndpoints !== undefined
								? { exposedEndpoints: serve.exposedEndpoints }
								: undefined),
							serviceDiscovery: serve.serviceDiscovery,
							...(serve.bindleEnv !== undefined
								? { bindleEnv: serve.bindleEnv }
								: undefined),
							...(serve.namedEndpoints !== undefined
								? { namedEndpoints: serve.namedEndpoints }
								: undefined),
							...(serve.primaryNamedUrl !== undefined
								? {
										primaryNamedUrl: serve.primaryNamedUrl,
										localNamedUrl: serve.primaryNamedUrl,
									}
								: undefined),
							offline: true,
							bootMs,
							withinColdBudget: bootMs <= DEV_COLD_BUDGET_MS,
							coldBudgetMs: DEV_COLD_BUDGET_MS,
							served: serve.probe,
							once,
						},
					};
				} catch (error) {
					emitProgress(
						`hobo dev: bare-metal serve unavailable (${error instanceof Error ? error.message : String(error)}); falling back to runtime-local probe`,
					);
				}
			}

			const runtime =
				deps.runtime ?? (await deps.resolveRuntime?.(projectDir)) ?? null;
			if (!runtime) {
				return stubResult("dev");
			}

			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return missingProjectBindle("dev", projectDir);
			}

			const deploymentId = deploymentIdFor(projectDir);
			const boot = await bootLocalCamp(runtime, { deploymentId, emitProgress });
			const ok = boot.served.status === 200 && boot.withinColdBudget;

			return {
				ok,
				status: ok ? "serving" : "degraded",
				code: ok ? "HOBO_OK" : "HOBO_DEV_DEGRADED",
				message: ok
					? `hobo dev serving ${boot.localUrl} on ${boot.runtime} (offline, booted in ${boot.bootMs}ms)`
					: `hobo dev booted but did not serve cleanly (status ${boot.served.status}, ${boot.bootMs}ms)`,
				data: {
					command: "dev",
					mode: "runtime-local-probe",
					deploymentId,
					localUrl: boot.localUrl,
					runtime: boot.runtime,
					offline: boot.offline,
					bootMs: boot.bootMs,
					withinColdBudget: boot.withinColdBudget,
					coldBudgetMs: DEV_COLD_BUDGET_MS,
					served: boot.served,
					linkedComponents: boot.linkedComponents,
					events: boot.events.map((event) => event.type),
					streamedFrames: boot.streamedFrames,
				},
			};
		},
	};
}
