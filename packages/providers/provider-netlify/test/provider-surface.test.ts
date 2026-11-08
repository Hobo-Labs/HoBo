/**
 * The `CloudProvider` surface: capability matching, realize, the manifest, and
 * the client factory.
 *
 * This is what Matching consults to decide whether Netlify can host a request,
 * and the answers have to be *honest in the narrowing direction*. Netlify hosts
 * one thing — a site on the compute port — and every claim here is scoped to
 * that. The failure that matters is over-claiming: a `full` match returned for
 * a request naming a feature the provider cannot offer sends a workload to a
 * host that will not run it, and the discovery happens at deploy time rather
 * than at planning time when a portability report could have said so.
 *
 * The mirror failure is `realize` or `client` silently accepting a port this
 * provider does not host. Both refuse by name instead, because a driver program
 * built for the wrong resource class would be handed to the deploy step as
 * though it were valid.
 */
import { describe, expect, it } from "vitest";

import {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	netlifyNativePorts,
} from "../src/equivalence.js";
import { PROVIDER_TARGET } from "../src/options.js";
import { createNetlifyProvider } from "../src/provider.js";
import type { PortRequest, ResourcePlan } from "../src/types.js";

const provider = createNetlifyProvider();

function computeCapability() {
	const capability = provider.capabilities.find(
		(entry) => entry.port === "compute",
	);
	expect(capability).toBeDefined();
	if (!capability) throw new Error("unreachable");
	return capability;
}

function request(overrides: Partial<PortRequest> = {}): PortRequest {
	return { port: "compute", ...overrides };
}

describe("provider identity", () => {
	it("names itself with the package id", () => {
		// The id appears in every plan, receipt and portability report. A bare
		// `"netlify"` would collide with the option-block target, which is a
		// different namespace.
		expect(provider.id).toBe("@hobo/provider-netlify");
	});

	it("declares a single global region", () => {
		// Netlify's edge is global rather than region-selected. Advertising a
		// region list it does not have would let a residency constraint appear
		// satisfiable when it is not.
		expect(provider.regions).toEqual(["global"]);
	});

	it("declares one capability per equivalence class", () => {
		expect(provider.capabilities).toHaveLength(INITIAL_CAPABILITY_PORTS.length);
		expect(provider.capabilities.map((entry) => entry.port)).toEqual([
			"compute",
		]);
	});
});

describe("capability matching", () => {
	it("returns none for a port it does not host", () => {
		// Not a partial with everything missing: `none` says "wrong provider",
		// which is what stops Matching from reporting a remediation path that
		// does not exist.
		for (const port of ["kv", "database", "objectStore", "queue"]) {
			expect(computeCapability().satisfies(request({ port }))).toEqual({
				kind: "none",
			});
		}
	});

	it("returns full for a featureless request on its own port", () => {
		expect(computeCapability().satisfies(request())).toEqual({ kind: "full" });
	});

	it("returns full when every requested feature is offered", () => {
		expect(
			computeCapability().satisfies(
				request({ features: ["http", "edge", "managed"] }),
			),
		).toEqual({ kind: "full" });
	});

	it("returns partial naming exactly what is missing", () => {
		// The honesty requirement. A `full` here would send a workload needing
		// container semantics to a static-site host, and the failure would land
		// at deploy time rather than in a portability report.
		expect(
			computeCapability().satisfies(
				request({ features: ["http", "container", "postgres"] }),
			),
		).toEqual({ kind: "partial", missing: ["container", "postgres"] });
	});

	it("treats an absent feature list as no requirements", () => {
		// `req.features ?? []`. A request that named none is asking for the port,
		// not for nothing — refusing it would make the common case unmatchable.
		expect(
			computeCapability().satisfies(request({ features: undefined })),
		).toEqual({ kind: "full" });
	});

	it("matches feature names exactly", () => {
		// No normalisation, so `HTTP` is not `http`. Pinned as the contract:
		// callers pass canonical names, and a case-insensitive match here would
		// silently accept a typo that means something else on another provider.
		expect(
			computeCapability().satisfies(request({ features: ["HTTP"] })),
		).toEqual({ kind: "partial", missing: ["HTTP"] });
	});

	it("estimates a cost signal for its own port", () => {
		const cost = computeCapability().estimateCost(request());
		expect(cost.currency).toBe("USD");
		expect(cost.sku).toBe(`${PROVIDER_TARGET}:netlify:site`);
		expect(cost.unit).toBe("request");
		// Zero marginal price is a claim about the free tier, and it is stated as
		// a string so a comparison never goes through float arithmetic.
		expect(cost.marginalPrice).toBe("0");
		expect(cost.marginalPrice).toEqual(expect.any(String));
		expect(cost.pricingStatus).toBe("unknown");
	});
});

describe("realize", () => {
	function plan(overrides: Partial<ResourcePlan> = {}): ResourcePlan {
		return { name: "site-a", port: "compute", ...overrides };
	}

	it("builds a driver program for its own port", () => {
		// A *driver* program, not IaC. Netlify has no Terraform-shaped surface
		// worth pretending to, and emitting one would misrepresent how the
		// deploy actually happens.
		const { driver } = provider.realize(plan());
		expect(driver.apiVersion).toBe("hobo.driver-program/v1");
		expect(driver.driver).toBe(`${PROVIDER_TARGET}-deploy`);
	});

	it("names the resource with the plan's own name and the mapped class", () => {
		// The resource class is what the deploy step dispatches on. A wrong or
		// missing one would be handed downstream as though it were valid.
		const { driver } = provider.realize(plan({ name: "marketing" }));
		expect(driver.resources).toHaveLength(1);
		expect(driver.resources[0]).toEqual({
			name: "marketing",
			type: "netlify:site",
			provider: PROVIDER_TARGET,
		});
	});

	it("refuses a port it cannot realize, naming it", () => {
		// The mirror of the `none` match. Silently producing a driver program for
		// an unsupported port would defer the failure to the deploy.
		for (const port of ["kv", "database", "queue"]) {
			expect(() => provider.realize(plan({ port }))).toThrow(
				new RegExp(`cannot realize port ${port}`, "u"),
			);
		}
	});
});

describe("capabilityManifest", () => {
	it("declares the brokered-token posture and no static secrets", () => {
		// HOBO-110: this adapter never holds a static vendor token. The manifest
		// is where an operator checks that before wiring it up, so a `true` here
		// would be a claim with real consequences.
		const manifest = provider.capabilityManifest();
		expect(manifest.auth).toEqual({
			exchange: "hobo:brokered-deploy-token",
			staticSecrets: false,
		});
	});

	it("names the same provider id as the provider itself", () => {
		// Two ids that disagreed would make a published manifest unattributable
		// to the provider that published it.
		expect(provider.capabilityManifest().providerId).toBe(provider.id);
	});

	it("lists every capability port", () => {
		const manifest = provider.capabilityManifest();
		expect(manifest.capabilities.capabilities).toEqual([
			{
				port: "compute",
				productId: "netlify.static-deploy/v1",
				profiles: ["web.static/v1", "web.hosted/v1"],
				features: ["http", "static", "edge", "managed"],
				resourceKind: "immutable-deployment",
			},
		]);
	});

	it("publishes no cost facts and an empty well-known document set", () => {
		// Pinned as an honest gap rather than an intent: unlike the Lakebed
		// adapter, this one declares no cost facts and publishes no
		// `/.well-known/capability-manifest/*` documents. A cost-aware
		// dispatcher therefore has nothing to rank Netlify on. Recorded so that
		// filling them in later is a deliberate change and not mistaken for a
		// regression in this test.
		const manifest = provider.capabilityManifest();
		expect(manifest.cost).toEqual({ pricingStatus: "unknown", facts: [] });
		expect(manifest.published).toEqual({});
	});
});

describe("client", () => {
	it("returns a client carrying the mapped class and service name", () => {
		// The service name is what a receipt cites. A client that reported the
		// port instead would make two providers hosting the same port
		// indistinguishable in the record.
		const client = provider.client("compute", { url: "https://x" });
		expect(client.port).toBe("compute");
		expect(client.resourceClass).toBe("netlify:site");
		expect(client.providerService).toBe("Netlify Site");
	});

	it("carries the plan outputs through as bindings", () => {
		const outputs = { url: "https://site.netlify.app" };
		expect(provider.client("compute", outputs).bindings).toEqual(outputs);
	});

	it("refuses a port it does not host, naming it", () => {
		for (const port of ["kv", "database"]) {
			expect(() => provider.client(port, {})).toThrow(
				new RegExp(`no client for port ${port}`, "u"),
			);
		}
	});
});

describe("equivalence classes", () => {
	it("maps the single class to a port, resource class and service", () => {
		const entry = equivalenceForPort("web/service");
		expect(entry.port).toBe("compute");
		expect(entry.resourceClass).toBe("netlify:site");
		expect(entry.providerService).toBe("Netlify Site");
	});

	it("keeps the feature list off semantics a static-site host cannot offer", () => {
		// Deliberately narrow, the same discipline as the Lakebed adapter: a
		// `require: ["container"]` must surface as partial with remediation
		// rather than as fabricated parity.
		const entry = equivalenceForPort("web/service");
		expect(entry.features).toContain("http");
		expect(entry.features).not.toContain("container");
		expect(entry.features).not.toContain("postgres");
	});

	it("deduplicates the native port list", () => {
		const ports = netlifyNativePorts();
		expect(new Set(ports).size).toBe(ports.length);
		expect([...ports]).toEqual(["compute"]);
	});

	it("freezes the class table and the port list", () => {
		// Read on every Matching pass; a caller that could add a class at runtime
		// would widen what this provider claims for the whole process.
		expect(Object.isFrozen(EQUIVALENCE_CLASSES)).toBe(true);
		expect(Object.isFrozen(INITIAL_CAPABILITY_PORTS)).toBe(true);
	});
});
