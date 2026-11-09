import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindle, collectRequiredRuntimes } from "@hobo/bindles";
import type { HoboRuntimeHost } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";

import { initBareMetalYard, resolveBindlePlacement } from "../src/index.js";
import { installRuntime } from "../src/installed-runtimes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("required runtimes + broker hard-fail", () => {
	it("collectRequiredRuntimes from container + wasm deps", () => {
		const definition = bindle("needs-both", (b) => {
			const redis = b.container({ image: "redis:7" });
			const plugin = b.wasmComponent({ source: "./p.wasm" });
			const api = b.api().withReference(redis, plugin);
			return { redis, plugin, api };
		});
		expect(collectRequiredRuntimes(definition)).toEqual(["oci", "wasm"]);
	});

	it("hard-fails placement when oci runtime is not installed", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-reject-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		// Bootstrap installs only runtime-local.
		initBareMetalYard({ hoboHome, componentHost: "local" });

		const definition = bindle("needs-oci", (b) => {
			const redis = b.container({ image: "redis:7" });
			const api = b.api().withReference(redis);
			return { redis, api };
		});

		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
		});
		expect(placement.outcome).toBe("rejected");
		expect(placement.message).toMatch(/runtime\(s\).*oci/i);
		expect(placement.remediation?.some((r) => r.includes("runtime-oci"))).toBe(
			true,
		);
	});

	it("passes the runtime check once hobo add runtime-oci is recorded", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-accept-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		installRuntime("runtime-oci", hoboHome);

		const definition = bindle("needs-oci", (b) => {
			const redis = b.container({ image: "redis:7" });
			const api = b.api().withReference(redis);
			return { redis, api };
		});
		// A ready oci host, so its readiness (a kubectl client equipped under
		// HOBO_HOME) is neither the machine's nor the reason for the outcome.
		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
			runtimeHost: (kind): HoboRuntimeHost => {
				if (kind !== "oci") throw new Error(`unexpected ${kind} host`);
				return {
					kind: "oci",
					ensure: async () => ({ kind: "oci", ready: true, notes: [] }),
					servePrivate: async () => {
						throw new Error("placement does not serve");
					},
				};
			},
		});
		// Past the runtime check, placement reaches yard-first matching. A fresh
		// HOBO_HOME seeds only a local-provider yard, and an oci bindle asks for
		// @hobo/provider-oci, so the refusal is the yard inventory's.
		expect(placement.outcome).toBe("rejected");
		expect(placement.message).not.toMatch(/not installed/i);
		expect(placement.message).toMatch(/no compatible ready yard/i);
		expect(placement.requiredRuntimes).toEqual(["oci"]);
		// First placement equips the isolated wasm toolchain into the throwaway
		// HOBO_HOME, beyond the 10s default when it has to download.
	}, 300_000);

	it("hard-fails wasm-component when runtime-wasm not installed", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-wasm-reject-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });

		const definition = bindle("needs-wasm", (b) => {
			const plugin = b.wasmComponent({ source: "./plugin.wasm" });
			const api = b.api().withReference(plugin);
			return { plugin, api };
		});

		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
		});
		expect(placement.outcome).toBe("rejected");
		expect(placement.message).toMatch(/wasm/i);
	});
});
