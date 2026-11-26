/**
 * The embedded broker's catalog, policy set, and persisted state.
 *
 * The embedded broker is what makes `hobo up` work with no account and no
 * network: it offers the host runtimes this machine actually has, prices them
 * so the cheapest capable one wins, and remembers the choice in
 * `broker-runtime.json` so later commands agree with the deploy that just ran.
 *
 * **The catalog reflects what is installed, not what is possible.** A wasm or
 * oci entry offered on a machine without the toolchain would win on price and
 * then fail at serve time, after the user was told placement succeeded. That
 * is why `includeWasmSandbox` and `includeOci` are inputs rather than probes
 * made here.
 *
 * **Pricing is the placement policy.** `min-cost` picks among whatever the
 * catalog offers, so the prices *are* the preference order: wasm free, oci a
 * cent, local process two. A pricing change is a placement change.
 *
 * **Persisted state that cannot be trusted reads as absent.** A
 * `broker-runtime.json` from an older schema, or a truncated one, must not be
 * partially believed — the next `ensureEmbeddedBroker` rebuilds it, and that
 * is strictly better than placing against a half-understood document.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	collectExplicitProviderPins,
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

/** Provider ids present in the catalog, deduplicated. */
function providers(catalog: ReturnType<typeof createYardBrokerCatalog>) {
	return new Set(catalog.definitions().map((d) => d.providerId));
}

describe("createYardBrokerCatalog", () => {
	it("always offers the local process yard for both ports and a wildcard", () => {
		// Local process is the one host that needs no toolchain. Without a
		// wildcard entry a Bindle declaring any other port would find no
		// candidate at all and fail placement on a machine that can serve it.
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
		// An entry for an absent toolchain would win on price and fail at serve
		// time — after the user was told placement succeeded.
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
		// `min-cost` is the placement objective, so these numbers *are* the
		// preference order. A change here silently changes where deployments land.
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
		// `satisfies` is what the broker asks. A definition that answered "full"
		// for every request would place a web app on an http-only yard.
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
		// The hash is how a later command notices the machine's capabilities
		// changed. Colliding hashes would let a stale placement preference
		// survive installing a toolchain.
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
		// The definitions are read by the broker on every placement. A caller
		// that edited one in place would change where every later deploy lands.
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
		// The catalog may still carry wasm entries from a legacy install. The
		// deny list is the second gate that keeps a deploy off a host the
		// operator has turned away from.
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
		// The zero-argument form is what the embedded path uses on a fresh
		// machine, and the sandboxed host is the safer default to land on.
		expect(
			defaultEmbeddedPolicySet("b").placementPolicies[0]?.deniedProviders,
		).toEqual([]);
	});

	it("leaves the allow-list empty so every catalog provider is eligible", () => {
		// An allow-list here would have to be kept in step with the catalog by
		// hand, and drift would silently make an installed host unreachable.
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
		// The embedded lane has no queue to drain and no remote to prune
		// against. Either setting flipped would make a local deploy wait on
		// machinery that is not running.
		const policies = defaultEmbeddedPolicySet("b");
		expect(policies.delivery.engine).toBe("in-proc");
		expect(policies.delivery.prune).toBe(false);
		expect(policies.requiredConnectorKinds).toEqual([]);
	});

	it("starts billing at zero spend with a non-zero quota", () => {
		// The local broker bills nothing, but the quota shape has to be present
		// and satisfiable or every placement would be refused for exceeding it.
		const billing = defaultEmbeddedPolicySet("b").billing;
		expect(billing.quotaUsed).toBe(0);
		expect(billing.budgetUsd).toBe(0);
		expect(billing.quotaLimit).toBeGreaterThan(0);
	});
});

describe("persisted broker state", () => {
	it("reports no state when nothing has been written", () => {
		// A first run has none, and that is the signal to build one — not an
		// error to report to the user.
		expect(loadEmbeddedBrokerState(home())).toBeNull();
	});

	it("round-trips a saved state and creates the home directory", () => {
		const dir = join(home(), "nested");
		const path = saveEmbeddedBrokerState(state(), dir);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		expect(loadEmbeddedBrokerState(dir)?.brokerId).toBe("broker:local/test");
	});

	it("reports no state for a document from another schema version", () => {
		// Reading an unknown version with today's shape would place against
		// fields that may mean something different. Rebuilding is safe; guessing
		// is not.
		const dir = home();
		saveEmbeddedBrokerState(
			state({ schemaVersion: "hobo.broker-runtime/v0" as never }),
			dir,
		);
		expect(loadEmbeddedBrokerState(dir)).toBeNull();
	});

	it("reports no state for a truncated file", () => {
		// An interrupted write leaves exactly this, and the recovery is the same
		// as for no file at all.
		const dir = home();
		const path = saveEmbeddedBrokerState(state(), dir);
		writeFileSync(path, "{ broken", "utf8");
		expect(loadEmbeddedBrokerState(dir)).toBeNull();
	});
});

describe("describeBrokerRuntime", () => {
	it("names both files it looked at, whether or not they exist", () => {
		// This is the diagnostic surface: a user whose Yard is not behaving needs
		// the paths even — especially — when the documents are missing, because
		// "no yard config" is only actionable once you know where one would go.
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
		// Later commands have to agree with the deploy that just ran, or an
		// `inspect` would probe a host the component is not on.
		const dir = home();
		saveEmbeddedBrokerState(state({ preferredComponentHost: "wasm" }), dir);
		expect(defaultComponentHostFromBroker(dir)).toBe("wasm");
	});

	it("normalizes a legacy preference rather than failing on it", () => {
		// `isolated-wasm` is what older states hold. Refusing it would break
		// every command on a machine that has simply not re-run `yard init`.
		const dir = home();
		saveEmbeddedBrokerState(
			state({ preferredComponentHost: "isolated-wasm" as never }),
			dir,
		);
		expect(defaultComponentHostFromBroker(dir)).toBe("wasm");
	});

	it("falls back to the default host for an unrecognisable preference", () => {
		// A hand-edited or corrupted value must not propagate into placement.
		// The default is always serviceable, which an invented host is not.
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

describe("collectExplicitProviderPins", () => {
	it("returns nothing for a Bindle that names no provider", () => {
		// Bindles are provider-agnostic by construction (ADR-0144); Yard
		// selection owns provider context. The deprecated helper survives only
		// to assert that, so an empty result is the whole contract.
		const pins = collectExplicitProviderPins({
			name: "app",
			resources: {},
			edges: [],
			requirements: { require: [], prefer: [], runtimes: [], labels: {} },
		} as never);
		expect(pins).toEqual([]);
		expect(Object.isFrozen(pins)).toBe(true);
	});
});
