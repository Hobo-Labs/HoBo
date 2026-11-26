import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { first, must } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";
import {
	ensureIsolatedWasmToolchain,
	HOBO_ENV_HEADER_PREFIX,
	INTERNAL_ROUTER_HOST,
	initBareMetalYard,
	PINNED_WASMTIME_VERSION,
	probeWasmHostInstall,
	resolvePrivateWasmGuest,
	serveBindleOnLocalYard,
	serveProjectOnIsolatedWasm,
	serveProjectOnLocalYard,
} from "../src/index.js";

const helloBindleDir = fileURLToPath(
	new URL("../../../examples/hello-bindle", import.meta.url),
);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

describe("Yard / Camp / component host + hobo-managed sandboxes", () => {
	it("probes component-host tiers on the local Yard", () => {
		const probe = probeWasmHostInstall();
		expect(probe.engineKind).toBe("wasmtime");
		expect(probe.componentHosts.local).toContain("Camp capability");
		expect(probe.componentHosts.wasm).toContain("wasmtime OS-process");
		expect(probe.componentHosts.oci).toContain("Kubernetes");
		expect(probe.componentHosts["cloud-native"]).toContain("multi-cloud");
		// Legacy alias key still present on probe.
		expect(probe.componentHosts["isolated-wasm"]).toContain(
			"wasmtime OS-process",
		);
	});

	it("hobo yard ensure installs host runtimes under HOBO_HOME", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-ensure-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const cli = createComposedHoboCli();
		const result = await cli.run(
			["yard", "ensure", "--home", hoboHome, "--json"],
			{ cwd: hoboHome },
		);
		expect(result.stdout.length).toBeGreaterThan(0);
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			code: string;
			message?: string;
			data: {
				hosts: Array<{
					kind: string;
					ready: boolean;
					details?: { wasmtimeVersion?: string };
				}>;
			};
		};
		expect(envelope.ok, envelope.message ?? result.stdout).toBe(true);
		expect(envelope.code).toBe("HOBO_YARD_ENSURE");
		expect(envelope.data.hosts.every((h) => h.ready)).toBe(true);
		const wasmHost = envelope.data.hosts.find((h) => h.kind === "wasm");
		expect(wasmHost?.details?.wasmtimeVersion).toMatch(/^\d+\.\d+\.\d+$/);
	}, 180_000);

	it("hobo yard init --host wasm (and isolated-wasm alias) records config", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-iso-home-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const cli = createComposedHoboCli();
		const init = await cli.run(
			["yard", "init", "--home", hoboHome, "--host", "isolated-wasm", "--json"],
			{ cwd: hoboHome },
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(init.stdout) as {
			ok: boolean;
			message: string;
			data: {
				config: { componentHost: string; host: string };
				hostEnsure?: { ready: boolean; details?: { wasmtimeVersion?: string } };
			};
		};
		expect(envelope.ok).toBe(true);
		// Alias isolated-wasm normalizes to wasm.
		expect(envelope.data.config.componentHost).toBe("wasm");
		expect(envelope.data.config.host).toBe("wasm");
		expect(envelope.message).toContain("componentHost=wasm");
		expect(envelope.data.hostEnsure?.ready).toBe(true);
		expect(envelope.data.hostEnsure?.details?.wasmtimeVersion).toMatch(
			/^\d+\.\d+\.\d+$/,
		);
	}, 120_000);

	it("local component host: Yard places Camp; only web is public", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-local-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		const port = 23000 + Math.floor(Math.random() * 500);
		const serve = await serveBindleOnLocalYard({
			projectDir: helloBindleDir,
			hoboHome,
			port,
		});
		cleanups.push(() => serve.close());

		expect(serve.componentHost).toBe("local");
		expect(serve.yard.kind).toBe("yard");
		expect(serve.campId).toContain("dev");
		expect(serve.exposedEndpoints).toHaveLength(1);
		expect(serve.exposedEndpoints[0]?.resourceName).toBe("web");
		const api = serve.endpoints.find((e) => e.resourceName === "api");
		expect(api?.port).toBeNull();
		expect(api?.url).toBe(`http://hello-bindle.${INTERNAL_ROUTER_HOST}/api`);

		const html = await (await fetch(`${serve.primaryUrl}/?name=Local`)).text();
		// Bindle injects GREETING_PREFIX/APP_TITLE via env() — proves apps are live.
		expect(html).toContain("howdy, Local");
		expect(html).toContain("howdy");
		expect(serve.bindleEnv).toEqual({
			GREETING_PREFIX: "howdy",
			APP_TITLE: "howdy",
		});
	});

	it("wasm host via hobo path: private api in wasmtime sandbox (defaults)", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-iso-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));

		// Toolchain + yard via hobo APIs (same path as CLI ensure/init).
		await ensureIsolatedWasmToolchain({ hoboHome });
		initBareMetalYard({ hoboHome, componentHost: "wasm" });

		const port = 24000 + Math.floor(Math.random() * 500);
		const serve = await serveProjectOnIsolatedWasm({
			projectDir: helloBindleDir,
			hoboHome,
			port,
		});
		cleanups.push(() => serve.close());

		expect(serve.componentHost).toBe("wasm");
		expect(serve.isolation.isolateBoundary).toBe("wasmtime_process");
		expect(serve.isolation.privateSandboxes).toBe(1);
		expect(serve.isolation.wasmtimeVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(serve.isolation.wasmPaths?.length).toBe(1);
		expect(
			existsSync(
				first(
					must(serve.isolation.wasmPaths, "serve.isolation.wasmPaths"),
					"serve.isolation.wasmPaths",
				),
			),
		).toBe(true);
		expect(serve.exposedEndpoints).toHaveLength(1);
		// Camp injects bindle env onto mesh hops into the wasm sandbox.
		expect(serve.bindleEnv).toEqual({
			GREETING_PREFIX: "howdy",
			APP_TITLE: "howdy",
		});
		expect(HOBO_ENV_HEADER_PREFIX).toBe("x-hobo-env-");

		const html = await (await fetch(`${serve.primaryUrl}/?name=Iso`)).text();
		expect(html).toContain("howdy, Iso");
	}, 180_000);

	it("legacy host aliases normalize to local component host", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-legacy-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		const port = 25000 + Math.floor(Math.random() * 500);
		const serve = await serveProjectOnLocalYard({
			projectDir: helloBindleDir,
			hoboHome,
			port,
			componentHost: "runtime-local",
		});
		cleanups.push(() => serve.close());
		expect(serve.componentHost).toBe("local");
	});

	it("pins wasmtime floor for sandboxes", () => {
		expect(PINNED_WASMTIME_VERSION).toBe("46.0.1");
	});

	it("resolves private wasm from src/<resourceName>.ts by resource name", () => {
		// hello-bindle's private resource is named "api" → src/api.ts (generic rule).
		const resolved = resolvePrivateWasmGuest({
			projectDir: helloBindleDir,
			resourceName: "api",
		});
		expect(resolved.appModulePath).toMatch(/src[/\\]api\.ts$/);
		expect(resolved.guestSourcePath).toBeNull();
		expect(resolved.wasmPath).toBeNull();
	});
});
