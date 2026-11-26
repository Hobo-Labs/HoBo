/**
 * Installable Camp component-host runtimes for `hobo add runtime-*`.
 * These are Capability-Manifest-bearing catalog entries so the broker junction
 * and planner can see which hosts are available on this yard.
 */
import type { RegistrableProvider } from "@hobo/cloud";

import type { ComponentHostKind } from "./bare-metal-yard.js";
import { createProviderFromPorts } from "./local-provider.js";

export const RUNTIME_PROVIDER_IDS = {
	local: "@hobo/runtime-local",
	wasm: "@hobo/runtime-wasm",
	oci: "@hobo/runtime-oci",
	"cloud-native": "@hobo/runtime-cloud-native",
} as const;

/** Legacy alias used by embedded broker wasm-sandbox equip. */
export const WASM_SANDBOX_PROVIDER_ID = "@hobo/provider-wasm-sandbox" as const;
export const OCI_PROVIDER_ID = "@hobo/provider-oci" as const;

export const RUNTIME_INSTALL_IDS = [
	"runtime-local",
	"runtime-wasm",
	"runtime-oci",
	"runtime-cloud-native",
] as const;

export type RuntimeInstallId = (typeof RUNTIME_INSTALL_IDS)[number];

export function runtimeInstallIdToHost(
	id: string,
): ComponentHostKind | undefined {
	if (id === "runtime-local") return "local";
	if (id === "runtime-wasm") return "wasm";
	if (id === "runtime-oci") return "oci";
	if (id === "runtime-cloud-native") return "cloud-native";
	return undefined;
}

export function hostToRuntimeInstallId(
	host: ComponentHostKind,
): RuntimeInstallId {
	if (host === "local") return "runtime-local";
	if (host === "wasm") return "runtime-wasm";
	if (host === "oci") return "runtime-oci";
	return "runtime-cloud-native";
}

const RUNTIME_PORTS = [
	"hobo:runtime-host",
	"hobo:http-service",
	"hobo:web-app",
	"wasi:http",
	"*",
] as const;

export function createLocalRuntimeCatalogEntry(): RegistrableProvider {
	return createProviderFromPorts(RUNTIME_PROVIDER_IDS.local, [
		"hobo:runtime-host",
		"hobo:http-service",
		"hobo:web-app",
		"wasi:http",
	]);
}

export function createWasmRuntimeCatalogEntry(): RegistrableProvider {
	return createProviderFromPorts(RUNTIME_PROVIDER_IDS.wasm, [...RUNTIME_PORTS]);
}

export function createWasmSandboxCatalogEntry(): RegistrableProvider {
	return createProviderFromPorts(WASM_SANDBOX_PROVIDER_ID, [...RUNTIME_PORTS]);
}

export function createOciRuntimeCatalogEntry(): RegistrableProvider {
	return createProviderFromPorts(RUNTIME_PROVIDER_IDS.oci, [...RUNTIME_PORTS]);
}

export function createOciProviderCatalogEntry(): RegistrableProvider {
	return createProviderFromPorts(OCI_PROVIDER_ID, [...RUNTIME_PORTS]);
}

export function createCloudNativeRuntimeCatalogEntry(): RegistrableProvider {
	return createProviderFromPorts(RUNTIME_PROVIDER_IDS["cloud-native"], [
		"hobo:runtime-host",
		"*",
	]);
}

export function createRuntimeInstallableFactory(
	id: RuntimeInstallId,
): () => RegistrableProvider {
	if (id === "runtime-local") return createLocalRuntimeCatalogEntry;
	if (id === "runtime-wasm") return createWasmRuntimeCatalogEntry;
	if (id === "runtime-oci") return createOciRuntimeCatalogEntry;
	return createCloudNativeRuntimeCatalogEntry;
}

/** Map provider catalog ids → component host kind. */
export function providerIdToHost(
	providerId: string,
): ComponentHostKind | undefined {
	if (
		providerId === RUNTIME_PROVIDER_IDS.local ||
		providerId === "local" ||
		providerId === "@hobo/provider-local-host"
	) {
		return "local";
	}
	if (
		providerId === RUNTIME_PROVIDER_IDS.wasm ||
		providerId === WASM_SANDBOX_PROVIDER_ID
	) {
		return "wasm";
	}
	if (
		providerId === RUNTIME_PROVIDER_IDS.oci ||
		providerId === OCI_PROVIDER_ID
	) {
		return "oci";
	}
	if (providerId === RUNTIME_PROVIDER_IDS["cloud-native"]) {
		return "cloud-native";
	}
	return undefined;
}
