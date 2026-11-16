/**
 * The Vercel provider's capability surface.
 *
 * Four equivalence classes — compute, object store, database, KV — each mapped
 * to a headline Vercel product. The surface is small, and every method on it
 * feeds a decision made elsewhere: `satisfies` feeds placement, `estimateCost`
 * feeds ranking, `realize` feeds the driver, `client` feeds whatever binds to
 * the deployed thing. The failure mode they share is that a wrong answer here
 * does not fail — it produces a plausible plan that is wrong.
 */
import { describe, expect, it } from "vitest";

import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
} from "../src/equivalence.js";
import { PROVIDER_TARGET } from "../src/options.js";
import { createVercelProvider } from "../src/provider.js";

const provider = createVercelProvider();

function capabilityFor(port: string) {
	const capability = provider.capabilities.find((c) => c.port === port);
	expect(capability).toBeDefined();
	if (!capability) throw new Error("unreachable");
	return capability;
}

describe("identity", () => {
	it("names itself with the scoped package id", () => {
		expect(provider.id).toBe("@hobo/provider-vercel");
		expect(provider.capabilityManifest().providerId).toBe(provider.id);
	});

	it("declares one capability per equivalence class", () => {
		expect(provider.capabilities).toHaveLength(INITIAL_CAPABILITY_PORTS.length);
		expect(provider.capabilities.map((c) => c.port).sort()).toEqual(
			INITIAL_CAPABILITY_PORTS.map(
				(key) => EQUIVALENCE_CLASSES[key].port,
			).sort(),
		);
	});

	it("serves the four ports its authoring options target", () => {
		// The option builders and the capability list have to agree, or a block a
		// caller can write would name a port this provider does not serve — and
		// placement would drop it silently rather than refusing it.
		for (const port of ["compute", "objectStore", "database", "kv"]) {
			expect(provider.capabilities.some((c) => c.port === port)).toBe(true);
		}
	});

	it("resolves each class key to its mapping", () => {
		for (const key of INITIAL_CAPABILITY_PORTS) {
			expect(equivalenceForPort(key).resourceClass.length).toBeGreaterThan(0);
			expect(equivalenceForPort(key).providerService.length).toBeGreaterThan(0);
		}
	});
});

describe("satisfies", () => {
	it("matches fully when every requested feature is offered", () => {
		const compute = capabilityFor("compute");
		const features = EQUIVALENCE_CLASSES["web/service"].features;
		expect(
			compute.satisfies({ port: "compute", features: [...features] }),
		).toEqual({ kind: "full" });
	});

	it("matches fully when no features are requested at all", () => {
		// The `?? []` path — the common case, and it must not read as a request
		// for an unknown feature.
		expect(capabilityFor("compute").satisfies({ port: "compute" })).toEqual({
			kind: "full",
		});
	});

	it("reports a partial match naming exactly what is missing", () => {
		// The missing list is what placement uses to decide between substituting
		// and failing. Reporting `none` would hide a near-miss a human could have
		// resolved by dropping one feature.
		expect(
			capabilityFor("compute").satisfies({
				port: "compute",
				features: ["gpu-inference"],
			}),
		).toEqual({ kind: "partial", missing: ["gpu-inference"] });
	});

	it("lists every missing feature, not just the first", () => {
		// A caller shown one missing feature would fix it and be told about the
		// next one, a round trip at a time.
		const match = capabilityFor("kv").satisfies({
			port: "kv",
			features: ["transactions", "streams"],
		});
		expect(match).toEqual({
			kind: "partial",
			missing: ["transactions", "streams"],
		});
	});

	it("reports no match for a port this capability does not serve", () => {
		// Every capability is asked about every port during matching, so "not
		// mine" is the common answer and has to be cheap and total.
		expect(capabilityFor("compute").satisfies({ port: "kv" })).toEqual({
			kind: "none",
		});
		expect(capabilityFor("kv").satisfies({ port: "queue" })).toEqual({
			kind: "none",
		});
	});
});

describe("estimateCost", () => {
	it("prices in USD against a provider-qualified SKU", () => {
		// The SKU is what a published price joins on. An unqualified resource
		// class would collide with another provider's identically-named one.
		for (const capability of provider.capabilities) {
			const cost = capability.estimateCost({ port: capability.port });
			expect(cost.currency).toBe("USD");
			expect(cost.sku.startsWith(`${PROVIDER_TARGET}:`)).toBe(true);
		}
	});

	it("publishes a zero marginal price that means unpriced, not free", () => {
		// This package publishes no cost facts, so there is nothing dated to rank
		// on — and the empty `cost.facts` in the manifest says so structurally. A
		// ranker reading `"0"` as free would place every workload here.
		for (const capability of provider.capabilities) {
			expect(
				capability.estimateCost({ port: capability.port }).marginalPrice,
			).toBe("0");
		}
		expect(provider.capabilityManifest().cost).toEqual({
			pricingStatus: "unknown",
			facts: [],
		});
	});

	it("gives each class its own SKU", () => {
		// Two products sharing a SKU would make a cost comparison between them
		// meaningless.
		const skus = provider.capabilities.map(
			(c) => c.estimateCost({ port: c.port }).sku,
		);
		expect(new Set(skus).size).toBe(skus.length);
	});
});

describe("capabilityManifest", () => {
	it("declares brokered token exchange and no static secrets", () => {
		// Secretless-first. `staticSecrets: true` would claim this provider holds
		// long-lived material, which it does not — the sponsoring token is
		// brokered per operation.
		expect(provider.capabilityManifest().auth).toEqual({
			exchange: "hobo:brokered-deploy-token",
			staticSecrets: false,
		});
	});

	it("lists every capability port", () => {
		const manifest = provider.capabilityManifest();
		expect(
			manifest.capabilities.capabilities.map((c) => c.port).sort(),
		).toEqual(provider.capabilities.map((c) => c.port).sort());
	});

	it("is stable across calls", () => {
		// Two manifests from one provider must describe the same thing, or a
		// dispatcher re-reading one mid-run would see the provider change under
		// it.
		expect(JSON.stringify(provider.capabilityManifest())).toBe(
			JSON.stringify(provider.capabilityManifest()),
		);
	});
});

describe("realize", () => {
	it("emits a driver program naming the mapped resource class", () => {
		const { driver } = provider.realize({
			name: "web",
			port: "compute",
		});
		expect(driver.apiVersion).toBe("hobo.driver-program/v1");
		expect(driver.driver).toBe("vercel-deploy");
		expect(driver.resources[0]).toMatchObject({
			name: "web",
			provider: PROVIDER_TARGET,
		});
	});

	it("realizes each port to its own resource class", () => {
		// The mapping is the whole point of the equivalence table; realizing two
		// ports to one class would deploy the wrong product for one of them.
		const classes = provider.capabilities.map(
			(c) =>
				provider.realize({ name: "r", port: c.port }).driver.resources[0]?.type,
		);
		expect(new Set(classes).size).toBe(classes.length);
	});

	it("refuses a port it cannot realize, naming the port", () => {
		// Named because a placement that reached here picked the wrong provider,
		// and the reader needs to know which port did it.
		expect(() => provider.realize({ name: "q", port: "queue" })).toThrow(
			/cannot realize port queue/u,
		);
	});
});

describe("client", () => {
	it("carries the mapped class, service name, and bindings", () => {
		const client = provider.client("kv", { EDGE_CONFIG: "ec_1" });
		expect(client.port).toBe("kv");
		expect(client.resourceClass.length).toBeGreaterThan(0);
		expect(client.providerService.length).toBeGreaterThan(0);
		expect(client.bindings).toEqual({ EDGE_CONFIG: "ec_1" });
	});

	it("builds a client for every port it declares", () => {
		// A provider that matched a port but could not produce a client for it
		// would fail after placement had already committed to it.
		for (const capability of provider.capabilities) {
			expect(() => provider.client(capability.port, {})).not.toThrow();
		}
	});

	it("refuses a client for a port it has none for", () => {
		expect(() => provider.client("queue", {})).toThrow(
			/no client for port queue/u,
		);
	});
});
