import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindle, collectRequiredRuntimes } from "@hobo/bindles";
import type { HoboRuntimeHost } from "@hobo/core";
import fc from "fast-check";
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
		// Past the runtime check, whatever placement then decides. Today a fresh
		// HOBO_HOME seeds only a local-provider yard, so an oci bindle (which asks
		// for @hobo/provider-oci) is refused for the yard inventory; that is
		// placement's to change, and this case does not pin it.
		expect(placement.message).not.toMatch(/not installed/i);
		expect(placement.requiredRuntimes).toEqual(["oci"]);
		// First placement equips the isolated wasm toolchain into the throwaway
		// HOBO_HOME, beyond the 10s default when it has to download.
	}, 300_000);

	it("refuses OCI execution authorized only as local-process hosting", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-provider-binding-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		installRuntime("runtime-oci", hoboHome);
		const original = bindle("needs-oci", (b) => {
			const redis = b.container({ image: "redis:7" });
			const api = b.api().withReference(redis);
			return { redis, api };
		});
		const definition = {
			...original,
			requirements: { ...original.requirements, runtimes: [] },
		};
		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId: "@hobo/provider-local-host",
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
		expect(placement.outcome).toBe("rejected");
	}, 300_000);

	it("only approves generated local-process workloads under the local service-fee policy", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-local-property-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		installRuntime("runtime-oci", hoboHome);
		const check = async (needsOci: boolean) => {
			const definition = needsOci
				? bindle("needs-oci", (b) => {
						const redis = b.container({ image: "redis:7" });
						return { redis, api: b.api().withReference(redis) };
					})
				: bindle("local-only", (b) => ({ api: b.api() }));
			const placement = await resolveBindlePlacement({
				definition,
				hoboHome,
				providerId: "@hobo/provider-local-host",
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
			expect(placement.outcome).toBe(needsOci ? "rejected" : "resolved");
			if (!needsOci) {
				expect(placement.componentHost).toBe("local");
				expect(
					placement.yardPlacement?.localHostingProof?.liabilityBoundMicros,
				).toBe(0);
			}
		};
		await check(false);
		await check(true);
		await fc.assert(fc.asyncProperty(fc.boolean(), check), {
			seed: 614529,
			numRuns: 20,
		});
	}, 300_000);

	it("refuses requirements changed while runtime readiness is awaited", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-changing-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		installRuntime("runtime-oci", hoboHome);
		const original = bindle("changing", (b) => ({ api: b.api() }));
		const definition = {
			...original,
			resources: { ...original.resources, api: { ...original.resources.api } },
		};
		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId: "@hobo/provider-local-host",
			runtimeHost: (kind): HoboRuntimeHost => {
				if (kind !== "oci") throw new Error(`unexpected ${kind} host`);
				return {
					kind: "oci",
					ensure: async () => {
						Object.assign(definition.resources.api, { kind: "container" });
						return { kind: "oci", ready: true, notes: [] };
					},
					servePrivate: async () => {
						throw new Error("placement does not serve");
					},
				};
			},
		});
		expect(placement.outcome).toBe("rejected");
	}, 300_000);

	it("refuses requirements changed during the local authorization handoff", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-handoff-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		const original = bindle("changing", (b) => ({ api: b.api() }));
		const definition = {
			...original,
			resources: { ...original.resources, api: { ...original.resources.api } },
		};
		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId: "@hobo/provider-local-host",
			emitProgress(message) {
				if (message.includes("yard-first placement"))
					queueMicrotask(() =>
						Object.assign(definition.resources.api, { kind: "container" }),
					);
			},
		});
		expect(placement.outcome).toBe("rejected");
		expect(placement.resolution.rejection?.reasons[0]?.code).toBe(
			"runtime-requirements-changed",
		);
	}, 300_000);

	it("refuses requirements changed temporarily during local authorization", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-rt-transient-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "local" });
		installRuntime("runtime-oci", hoboHome);
		const original = bindle("changing", (b) => ({ api: b.api() }));
		const definition = {
			...original,
			resources: { ...original.resources, api: { ...original.resources.api } },
		};
		const placement = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId: "@hobo/provider-local-host",
			runtimeHost: (kind): HoboRuntimeHost => {
				if (kind !== "oci") throw new Error(`unexpected ${kind} host`);
				return {
					kind: "oci",
					ensure: async () => {
						Object.assign(definition.resources.api, { kind: "container" });
						return { kind: "oci", ready: true, notes: [] };
					},
					servePrivate: async () => {
						throw new Error("placement does not serve");
					},
				};
			},
			emitProgress(message) {
				if (message.includes("yard-first placement"))
					queueMicrotask(() =>
						Object.assign(definition.resources.api, { kind: "api" }),
					);
			},
		});
		expect(definition.resources.api.kind).toBe("api");
		expect(placement.outcome).toBe("rejected");
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
