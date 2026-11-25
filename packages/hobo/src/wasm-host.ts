/**
 * Local Yard serve dispatch (glossary-aligned).
 *
 * Yard = control plane (`hobo yard init`).
 * Camp = placement target created when serving a Bindle.
 * Component host = Camp capability that executes components:
 *   - local: process-local mesh (`@hobo/runtime-local`)
 *   - wasm: Wasmtime OS-process sandboxes (`@hobo/runtime-wasm`)
 *   - oci: WASM-on-OCI / Kubernetes (`@hobo/runtime-oci`)
 *   - cloud-native: multi-cloud registry (`@hobo/runtime-cloud-native`)
 */

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
		/** @deprecated alias of wasm */
		readonly "isolated-wasm": string;
	};
	/** @deprecated use componentHosts */
	readonly tiers: WasmHostProbe["componentHosts"];
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
		"isolated-wasm":
			"wasmtime OS-process sandboxes for private components" as const,
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
				tiers: componentHosts,
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
		tiers: componentHosts,
	};
}

/** @deprecated use serveBindleOnLocalYard */
export async function serveProjectOnWasmHost(
	options: Parameters<typeof serveBindleOnLocalYard>[0],
): Promise<BareMetalServeResult & { readonly componentHost: string }> {
	const result = await serveBindleOnLocalYard(options);
	return { ...result, componentHost: "local" };
}

/** Place a Bindle on the local Yard using the configured Camp component host. */
export async function serveProjectOnLocalYard(options: {
	readonly projectDir: string;
	readonly yard?: BareMetalYard;
	readonly port?: number;
	readonly hoboHome?: string;
	readonly emitProgress?: (message: string) => void;
	readonly componentHost?:
		| ComponentHostKind
		| "bare-metal"
		| "runtime-local"
		| "isolated-wasm"
		| string;
	/** @deprecated use componentHost */
	readonly host?:
		| ComponentHostKind
		| "bare-metal"
		| "runtime-local"
		| "isolated-wasm"
		| string;
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
	const componentHost = normalizeComponentHostKind(
		options.componentHost ??
			options.host ??
			yard.config.componentHost ??
			yard.config.host,
	);

	const wrapClose = <T extends { close: () => Promise<void> }>(
		result: T,
	): T => {
		if (owned === null) return result;
		const inner = result.close.bind(result);
		return {
			...result,
			close: async () => {
				await inner();
				owned.close();
			},
		};
	};

	// local keeps the dedicated path (runtime-local component host lifecycle
	// for both public and private) for back-compat with existing tests.
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
}
