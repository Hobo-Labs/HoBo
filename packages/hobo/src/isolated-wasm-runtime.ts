import type { INTERNAL_MESH_HOST } from "./bare-metal-host.js";
import type { BareMetalYard } from "./bare-metal-yard.js";
import {
	type MultiHostServeResult,
	serveProjectOnHost,
} from "./multi-host-serve.js";

export type IsolatedWasmServeResult = MultiHostServeResult & {
	readonly componentHost: "wasm";
	readonly isolation: NonNullable<MultiHostServeResult["isolation"]> & {
		readonly isolateBoundary: "wasmtime_process" | string;
		readonly meshHost: typeof INTERNAL_MESH_HOST;
	};
};

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
	return result as IsolatedWasmServeResult;
}
