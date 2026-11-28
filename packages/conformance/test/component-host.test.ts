import { describe, expect, it } from "vitest";

import {
	ComponentHostPlanningError,
	createReferenceComponentHostManifest,
	createReferenceInContainerHost,
	createReferenceRuntimeLocalHost,
	planComponentHost,
	runComponentHostConformance,
} from "../src/suites/component-host/index.js";

describe("component-host portability suite", () => {
	it("runtime-local and wasm-in-container hosts pass the component-host conformance boundary", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceInContainerHost(),
			],
		});

		expect(report.schema).toBe("@hobo/conformance/component-host/v1");
		expect(report.status).toBe("pass");
		expect(
			report.hosts.map((host) => [host.kind, host.version, host.status]),
		).toEqual([
			["runtime-local", "wasmtime/46.0.1", "pass"],
			["wasm-in-container", "wasmtime-container/46.0.1", "pass"],
		]);
		expect(report.crossHostAssertions).toEqual({
			manifestHostCoverage: "pass",
			deterministicClockReplay: "pass",
			wasiRoundTrip: "pass",
			linkLateBinding: "pass",
			capabilityHandleIsolation: "pass",
			fpNanCanonicalization: "pass",
			fuelEpochScheduling: "pass",
			resourceLimitSemantics: "pass",
		});
		expect(report.nonCoveredDivergences).toEqual([
			"wall-clock scheduling jitter",
			"host-specific partial-failure timing",
		]);
	});

	it("all manifest-certified host kind/version pairs must be exercised", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceRuntimeLocalHost(),
			],
		});

		expect(report.status).toBe("fail");
		expect(report.crossHostAssertions.manifestHostCoverage).toBe("fail");
		expect(
			report.failures.find(
				(failure) => failure.checkId === "manifest-host-coverage",
			)?.missingHosts,
		).toEqual([
			{ kind: "wasm-in-container", version: "wasmtime-container/46.0.1" },
		]);
	});

	it("manifest IR pins host kind and version before a component-host may plan", () => {
		const manifest = createReferenceComponentHostManifest();
		const staleWasmtime = createReferenceRuntimeLocalHost({
			version: "wasmtime/45.0.0",
		});

		expect(() => planComponentHost(manifest, staleWasmtime)).toThrow(
			ComponentHostPlanningError,
		);
		try {
			planComponentHost(manifest, staleWasmtime);
		} catch (error) {
			expect(error).toMatchObject({
				code: "component_host.host-version-incompatible",
				hostKind: "runtime-local",
				hostVersion: "wasmtime/45.0.0",
			});
			// SAFETY: assertion to `error as ComponentHostPlanningError` is required at this boundary.
			expect((error as ComponentHostPlanningError).expectedVersions).toContain(
				"wasmtime/46.0.1",
			);
		}
	});

	it("identical but wrong WASI round-trip behavior fails wasi-round-trip", async () => {
		const runtimeLocal = createReferenceRuntimeLocalHost();
		const inContainer = createReferenceInContainerHost();
		const wrongRoundTrip = () => ({
			interface: "wasi:keyvalue/store",
			version: "0.2.0",
			request: {},
			response: { ok: true, value: "wasi:wrong-key" },
		});
		runtimeLocal.roundTripWasiInterface =
			// SAFETY: assertion to `wrongRoundTrip as typeof runtimeLocal.roundTripWasiInterface` is required at this boundary.
			wrongRoundTrip as typeof runtimeLocal.roundTripWasiInterface;
		inContainer.roundTripWasiInterface =
			// SAFETY: assertion to `wrongRoundTrip as typeof inContainer.roundTripWasiInterface` is required at this boundary.
			wrongRoundTrip as typeof inContainer.roundTripWasiInterface;

		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [runtimeLocal, inContainer],
		});

		expect(report.status).toBe("fail");
		expect(report.crossHostAssertions.wasiRoundTrip).toBe("fail");
		expect(
			report.failures.find((failure) => failure.checkId === "wasi-round-trip")
				?.message,
		).toBe("wasi-round-trip did not match expected reference semantics");
	});

	it("deterministic-clock replay drift fails deterministic-clock-replay", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceInContainerHost({ deterministicClockOffsetMs: 1 }),
			],
		});

		expect(report.status).toBe("fail");
		expect(report.crossHostAssertions.deterministicClockReplay).toBe("fail");
		expect(report.failures[0]?.checkId).toBe("deterministic-clock-replay");
	});

	it("NaN bit drift fails fp-nan-canonicalization", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceInContainerHost({ nanBits: "0x7ff0000000000001" }),
			],
		});

		expect(report.status).toBe("fail");
		expect(report.crossHostAssertions.fpNanCanonicalization).toBe("fail");
		expect(report.failures[0]?.checkId).toBe("fp-nan-canonicalization");
	});

	it("fuel/epoch scheduling drift fails fuel-epoch-scheduling", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceInContainerHost({
					fuelSchedule: [
						{ epoch: 0, fuelRemaining: 8, step: "load" },
						{ epoch: 1, fuelRemaining: 0, step: "yield" },
					],
				}),
			],
		});

		expect(report.status).toBe("fail");
		expect(report.crossHostAssertions.fuelEpochScheduling).toBe("fail");
		expect(report.failures[0]?.checkId).toBe("fuel-epoch-scheduling");
	});

	it("resource-limit drift fails resource-limit-semantics", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceInContainerHost({
					resourceLimit: {
						memoryPages: 17,
						maxMemoryPages: 16,
						status: "continued",
						trap: null,
					},
				}),
			],
		});

		expect(report.status).toBe("fail");
		expect(report.crossHostAssertions.resourceLimitSemantics).toBe("fail");
		expect(report.failures[0]?.checkId).toBe("resource-limit-semantics");
	});

	it("ambient provider reachability fails capability-handle-isolation", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceInContainerHost({ allowAmbientCapability: true }),
			],
		});

		expect(report.status).toBe("fail");
		expect(report.crossHostAssertions.capabilityHandleIsolation).toBe("fail");
		expect(report.failures[0]?.checkId).toBe("capability-handle-isolation");
	});
});
