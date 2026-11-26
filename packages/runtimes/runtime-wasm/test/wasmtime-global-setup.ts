/**
 * Vitest globalSetup: warm a shared wasmtime toolchain cache once per run.
 *
 * Wasm-dependent tests use throwaway HOBO_HOME dirs, so without this hook every
 * test re-downloads the ~40MB wasmtime release and re-probes it; under parallel
 * turbo/vitest sweeps that saturates the box and flakes timeouts. Here we ensure
 * the toolchain once into the default HOBO_HOME cache (env/PATH/default-home
 * probes are all cheap no-ops when warm) and export HOBO_WASMTIME_BIN so every
 * worker resolves the pre-seeded binary instead of downloading per test.
 *
 * Real-user semantics are untouched: tests still exercise the same
 * ensure/probe/download code paths; the env override is a supported resolution
 * source (source: "env").
 */
import { defaultHoboHome, ensureWasmtimeBinary } from "../src/index.js";

export default async function setup(): Promise<void> {
	if (process.env.HOBO_WASMTIME_BIN) return; // caller pre-seeded; respect it.
	try {
		const wasmtime = await ensureWasmtimeBinary({
			hoboHome: defaultHoboHome(),
		});
		process.env.HOBO_WASMTIME_BIN = wasmtime.binPath;
	} catch (error) {
		// Offline / download failure: leave env unset so tests fall back to the
		// per-test behavior (own download or explicit skip), exactly as before.
		console.warn(
			`wasmtime global setup: warm cache unavailable (${String(error)}); tests will resolve wasmtime individually`,
		);
	}
}
