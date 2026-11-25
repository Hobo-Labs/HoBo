import type { CommandModule } from "@hobo/cli";
import {
	COMPONENT_HOST_KINDS,
	type ComponentHostKind,
	defaultHoboHome,
	initBareMetalYard,
	loadBareMetalYardConfig,
	normalizeComponentHostKind,
	yardConfigPath,
} from "./bare-metal-yard.js";
import { ensureEmbeddedBroker } from "./broker-runtime.js";
import { ensureAllRuntimeHosts, getRuntimeHost } from "./host-registry.js";
import { isJsonNumber, isJsonString, type JsonValue } from "./json.js";
import { probeWasmHostInstall } from "./wasm-host.js";

// `hobo yard` — install/inspect a **Yard** (glossary: provider-specific control
// plane). Camps are placement targets the Yard creates when serving Bindles.
//   hobo yard init [--force] [--port <n>] [--host local|wasm|oci|cloud-native]
//     aliases: isolated-wasm→wasm, bare-metal|runtime-local→local
//   hobo yard ensure  — ensure all registered host runtimes
//   hobo yard status | doctor

function parseComponentHostFlag(
	raw: JsonValue | undefined,
): ComponentHostKind | undefined {
	if (raw === undefined || raw === null) return undefined;
	try {
		return normalizeComponentHostKind(String(raw));
	} catch {
		return undefined;
	}
}

export function createYardCommand(): CommandModule {
	return {
		implemented: true,
		run: async ({ args, flags, context, emitProgress }) => {
			const subcommand = args[0] ?? "status";
			// SAFETY: assertion required at this I/O or test boundary.
			const env = (context as { env?: NodeJS.ProcessEnv }).env ?? process.env;
			const hoboHome = isJsonString(flags.home)
				? flags.home
				: defaultHoboHome(env);

			if (subcommand === "init") {
				const portRaw = flags.port;
				const defaultPort =
					isJsonString(portRaw) || isJsonNumber(portRaw)
						? Number(portRaw)
						: undefined;
				if (
					defaultPort !== undefined &&
					(!Number.isInteger(defaultPort) || defaultPort <= 0)
				) {
					return {
						ok: false,
						status: "invalid_port",
						code: "HOBO_YARD_USAGE",
						message: "hobo yard init: --port must be a positive integer",
						remediation: ["Example: hobo yard init --port 4000"],
						data: { command: "yard" },
					};
				}
				const hostFlag = flags.host;
				const componentHost = parseComponentHostFlag(hostFlag);
				if (
					hostFlag !== undefined &&
					hostFlag !== null &&
					componentHost === undefined
				) {
					return {
						ok: false,
						status: "invalid_host",
						code: "HOBO_YARD_USAGE",
						message: `hobo yard init: --host (Camp component host) must be one of ${COMPONENT_HOST_KINDS.join("|")} (aliases: isolated-wasm→wasm)`,
						remediation: [
							"Example: hobo yard init --host local",
							"Example: hobo yard init --host wasm",
							"Example: hobo yard init --host oci",
							"Example: hobo yard init --host cloud-native",
							"Yard = control plane; --host selects the Camp component host backend.",
						],
						data: { command: "yard" },
					};
				}
				try {
					const embedded = await ensureEmbeddedBroker({
						hoboHome,
						emitProgress,
					});
					const preferredHost = normalizeComponentHostKind(
						componentHost ?? embedded.state.preferredComponentHost,
					);
					const { config, configPath } = initBareMetalYard({
						hoboHome,
						force: flags.force === true,
						...(defaultPort !== undefined ? { defaultPort } : undefined),
						componentHost: preferredHost,
					});
					const hostEnsure = await getRuntimeHost(config.componentHost).ensure({
						hoboHome,
						env,
						emitProgress,
					});
					const wasm = probeWasmHostInstall({ env });
					return {
						ok: true,
						status: "initialized",
						code: "HOBO_YARD_INIT",
						message: `hobo yard init: Yard '${config.name}' componentHost=${config.componentHost} at ${configPath}; broker ${embedded.state.brokerId}; host ready=${hostEnsure.ready}`,
						data: {
							command: "yard",
							configPath,
							config,
							wasm,
							broker: embedded.state,
							hostEnsure,
						},
					};
				} catch (error) {
					return {
						ok: false,
						status: "init_failed",
						code: "HOBO_YARD_INIT_FAILED",
						message: `hobo yard init: ${error instanceof Error ? error.message : String(error)}`,
						remediation: [
							"If yard.json already exists, first-run succeeded — run `hobo yard status`.",
							"Pass --force only to overwrite an existing yard.json.",
							"Set HOBO_HOME to choose an alternate install root.",
							"Default host is local process. Use --host wasm only when you want Wasmtime sandboxes.",
							"Use --host oci for WASM-on-OCI / Kubernetes.",
							"Run `hobo yard ensure` to install optional host toolchains.",
						],
						data: { command: "yard" },
					};
				}
			}

			if (subcommand === "ensure") {
				try {
					const hosts = await ensureAllRuntimeHosts({
						hoboHome,
						env,
						emitProgress,
					});
					const allReady = hosts.every((h) => h.ready);
					return {
						ok: allReady,
						status: allReady ? "ready" : "partial",
						code: allReady ? "HOBO_YARD_ENSURE" : "HOBO_YARD_ENSURE_PARTIAL",
						message: `hobo yard ensure: ${hosts.map((h) => `${h.kind}=${h.ready ? "ready" : "not-ready"}`).join(", ")} under ${hoboHome}`,
						data: {
							command: "yard",
							subcommand: "ensure",
							hoboHome,
							hosts,
						},
					};
				} catch (error) {
					return {
						ok: false,
						status: "ensure_failed",
						code: "HOBO_YARD_ENSURE_FAILED",
						message: `hobo yard ensure: ${error instanceof Error ? error.message : String(error)}`,
						remediation: [
							"Ensure network access to download wasmtime, or set HOBO_WASMTIME_BIN.",
							"Install kubectl and ensure KUBECONFIG points at a cluster for oci host.",
							"Override kubectl with HOBO_KUBECTL_BIN; runtime image via HOBO_OCI_RUNTIME_IMAGE.",
							"Set HOBO_HOME if the Yard tools dir should not be ~/.hobo.",
						],
						data: { command: "yard", subcommand: "ensure", hoboHome },
					};
				}
			}

			if (subcommand === "status") {
				const config = loadBareMetalYardConfig(hoboHome);
				if (config === null) {
					return {
						ok: false,
						status: "not_installed",
						code: "HOBO_YARD_MISSING",
						message: `hobo yard status: no local Yard at ${yardConfigPath(hoboHome)}`,
						remediation: [
							"Run `hobo yard init` (optionally `--host wasm|oci|cloud-native`).",
						],
						data: {
							command: "yard",
							configPath: yardConfigPath(hoboHome),
							hoboHome,
						},
					};
				}
				return {
					ok: true,
					status: "installed",
					code: "HOBO_YARD_STATUS",
					message: `hobo yard status: Yard '${config.name}' componentHost=${config.componentHost} (provider ${config.providerId}, port ${config.defaultPort})`,
					data: {
						command: "yard",
						configPath: yardConfigPath(hoboHome),
						hoboHome,
						config,
					},
				};
			}

			if (subcommand === "doctor") {
				const config = loadBareMetalYardConfig(hoboHome);
				const componentHost = config?.componentHost ?? "local";
				let hostEnsure: Awaited<
					ReturnType<ReturnType<typeof getRuntimeHost>["ensure"]>
				> | null = null;
				let hostError: string | null = null;
				try {
					hostEnsure = await getRuntimeHost(componentHost).ensure({
						hoboHome,
						env,
						emitProgress,
					});
				} catch (error) {
					hostError = error instanceof Error ? error.message : String(error);
				}
				const wasm = probeWasmHostInstall({ env });
				const ok = config !== null && hostEnsure?.ready === true;
				return {
					ok,
					status: ok
						? "healthy"
						: config === null
							? "missing_config"
							: "host_not_ready",
					code: ok
						? "HOBO_YARD_DOCTOR"
						: config === null
							? "HOBO_YARD_MISSING"
							: "HOBO_YARD_HOST_NOT_READY",
					message: ok
						? `hobo yard doctor: Yard componentHost=${componentHost}; engine=${wasm.engineSource} ${wasm.engineVersion}; host ready`
						: config === null
							? `hobo yard doctor: no Yard config — run hobo yard init`
							: `hobo yard doctor: host ${componentHost} not ready — ${hostError ?? "run hobo yard ensure"}`,
					...(ok
						? undefined
						: {
								remediation: [
									config === null
										? "Run `hobo yard init [--host local|wasm|oci|cloud-native]`."
										: "Run `hobo yard ensure` to install host toolchains.",
								],
							}),
					data: {
						command: "yard",
						hoboHome,
						config,
						wasm,
						...(hostEnsure !== null ? { hostEnsure } : undefined),
						...(hostError !== null ? { hostError } : undefined),
						scopes: {
							yard: "provider-specific control plane (this config)",
							camp: "placement target created when serving a Bindle (e.g. dev-local)",
							componentHost:
								"Camp capability that executes components (local | wasm | oci | cloud-native)",
							bindle: "app topology placed into a Camp",
							meshEnv:
								'bindle .with({option:"env"}) values injected on private hops as x-hobo-env-*',
						},
						componentHosts: wasm.componentHosts,
					},
				};
			}

			return {
				ok: false,
				status: "unknown_subcommand",
				code: "HOBO_YARD_USAGE",
				message: `hobo yard: unknown subcommand '${subcommand}'`,
				remediation: [
					"Use `hobo yard init [--force] [--port <n>] [--host local|wasm|oci|cloud-native]`.",
					"Use `hobo yard ensure` to install all host toolchains.",
					"Use `hobo yard status` or `hobo yard doctor`.",
					"Yard = control plane; Camp = placement; component host = Camp execution capability.",
				],
				data: { command: "yard" },
			};
		},
	};
}
