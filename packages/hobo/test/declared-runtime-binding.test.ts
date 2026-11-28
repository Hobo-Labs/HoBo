import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BindleBuilder, type BindleResource, bindle } from "@hobo/bindles";
import type { HoboRuntimeHost } from "@hobo/core";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { initBareMetalYard, resolveBindlePlacement } from "../src/index.js";
import { installRuntime } from "../src/installed-runtimes.js";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(
		homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
	);
});
async function homeWithHosts() {
	const home = await mkdtemp(join(tmpdir(), "hobo-declared-runtime-"));
	homes.push(home);
	initBareMetalYard({ hoboHome: home, componentHost: "local" });
	installRuntime("runtime-oci", home);
	installRuntime("runtime-wasm", home);
	return home;
}
function ready(kind: HoboRuntimeHost["kind"]): HoboRuntimeHost {
	return {
		kind,
		ensure: async () => ({ kind, ready: true, notes: [] }),
		servePrivate: async () => {
			throw new Error("placement does not serve");
		},
	};
}
const providerId = "@hobo/provider-local-host";

describe("declared runtime requirements", () => {
	it("infers actual resource runtimes without inventing a host for handlers", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(http, container, wasm, explicitLocal) => {
					const build = (b: BindleBuilder) => {
						const resources: Record<string, BindleResource> = {};
						if (http) resources.api = b.api();
						if (container) resources.db = b.container({ image: "redis:7" });
						if (wasm)
							resources.plugin = b.wasmComponent({ source: "./plugin.wasm" });
						return resources;
					};
					const definition = explicitLocal
						? bindle("inference-property", { runtimes: ["local"] }, build)
						: bindle("inference-property", build);
					const expected = [
						...(explicitLocal ? ["local"] : []),
						...(container ? ["oci"] : []),
						...(wasm ? ["wasm"] : []),
					].sort();
					expect(definition.requirements.runtimes).toEqual(expected);
				},
			),
			{ seed: 614531, numRuns: 100 },
		);
	});
	it("checks installation of a declared OCI runtime before readiness", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-declared-missing-"));
		homes.push(hoboHome);
		initBareMetalYard({ hoboHome, componentHost: "local" });
		const definition = bindle("declared", { runtimes: ["oci"] }, (b) => ({
			api: b.api(),
		}));
		const result = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId,
			runtimeHost: () => {
				throw new Error("readiness must not run");
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(result.resolution.rejection?.reasons[0]?.code).toBe(
			"required-runtime-unavailable",
		);
	});
	it.each([
		"oci",
		"wasm",
	])("refuses declared %s under the local-process policy", async (runtime) => {
		const hoboHome = await homeWithHosts();
		const definition = bindle("declared", { runtimes: [runtime] }, (b) => ({
			api: b.api(),
		}));
		const result = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId,
			runtimeHost: ready,
		});
		expect(result.outcome).toBe("rejected");
		expect(result.requiredRuntimes).toContain(runtime);
	}, 300_000);
	it("allows only locally satisfiable declared runtimes in generated inputs", async () => {
		const hoboHome = await homeWithHosts();
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom("local", "oci", "wasm", "unknown"), {
					maxLength: 3,
				}),
				async (runtimes) => {
					const original = bindle("declared-property", (b) => ({
						api: b.api(),
					}));
					const definition = {
						...original,
						requirements: { ...original.requirements, runtimes },
					};
					const result = await resolveBindlePlacement({
						definition,
						hoboHome,
						providerId,
						runtimeHost: ready,
					});
					expect(result.outcome).toBe(
						runtimes.every((runtime) => runtime === "local")
							? "resolved"
							: "rejected",
					);
				},
			),
			{ seed: 614530, numRuns: 24 },
		);
	}, 300_000);
	it("refuses declared requirements changed temporarily during authorization", async () => {
		const hoboHome = await homeWithHosts();
		const original = bindle("changing-declared", (b) => ({ api: b.api() }));
		const runtimes: string[] = [];
		const definition = {
			...original,
			requirements: { ...original.requirements, runtimes },
		};
		const result = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId,
			runtimeHost: (kind) => ({
				...ready(kind),
				ensure: async () => {
					if (kind === "oci") runtimes.push("local");
					return { kind, ready: true, notes: [] };
				},
			}),
			emitProgress: (message) => {
				if (message.includes("yard-first placement"))
					queueMicrotask(() => {
						runtimes.length = 0;
					});
			},
		});
		expect(runtimes).toEqual([]);
		expect(result.outcome).toBe("rejected");
	}, 300_000);
	it("refuses declared requirements changed during the handoff", async () => {
		const hoboHome = await homeWithHosts();
		const original = bindle("changing-declared", (b) => ({ api: b.api() }));
		const runtimes: string[] = [];
		const definition = {
			...original,
			requirements: { ...original.requirements, runtimes },
		};
		const result = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId,
			runtimeHost: ready,
			emitProgress: (message) => {
				if (message.includes("yard-first placement"))
					queueMicrotask(() => runtimes.push("cloud-native"));
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(result.resolution.rejection?.reasons[0]?.code).toBe(
			"runtime-requirements-changed",
		);
	}, 300_000);
});
