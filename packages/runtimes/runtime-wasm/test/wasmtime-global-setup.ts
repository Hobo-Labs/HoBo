import { defaultHoboHome, ensureWasmtimeBinary } from "../src/index.js";

export default async function setup(): Promise<void> {
	if (process.env.HOBO_WASMTIME_BIN) return;
	try {
		const wasmtime = await ensureWasmtimeBinary({
			hoboHome: defaultHoboHome(),
		});
		process.env.HOBO_WASMTIME_BIN = wasmtime.binPath;
	} catch (error) {
		console.warn(
			`wasmtime global setup: warm cache unavailable (${String(error)}); tests will resolve wasmtime individually`,
		);
	}
}
