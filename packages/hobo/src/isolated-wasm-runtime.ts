/**
 * Isolated-wasm Camp component host — thin wrapper over multi-host serve
 * with `componentHost=wasm` (legacy name: isolated-wasm).
 */

import type { INTERNAL_ROUTER_HOST } from "./bare-metal-host.js";
import type { BareMetalYard } from "./bare-metal-yard.js";
import {
	type MultiHostServeResult,
	serveProjectOnHost,
} from "./multi-host-serve.js";

export type IsolatedWasmServeResult = MultiHostServeResult & {
	readonly componentHost: "wasm";
	readonly isolation: NonNullable<MultiHostServeResult["isolation"]> & {
		readonly isolateBoundary: "wasmtime_process" | string;
		readonly meshHost: typeof INTERNAL_ROUTER_HOST;
	};
};

/**
 * Place a Bindle into a Camp on the local Yard using the wasm
 * component host (real Wasmtime OS-process sandboxes for private components).
 */
export async function serveProjectOnIsolatedWasm(options: {
	readonly projectDir: string;
	readonly yard?: BareMetalYard;
	readonly port?: number;
	readonly hoboHome?: string;
	readonly emitProgress?: (message: string) => void;
}): Promise<IsolatedWasmServeResult> {
	const result = await serveProjectOnHost({
		...options,
		componentHost: "wasm",
	});
	// SAFETY: assertion required at this I/O or test boundary.
	return result as IsolatedWasmServeResult;
}
