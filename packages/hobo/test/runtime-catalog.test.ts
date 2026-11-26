/**
 * The installable runtime catalog: `hobo add runtime-*` and what it registers.
 *
 * This module is three lookup tables and a set of catalog-entry factories, and
 * the tables are the interesting part. They translate between three
 * vocabularies that name the same four things — the install id an operator
 * types (`runtime-wasm`), the component-host kind a Yard config stores
 * (`wasm`), and the provider id the broker registry addresses
 * (`@hobo/runtime-wasm`). Every hop between them is a place the four can drift
 * apart, and nothing downstream would report the drift as such: a bad mapping
 * surfaces as a yard that installed one runtime and serves with another.
 *
 * **The install-id/host round trip is the invariant worth having.** It is
 * checked over `RUNTIME_INSTALL_IDS` itself rather than a hand-written list, so
 * adding a fifth runtime without extending both tables fails here rather than
 * at whatever point a Camp tries to serve on it.
 *
 * **`providerIdToHost` is a many-to-one map, deliberately.** Three spellings
 * mean `local` and two mean each of `wasm` and `oci`, because the legacy
 * sandbox/provider ids are still written into existing Yard configs and
 * broker state. Dropping one would make an installed runtime invisible on a
 * yard that had been working.
 *
 * **The factory's fallback is total, and that is a hazard.** Anything it does
 * not recognise becomes cloud-native rather than an error, so the tests state
 * that plainly rather than leaving it to be discovered.
 */
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

/** The ports a catalog entry advertises, in declaration order. */
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
		// A real answer, not a failure: the caller is parsing what an operator
		// typed, and needs to tell "not a runtime" from "a runtime I mishandled".
		expect(runtimeInstallIdToHost("runtime-nonesuch")).toBeUndefined();
		expect(runtimeInstallIdToHost("local")).toBeUndefined();
		expect(runtimeInstallIdToHost("")).toBeUndefined();
	});

	it("round-trips every published install id through its host", () => {
		// Driven off RUNTIME_INSTALL_IDS rather than a hand-written list, so a
		// fifth runtime added without extending both tables fails here instead of
		// wherever a Camp first tries to serve on it.
		for (const id of RUNTIME_INSTALL_IDS) {
			const host = runtimeInstallIdToHost(id);
			if (host === undefined) throw new Error(`${id} names no host`);
			expect(hostToRuntimeInstallId(host)).toBe(id);
		}
	});

	it("publishes an install id for every host it can name", () => {
		// The other direction of the same invariant.
		for (const host of ["local", "wasm", "oci", "cloud-native"] as const) {
			expect(RUNTIME_INSTALL_IDS).toContain(hostToRuntimeInstallId(host));
		}
	});

	it("falls through to cloud-native for an unrecognised host", () => {
		// Stated rather than left to be discovered: the last arm is a bare
		// return, not a fourth comparison, so any host beyond the three named
		// ones is reported as cloud-native.
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
		// Still written into existing Yard configs and broker state. Dropping
		// them would make an installed runtime invisible on a yard that had been
		// working, which reads as the runtime having vanished.
		expect(providerIdToHost(WASM_SANDBOX_PROVIDER_ID)).toBe("wasm");
		expect(providerIdToHost(OCI_PROVIDER_ID)).toBe("oci");
	});

	it("accepts the bare and legacy spellings of local", () => {
		expect(providerIdToHost("local")).toBe("local");
		expect(providerIdToHost("@hobo/provider-local-host")).toBe("local");
	});

	it("answers undefined for a provider that is not a runtime host", () => {
		// Cloud providers register in the same catalog, so this is asked of ids
		// that legitimately have no component host.
		expect(providerIdToHost("@hobo/provider-aws")).toBeUndefined();
		expect(providerIdToHost("wasm")).toBeUndefined();
		expect(providerIdToHost("")).toBeUndefined();
	});
});

describe("the catalog entries themselves", () => {
	it("registers each runtime under its published provider id", () => {
		// The id is how the broker registry addresses the entry; an entry whose
		// id disagreed with RUNTIME_PROVIDER_IDS would install and then never be
		// found.
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
		// Ties the two halves of this module together: an entry the catalog can
		// produce must be one providerIdToHost can place.
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
		// The distinction that matters here. wasm and oci advertise "*", so they
		// satisfy any port a planner asks for; local advertises four named ports
		// and nothing else. A local entry carrying "*" would let the planner
		// place work on it that it cannot actually host.
		expect(portsOf(createLocalRuntimeCatalogEntry())).not.toContain("*");
		expect(portsOf(createWasmRuntimeCatalogEntry())).toContain("*");
		expect(portsOf(createOciRuntimeCatalogEntry())).toContain("*");
	});

	it("advertises the runtime-host port on every entry", () => {
		// It is what marks the entry as a component host at all.
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
		// It stands for whatever the cloud provider hosts, which is not
		// enumerable here.
		expect(portsOf(createCloudNativeRuntimeCatalogEntry())).toEqual([
			"hobo:runtime-host",
			"*",
		]);
	});

	it("gives the sandbox alias the same ports as the wasm runtime", () => {
		// They are the same host under two names; differing ports would make the
		// placement depend on which name a yard happened to record.
		expect(portsOf(createWasmSandboxCatalogEntry())).toEqual(
			portsOf(createWasmRuntimeCatalogEntry()),
		);
	});

	it("builds a fresh entry each call", () => {
		// Callers register these into a mutable catalog; a shared instance would
		// let one registration's mutations follow into the next.
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
		// The fallback is total -- a bare return rather than a fourth comparison
		// -- so an unknown id does not fail here, it installs the cloud-native
		// runtime. Recorded rather than changed: the parameter is typed
		// RuntimeInstallId, so reaching this arm means a caller already bypassed
		// the type, and the callers that parse operator input use
		// runtimeInstallIdToHost, which does refuse.
		// SAFETY: deliberately outside RuntimeInstallId, for the reason above.
		expect(
			createRuntimeInstallableFactory("runtime-nonesuch" as never)().id,
		).toBe(RUNTIME_PROVIDER_IDS["cloud-native"]);
	});
});
