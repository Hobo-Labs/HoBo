/**
 * Re-exports from `@hobo/runtime-wasm` for back-compat.
 * Prefer importing from `@hobo/runtime-wasm` in new code.
 */
export {
	applyHoboMeshEnvHeaders,
	bootWasmtimeSandbox,
	bundleAppModuleAsWasiHttpGuest,
	type ComponentizeResult,
	componentizePrivateGuest,
	defaultHoboHome,
	ensureIsolatedWasmToolchain,
	ensureWasmtimeBinary,
	type FetchHandler,
	HOBO_BINDLE_ENV_HEADER,
	HOBO_ENV_HEADER_PREFIX,
	type IsolatedWasmToolchain,
	type JcoTool,
	PINNED_WASMTIME_VERSION,
	preparePrivateWasmComponent,
	type ResolvedPrivateGuest,
	resolvePrivateWasmGuest,
	type WasmtimeBinary,
	type WasmtimeSandbox,
} from "@hobo/runtime-wasm";
