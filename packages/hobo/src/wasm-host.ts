import { must } from "@hobo/core/total-access";
import {
	createInProcessWasmtimeEngine,
	createWasmtimeCliEngine,
} from "@hobo/runtime-local";
import { PINNED_WASMTIME_VERSION } from "@hobo/runtime-wasm";
import type { BareMetalServeResult } from "./bare-metal-host.js";
import {
	type BareMetalYard,
	type ComponentHostKind,
	normalizeComponentHostKind,
} from "./bare-metal-yard.js";
import { isJsonString, type JsonObject } from "./json.js";
import { serveBindleOnLocalYard } from "./local-yard-serve.js";
import { serveProjectOnHost } from "./multi-host-serve.js";

export interface WasmHostProbe {
	readonly engineKind: "wasmtime";
	readonly engineSource: "cli" | "in-process";
	readonly engineVersion: string;
	readonly wasmtimeCliAvailable: boolean;
	readonly notes: readonly string[];
	readonly componentHosts: {
		readonly local: string;
		readonly wasm: string;
		readonly oci: string;
		readonly "cloud-native": string;
	};
}

export function probeWasmHostInstall(
	options: { readonly binPath?: string; readonly env?: NodeJS.ProcessEnv } = {},
): WasmHostProbe {
	const env = options.env ?? process.env;
	const candidates = [
		options.binPath,
		env.HOBO_WASMTIME_BIN,
		env.HOME ? `${env.HOME}/.hobo/tools/wasmtime` : undefined,
		"wasmtime",
	].filter((value): value is string => isJsonString(value) && value.length > 0);

	const notes: string[] = [];
	const componentHosts = {
		local: "process-local mesh + component host (Camp capability)" as const,
		wasm: "wasmtime OS-process sandboxes for private components" as const,
		oci: "WASM-on-OCI scheduled on Kubernetes" as const,
		"cloud-native":
			"multi-cloud host registry (aws/gcp/azure/vercel/cloudflare)" as const,
	};

	let lastError = "wasmtime not found";
	for (const binPath of candidates) {
		try {
			const engine = createWasmtimeCliEngine({ binPath });
			notes.push(`wasmtime CLI ok (${engine.version}) at ${binPath}`);
			notes.push(
				"Yard places Camps; component host is a Camp capability (not the Yard itself)",
			);
			notes.push(
				`wasm host uses real .wasm + wasmtime serve (pinned ${PINNED_WASMTIME_VERSION})`,
			);
			notes.push(
				"oci host packs WASM as OCI and schedules on Kubernetes via kubectl",
			);
			return {
				engineKind: "wasmtime",
				engineSource: "cli",
				engineVersion: engine.version,
				wasmtimeCliAvailable: true,
				notes,
				componentHosts,
			};
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	notes.push(`wasmtime CLI unavailable: ${lastError}`);
	notes.push(
		`wasm will auto-download wasmtime ${PINNED_WASMTIME_VERSION} into ~/.hobo/tools on first serve`,
	);
	notes.push(
		"local component host still runs (in-process engine; no .wasm bytes)",
	);
	const engine = createInProcessWasmtimeEngine();
	return {
		engineKind: "wasmtime",
		engineSource: "in-process",
		engineVersion: engine.version,
		wasmtimeCliAvailable: false,
		notes,
		componentHosts,
	};
}

export async function serveProjectOnLocalYard(options: {
	readonly projectDir: string;
	readonly yard?: BareMetalYard;
	readonly port?: number;
	readonly hoboHome?: string;
	readonly emitProgress?: (message: string) => void;
	readonly componentHost?: ComponentHostKind;
}): Promise<
	BareMetalServeResult & {
		readonly componentHost: string;
		readonly isolation?: {
			readonly privateWorkers: number;
			readonly privateSandboxes?: number;
			readonly meshHost: string;
			readonly isolateBoundary: string;
			readonly wasmtimeVersion?: string;
			readonly wasmPaths?: readonly string[];
			readonly details?: JsonObject;
		};
	}
> {
	const owned =
		options.yard === undefined
			? (await import("./bare-metal-yard.js")).openBareMetalYard({
					...(options.hoboHome !== undefined
						? { hoboHome: options.hoboHome }
						: undefined),
				})
			: null;
	const yard = options.yard ?? must(owned);
	const wrapClose = <T extends { close: () => Promise<void> }>(
		result: T,
	): T => {
		if (owned === null) return result;
		const inner = result.close.bind(result);
		return {
			...result,
			close: async () => {
				try {
					await inner();
				} finally {
					owned.close();
				}
			},
		};
	};

	try {
		const componentHost = normalizeComponentHostKind(
			options.componentHost ?? yard.config.componentHost,
		);
		if (componentHost === "local") {
			const result = await serveBindleOnLocalYard({
				...options,
				yard,
			});
			return wrapClose({ ...result, componentHost: "local" });
		}
		const result = await serveProjectOnHost({
			...options,
			yard,
			componentHost,
		});
		return wrapClose(result);
	} catch (error) {
		owned?.close();
		throw error;
	}
}
