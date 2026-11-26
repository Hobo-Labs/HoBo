import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createWasmRuntimeHost,
	PINNED_WASMTIME_VERSION,
	resolvePrivateWasmGuest,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("@hobo/runtime-wasm", () => {
	it("exposes kind wasm and pinned wasmtime floor", () => {
		const host = createWasmRuntimeHost();
		expect(host.kind).toBe("wasm");
		expect(PINNED_WASMTIME_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("ensure reports ready toolchain under HOBO_HOME", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-wasm-ensure-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const host = createWasmRuntimeHost();
		const result = await host.ensure({ hoboHome });
		expect(result.kind).toBe("wasm");
		expect(result.ready).toBe(true);
		expect(result.notes.length).toBeGreaterThan(0);
		expect(result.details?.wasmtimeVersion).toMatch(/^\d+\.\d+\.\d+$/);
	}, 180_000);

	it("resolves private guest from src/<resourceName>.ts", () => {
		const projectDir = join(
			import.meta.dirname,
			"..",
			"..",
			"..",
			"..",
			"examples",
			"hello-bindle",
		);
		const resolved = resolvePrivateWasmGuest({
			projectDir,
			resourceName: "api",
		});
		expect(resolved.appModulePath).toMatch(/src[/\\]api\.ts$/);
	});
});
