import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createYardBrokerCatalog,
	defaultComponentHostFromBroker,
	defaultEmbeddedPolicySet,
	describeBrokerRuntime,
	EMBEDDED_BROKER_SCHEMA,
	type EmbeddedBrokerState,
	LOCAL_PROCESS_PROVIDER_ID,
	loadEmbeddedBrokerState,
	OCI_PROVIDER_ID,
	saveEmbeddedBrokerState,
	WASM_SANDBOX_PROVIDER_ID,
} from "../src/broker-runtime.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-broker-runtime-"));
	dirs.push(dir);
	return dir;
}

function state(overrides: Partial<EmbeddedBrokerState> = {}) {
	return {
		schemaVersion: EMBEDDED_BROKER_SCHEMA,
		brokerId: "broker:local/test",
		preferredComponentHost: "local",
		catalogHash: "sha256:test",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as EmbeddedBrokerState;
}

function providers(catalog: ReturnType<typeof createYardBrokerCatalog>) {
	return new Set(catalog.definitions().map((d) => d.providerId));
}

describe("createYardBrokerCatalog", () => {
	it("always offers the local process yard for both ports and a wildcard", () => {
		const catalog = createYardBrokerCatalog({ includeWasmSandbox: false });
		const ports = catalog
			.definitions()
			.filter((d) => d.providerId === LOCAL_PROCESS_PROVIDER_ID)
			.map((d) => d.port);
		expect(ports).toEqual(
			expect.arrayContaining(["hobo:http-service", "hobo:web-app", "*"]),
		);
	});

	it("offers no wasm or oci entries when neither is installed", () => {
		const catalog = createYardBrokerCatalog({ includeWasmSandbox: false });
		expect(providers(catalog)).toEqual(new Set([LOCAL_PROCESS_PROVIDER_ID]));
	});

	it("adds the wasm sandbox and its component host when wasm is installed", () => {
		const catalog = createYardBrokerCatalog({ includeWasmSandbox: true });
		expect(providers(catalog).has(WASM_SANDBOX_PROVIDER_ID)).toBe(true);
		const componentHosts = catalog
			.definitions()
			.filter((d) => d.features.includes("component-host"));
		expect(componentHosts.length).toBeGreaterThan(0);
	});

	it("adds the oci entries only when oci is installed", () => {
		expect(
			providers(
				createYardBrokerCatalog({
					includeWasmSandbox: false,
					includeOci: true,
				}),
			).has(OCI_PROVIDER_ID),
		).toBe(true);
		expect(
			providers(
				createYardBrokerCatalog({
					includeWasmSandbox: false,
					includeOci: false,
				}),
			).has(OCI_PROVIDER_ID),
		).toBe(false);
	});

	it("prices wasm below oci below local process", () => {
		const catalog = createYardBrokerCatalog({
			includeWasmSandbox: true,
			includeOci: true,
		});
		const priceOf = (providerId: string) =>
			Number(
				catalog.definitions().find((d) => d.providerId === providerId)?.cost
					.marginalPrice,
			);
		expect(priceOf(WASM_SANDBOX_PROVIDER_ID)).toBeLessThan(
			priceOf(OCI_PROVIDER_ID),
		);
		expect(priceOf(OCI_PROVIDER_ID)).toBeLessThan(
			priceOf(LOCAL_PROCESS_PROVIDER_ID),
		);
	});

	it("matches a definition to its own port and refuses another", () => {
		const definition = createYardBrokerCatalog({ includeWasmSandbox: false })
			.definitions()
			.find((d) => d.port === "hobo:http-service");
		expect(
			definition?.satisfies({ port: "hobo:http-service" } as never),
		).toEqual({ kind: "full" });
		expect(definition?.satisfies({ port: "hobo:web-app" } as never)).toEqual({
			kind: "none",
		});
	});

	it("lets a wildcard definition satisfy any port", () => {
		const wildcard = createYardBrokerCatalog({ includeWasmSandbox: false })
			.definitions()
			.find((d) => d.port === "*");
		expect(wildcard?.satisfies({ port: "anything:at-all" } as never)).toEqual({
			kind: "full",
		});
	});

	it("gives each installed combination a distinct catalog hash", () => {
		const hashes = new Set(
			[
				{ includeWasmSandbox: false },
				{ includeWasmSandbox: true },
				{ includeWasmSandbox: false, includeOci: true },
				{ includeWasmSandbox: true, includeOci: true },
			].map((options) => createYardBrokerCatalog(options).catalogHash),
		);
		expect(hashes.size).toBe(4);
	});

	it("hands out copies so a caller cannot mutate the catalog", () => {
		const catalog = createYardBrokerCatalog({ includeWasmSandbox: true });
		const first = catalog.definitions();
		(first[0] as { providerId: string }).providerId = "tampered";
		expect(catalog.definitions().some((d) => d.providerId === "tampered")).toBe(
			false,
		);
	});
});

describe("defaultEmbeddedPolicySet", () => {
	it("denies the wasm sandbox exactly when it is not preferred", () => {
		expect(
			defaultEmbeddedPolicySet("b", { preferWasmSandbox: false })
				.placementPolicies[0]?.deniedProviders,
		).toEqual([WASM_SANDBOX_PROVIDER_ID]);
		expect(
			defaultEmbeddedPolicySet("b", { preferWasmSandbox: true })
				.placementPolicies[0]?.deniedProviders,
		).toEqual([]);
	});

	it("prefers the wasm sandbox by default", () => {
		expect(
			defaultEmbeddedPolicySet("b").placementPolicies[0]?.deniedProviders,
		).toEqual([]);
	});

	it("leaves the allow-list empty so every catalog provider is eligible", () => {
		const policy = defaultEmbeddedPolicySet("b").placementPolicies[0];
		expect(policy?.allowedProviders).toEqual([]);
		expect(policy?.allowedRegions).toEqual([]);
		expect(policy?.requireExplicitCamps).toBe(false);
	});

	it("carries the broker id it was built for", () => {
		expect(defaultEmbeddedPolicySet("broker:local/host").brokerId).toBe(
			"broker:local/host",
		);
	});

	it("keeps the embedded delivery engine in-process and non-pruning", () => {
		const policies = defaultEmbeddedPolicySet("b");
		expect(policies.delivery.engine).toBe("in-proc");
		expect(policies.delivery.prune).toBe(false);
		expect(policies.requiredConnectorKinds).toEqual([]);
	});

	it("starts billing at zero spend with a non-zero quota", () => {
		const billing = defaultEmbeddedPolicySet("b").billing;
		expect(billing.quotaUsed).toBe(0);
		expect(billing.budgetUsd).toBe(0);
		expect(billing.quotaLimit).toBeGreaterThan(0);
	});
});

describe("persisted broker state", () => {
	it("reports no state when nothing has been written", () => {
		expect(loadEmbeddedBrokerState(home())).toBeNull();
	});

	it("round-trips a saved state and creates the home directory", () => {
		const dir = join(home(), "nested");
		const path = saveEmbeddedBrokerState(state(), dir);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		expect(loadEmbeddedBrokerState(dir)?.brokerId).toBe("broker:local/test");
	});

	it("reports no state for a document from another schema version", () => {
		const dir = home();
		saveEmbeddedBrokerState(
			state({ schemaVersion: "hobo.broker-runtime/v0" as never }),
			dir,
		);
		expect(loadEmbeddedBrokerState(dir)).toBeNull();
	});

	it("reports no state for a truncated file", () => {
		const dir = home();
		const path = saveEmbeddedBrokerState(state(), dir);
		writeFileSync(path, "{ broken", "utf8");
		expect(loadEmbeddedBrokerState(dir)).toBeNull();
	});
});

describe("describeBrokerRuntime", () => {
	it("names both files it looked at, whether or not they exist", () => {
		const described = describeBrokerRuntime(home());
		expect(described.yardConfigPath).toContain("yard");
		expect(described.brokerStatePath).toContain("broker-runtime.json");
		expect(described.yard).toBeNull();
		expect(described.broker).toBeNull();
	});

	it("returns the parsed broker state once one has been written", () => {
		const dir = home();
		saveEmbeddedBrokerState(state({ brokerId: "broker:local/described" }), dir);
		expect(describeBrokerRuntime(dir).broker?.brokerId).toBe(
			"broker:local/described",
		);
	});
});

describe("defaultComponentHostFromBroker", () => {
	it("uses the remembered preference when there is one", () => {
		const dir = home();
		saveEmbeddedBrokerState(state({ preferredComponentHost: "wasm" }), dir);
		expect(defaultComponentHostFromBroker(dir)).toBe("wasm");
	});

	it("normalizes a legacy preference rather than failing on it", () => {
		const dir = home();
		saveEmbeddedBrokerState(
			state({ preferredComponentHost: "isolated-wasm" as never }),
			dir,
		);
		expect(defaultComponentHostFromBroker(dir)).toBe("wasm");
	});

	it("falls back to the default host for an unrecognisable preference", () => {
		const dir = home();
		saveEmbeddedBrokerState(
			state({ preferredComponentHost: "frobnicate" as never }),
			dir,
		);
		expect(["local", "wasm", "oci", "cloud-native"]).toContain(
			defaultComponentHostFromBroker(dir),
		);
	});

	it("falls back to the default host when no state exists at all", () => {
		expect(["local", "wasm", "oci", "cloud-native"]).toContain(
			defaultComponentHostFromBroker(home()),
		);
	});
});
