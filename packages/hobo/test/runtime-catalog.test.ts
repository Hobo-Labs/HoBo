import { describe, expect, it } from "vitest";

import {
	createCloudNativeRuntimeCatalogEntry,
	createLocalRuntimeCatalogEntry,
	createOciProviderCatalogEntry,
	createOciRuntimeCatalogEntry,
	createRuntimeInstallableFactory,
	createWasmRuntimeCatalogEntry,
	createWasmSandboxCatalogEntry,
	hostToRuntimeInstallId,
	OCI_PROVIDER_ID,
	providerIdToHost,
	RUNTIME_INSTALL_IDS,
	RUNTIME_PROVIDER_IDS,
	runtimeInstallIdToHost,
	WASM_SANDBOX_PROVIDER_ID,
} from "../src/runtime-catalog.js";

const portsOf = (entry: { capabilities: readonly { port: string }[] }) =>
	entry.capabilities.map((capability) => capability.port);

describe("install ids and component hosts", () => {
	it("maps every install id to a host", () => {
		expect(runtimeInstallIdToHost("runtime-local")).toBe("local");
		expect(runtimeInstallIdToHost("runtime-wasm")).toBe("wasm");
		expect(runtimeInstallIdToHost("runtime-oci")).toBe("oci");
		expect(runtimeInstallIdToHost("runtime-cloud-native")).toBe("cloud-native");
	});

	it("answers undefined for anything it does not know", () => {
		expect(runtimeInstallIdToHost("runtime-nonesuch")).toBeUndefined();
		expect(runtimeInstallIdToHost("local")).toBeUndefined();
		expect(runtimeInstallIdToHost("")).toBeUndefined();
	});

	it("round-trips every published install id through its host", () => {
		for (const id of RUNTIME_INSTALL_IDS) {
			const host = runtimeInstallIdToHost(id);
			if (host === undefined) throw new Error(`${id} names no host`);
			expect(hostToRuntimeInstallId(host)).toBe(id);
		}
	});

	it("publishes an install id for every host it can name", () => {
		for (const host of ["local", "wasm", "oci", "cloud-native"] as const) {
			expect(RUNTIME_INSTALL_IDS).toContain(hostToRuntimeInstallId(host));
		}
	});

	it("falls through to cloud-native for an unrecognised host", () => {
		// SAFETY: deliberately outside ComponentHostKind; only a value that
		// bypassed the type reaches the last arm, and this pins what it does.
		expect(hostToRuntimeInstallId("something-else" as never)).toBe(
			"runtime-cloud-native",
		);
	});
});

describe("provider ids and component hosts", () => {
	it("maps each runtime provider id to its host", () => {
		expect(providerIdToHost(RUNTIME_PROVIDER_IDS.local)).toBe("local");
		expect(providerIdToHost(RUNTIME_PROVIDER_IDS.wasm)).toBe("wasm");
		expect(providerIdToHost(RUNTIME_PROVIDER_IDS.oci)).toBe("oci");
		expect(providerIdToHost(RUNTIME_PROVIDER_IDS["cloud-native"])).toBe(
			"cloud-native",
		);
	});

	it("accepts the legacy wasm sandbox and oci provider ids", () => {
		expect(providerIdToHost(WASM_SANDBOX_PROVIDER_ID)).toBe("wasm");
		expect(providerIdToHost(OCI_PROVIDER_ID)).toBe("oci");
	});

	it("accepts the bare and legacy spellings of local", () => {
		expect(providerIdToHost("local")).toBe("local");
		expect(providerIdToHost("@hobo/provider-local-host")).toBe("local");
	});

	it("answers undefined for a provider that is not a runtime host", () => {
		expect(providerIdToHost("@hobo/provider-aws")).toBeUndefined();
		expect(providerIdToHost("wasm")).toBeUndefined();
		expect(providerIdToHost("")).toBeUndefined();
	});
});

describe("the catalog entries themselves", () => {
	it("registers each runtime under its published provider id", () => {
		expect(createLocalRuntimeCatalogEntry().id).toBe(
			RUNTIME_PROVIDER_IDS.local,
		);
		expect(createWasmRuntimeCatalogEntry().id).toBe(RUNTIME_PROVIDER_IDS.wasm);
		expect(createOciRuntimeCatalogEntry().id).toBe(RUNTIME_PROVIDER_IDS.oci);
		expect(createCloudNativeRuntimeCatalogEntry().id).toBe(
			RUNTIME_PROVIDER_IDS["cloud-native"],
		);
	});

	it("registers the legacy aliases under their own ids", () => {
		expect(createWasmSandboxCatalogEntry().id).toBe(WASM_SANDBOX_PROVIDER_ID);
		expect(createOciProviderCatalogEntry().id).toBe(OCI_PROVIDER_ID);
	});

	it("round-trips every entry id back to a host", () => {
		for (const entry of [
			createLocalRuntimeCatalogEntry(),
			createWasmRuntimeCatalogEntry(),
			createWasmSandboxCatalogEntry(),
			createOciRuntimeCatalogEntry(),
			createOciProviderCatalogEntry(),
			createCloudNativeRuntimeCatalogEntry(),
		]) {
			expect(providerIdToHost(entry.id)).toBeDefined();
		}
	});

	it("does not let the local runtime claim the wildcard port", () => {
		expect(portsOf(createLocalRuntimeCatalogEntry())).not.toContain("*");
		expect(portsOf(createWasmRuntimeCatalogEntry())).toContain("*");
		expect(portsOf(createOciRuntimeCatalogEntry())).toContain("*");
	});

	it("advertises the runtime-host port on every entry", () => {
		for (const entry of [
			createLocalRuntimeCatalogEntry(),
			createWasmRuntimeCatalogEntry(),
			createOciRuntimeCatalogEntry(),
			createCloudNativeRuntimeCatalogEntry(),
		]) {
			expect(portsOf(entry)).toContain("hobo:runtime-host");
		}
	});

	it("gives the cloud-native entry the wildcard rather than named ports", () => {
		expect(portsOf(createCloudNativeRuntimeCatalogEntry())).toEqual([
			"hobo:runtime-host",
			"*",
		]);
	});

	it("gives the sandbox alias the same ports as the wasm runtime", () => {
		expect(portsOf(createWasmSandboxCatalogEntry())).toEqual(
			portsOf(createWasmRuntimeCatalogEntry()),
		);
	});

	it("builds a fresh entry each call", () => {
		expect(createWasmRuntimeCatalogEntry()).not.toBe(
			createWasmRuntimeCatalogEntry(),
		);
	});
});

describe("selecting a factory by install id", () => {
	it("returns the matching factory for each known id", () => {
		expect(createRuntimeInstallableFactory("runtime-local")().id).toBe(
			RUNTIME_PROVIDER_IDS.local,
		);
		expect(createRuntimeInstallableFactory("runtime-wasm")().id).toBe(
			RUNTIME_PROVIDER_IDS.wasm,
		);
		expect(createRuntimeInstallableFactory("runtime-oci")().id).toBe(
			RUNTIME_PROVIDER_IDS.oci,
		);
		expect(createRuntimeInstallableFactory("runtime-cloud-native")().id).toBe(
			RUNTIME_PROVIDER_IDS["cloud-native"],
		);
	});

	it("returns a factory for every published install id", () => {
		for (const id of RUNTIME_INSTALL_IDS) {
			expect(createRuntimeInstallableFactory(id)).toBeTypeOf("function");
		}
	});

	it("silently yields cloud-native for an id it does not recognise", () => {
		// SAFETY: deliberately outside RuntimeInstallId, for the reason above.
		expect(
			createRuntimeInstallableFactory("runtime-nonesuch" as never)().id,
		).toBe(RUNTIME_PROVIDER_IDS["cloud-native"]);
	});
});
