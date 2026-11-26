/**
 * The Dapr runtime config — parsing it, and scoping the app id.
 *
 * A Dapr sidecar's app-id is the address every other actor and pubsub
 * subscriber uses to reach it. That makes **tenant scoping the security
 * property here**: two tenants running an app called `orders` must not resolve
 * to the same Dapr identity, or one tenant's invocations land on the other's
 * sidecar. The physical form is `{tenant}.{camp}.{app}`, and it is applied on
 * the way in rather than left to callers.
 *
 * **Identity fields refuse; behaviour fields default.** Tenant, camp, and the
 * SVID binding reference each throw when missing or empty — an empty tenant
 * would collapse the scoping above, and an empty binding ref would mint a
 * sidecar with no workload identity. Endpoints and feature flags default,
 * because a wrong endpoint fails visibly on the first call.
 *
 * **Both key spellings are accepted throughout.** The config arrives from
 * hand-written YAML (snake_case) and from TypeScript (camelCase), and honouring
 * only one would make half the sources silently fall back to defaults — a
 * `pubsubEnabled: false` read as "absent, so true" is a feature turned back on
 * behind the operator's back.
 *
 * The result is frozen: it is read on every invocation, and a caller mutating
 * it would redirect traffic for the life of the process.
 */
import { MessagingParseError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	defaultDaprRuntimeConfig,
	parseDaprDeployMode,
	parseDaprRuntimeConfig,
	tenantScopedAppId,
} from "../src/config.js";

/** A config document that parses, for tests that vary one field. */
function doc(overrides: Record<string, unknown> = {}) {
	return { tenantId: "acme", campId: "camp-1", appId: "orders", ...overrides };
}

describe("parseDaprDeployMode", () => {
	it("accepts the two real modes", () => {
		expect(parseDaprDeployMode("self-hosted")).toBe("self-hosted");
		expect(parseDaprDeployMode("kubernetes")).toBe("kubernetes");
	});

	it("refuses anything else, naming both options", () => {
		// The mode decides how the sidecar is launched. An unrecognised one
		// would be carried into a launcher that has no branch for it.
		for (const raw of ["k8s", "", undefined, null, 7, "Kubernetes"]) {
			expect(() => parseDaprDeployMode(raw)).toThrow(MessagingParseError);
		}
		expect(() => parseDaprDeployMode("k8s")).toThrow(/self-hosted\|kubernetes/);
	});
});

describe("tenantScopedAppId", () => {
	it("prefixes tenant and camp onto a bare app name", () => {
		// This is the whole isolation mechanism: two tenants' `orders` apps have
		// to be two Dapr identities.
		expect(tenantScopedAppId("acme", "camp-1", "orders")).toBe(
			"acme.camp-1.orders",
		);
	});

	it("leaves an already-scoped name alone", () => {
		// Scoping twice would produce `acme.camp-1.acme.camp-1.orders`, which no
		// sidecar answers to — and the caller would see invocation timeouts
		// rather than a naming error.
		expect(tenantScopedAppId("acme", "camp-1", "acme.camp-1.orders")).toBe(
			"acme.camp-1.orders",
		);
	});

	it("treats any name already starting with the tenant as scoped", () => {
		// The check is on the tenant prefix, not the full triple, so a name
		// scoped under a different camp is left as-is. Pinned deliberately: the
		// tenant is the isolation boundary, and re-scoping across camps within
		// one tenant would rename an app that is already addressable.
		expect(tenantScopedAppId("acme", "camp-2", "acme.camp-1.orders")).toBe(
			"acme.camp-1.orders",
		);
	});

	it("refuses an empty tenant, camp, or app", () => {
		// An empty tenant collapses the isolation entirely — every tenant's
		// apps would scope to `.camp.app`.
		expect(() => tenantScopedAppId("", "camp-1", "orders")).toThrow(/tenantId/);
		expect(() => tenantScopedAppId("acme", "", "orders")).toThrow(/campId/);
		expect(() => tenantScopedAppId("acme", "camp-1", "")).toThrow(/app/);
	});

	it("refuses a non-string in any position", () => {
		for (const bad of [undefined, null, 7] as unknown[]) {
			expect(() =>
				tenantScopedAppId(bad as string, "camp-1", "orders"),
			).toThrow(MessagingParseError);
		}
	});
});

describe("parseDaprRuntimeConfig — required fields", () => {
	it("refuses anything that is not an object", () => {
		for (const raw of [null, undefined, "config", 7, ""]) {
			expect(() => parseDaprRuntimeConfig(raw)).toThrow(MessagingParseError);
		}
	});

	it("requires a tenant and a camp under either spelling", () => {
		// Both arrive from real sources — YAML writes snake_case, TypeScript
		// writes camelCase.
		expect(
			parseDaprRuntimeConfig({ tenant_id: "acme", camp_id: "c" }).tenantId,
		).toBe("acme");
		expect(parseDaprRuntimeConfig(doc()).campId).toBe("camp-1");
		expect(() => parseDaprRuntimeConfig({ campId: "c" })).toThrow(/tenantId/);
		expect(() => parseDaprRuntimeConfig({ tenantId: "a" })).toThrow(/campId/);
		expect(() => parseDaprRuntimeConfig(doc({ tenantId: "" }))).toThrow(
			/tenantId/,
		);
	});

	it("prefers the camelCase spelling when both are present", () => {
		// A half-migrated document carries both. Preferring the current spelling
		// means an edit to the field a developer can see is the one that wins.
		expect(
			parseDaprRuntimeConfig({
				tenantId: "camel",
				tenant_id: "snake",
				campId: "c",
			}).tenantId,
		).toBe("camel");
	});

	it("defaults the app name to `app` but still scopes it", () => {
		// An unnamed app is still one tenant's app. Skipping the scoping for the
		// default would make every tenant's unnamed app share one identity.
		expect(
			parseDaprRuntimeConfig({ tenantId: "acme", campId: "c" }).appId,
		).toBe("acme.c.app");
	});

	it("refuses an explicitly empty app name rather than defaulting it", () => {
		// `??` does not treat `""` as absent, so an empty string reaches the
		// non-empty check and is refused. Pinned: an empty app name is a
		// mistake in the document, not a request for the default.
		expect(() => parseDaprRuntimeConfig(doc({ appId: "" }))).toThrow(/appId/);
	});

	it("requires a non-empty SVID binding reference", () => {
		// The binding is how the sidecar gets a workload identity. An empty one
		// would start a sidecar with no credential and fail on the first
		// authenticated call, far from here.
		expect(() => parseDaprRuntimeConfig(doc({ svidBindingRef: "" }))).toThrow(
			/svidBindingRef/,
		);
		expect(parseDaprRuntimeConfig(doc()).svidBindingRef).toBe(
			"fromBinding:svid",
		);
		expect(
			parseDaprRuntimeConfig(doc({ svid_binding_ref: "fromBinding:mesh" }))
				.svidBindingRef,
		).toBe("fromBinding:mesh");
	});
});

describe("parseDaprRuntimeConfig — defaults", () => {
	it("defaults the mode to self-hosted and validates an explicit one", () => {
		expect(parseDaprRuntimeConfig(doc()).mode).toBe("self-hosted");
		expect(parseDaprRuntimeConfig(doc({ mode: "kubernetes" })).mode).toBe(
			"kubernetes",
		);
		expect(() => parseDaprRuntimeConfig(doc({ mode: "k8s" }))).toThrow(/mode/);
	});

	it("defaults the HTTP endpoint to the local sidecar", () => {
		// The sidecar runs beside the app by construction, so loopback is the
		// right default — and a wrong endpoint fails visibly on the first call.
		expect(parseDaprRuntimeConfig(doc()).httpEndpoint).toBe(
			"http://127.0.0.1:3500",
		);
		expect(
			parseDaprRuntimeConfig(doc({ http_endpoint: "http://sidecar:3500" }))
				.httpEndpoint,
		).toBe("http://sidecar:3500");
	});

	it("turns actors and pubsub on by default, and workflow off", () => {
		// Actors and pubsub are what a Dapr camp is for. Workflow is opt-in
		// because it needs a placement service that may not be running.
		const config = parseDaprRuntimeConfig(doc());
		expect(config.actorsEnabled).toBe(true);
		expect(config.pubsubEnabled).toBe(true);
		expect(config.workflowEnabled).toBe(false);
	});

	it("honours an explicit false under either spelling", () => {
		// This is the one that matters: `pubsubEnabled: false` read as "absent,
		// so true" would turn a feature back on behind the operator's back.
		for (const key of ["pubsubEnabled", "pubsub_enabled"]) {
			expect(parseDaprRuntimeConfig(doc({ [key]: false })).pubsubEnabled).toBe(
				false,
			);
		}
		expect(
			parseDaprRuntimeConfig(doc({ actors_enabled: false })).actorsEnabled,
		).toBe(false);
		expect(
			parseDaprRuntimeConfig(doc({ workflow_enabled: true })).workflowEnabled,
		).toBe(true);
	});

	it("defaults the pubsub component name", () => {
		expect(parseDaprRuntimeConfig(doc()).defaultPubsubName).toBe("pubsub");
		expect(
			parseDaprRuntimeConfig(doc({ default_pubsub_name: "events" }))
				.defaultPubsubName,
		).toBe("events");
	});
});

describe("parseDaprRuntimeConfig — optional endpoints", () => {
	it("omits the gRPC endpoint entirely when none is given", () => {
		// An empty-string endpoint would be dialled and fail; an absent key lets
		// the caller fall back to HTTP.
		expect(parseDaprRuntimeConfig(doc()).grpcEndpoint).toBeUndefined();
		expect(
			parseDaprRuntimeConfig(doc({ grpcEndpoint: "" })).grpcEndpoint,
		).toBeUndefined();
	});

	it("keeps a gRPC endpoint under either spelling", () => {
		expect(
			parseDaprRuntimeConfig(doc({ grpcEndpoint: "127.0.0.1:50001" }))
				.grpcEndpoint,
		).toBe("127.0.0.1:50001");
		expect(
			parseDaprRuntimeConfig(doc({ grpc_endpoint: "127.0.0.1:50001" }))
				.grpcEndpoint,
		).toBe("127.0.0.1:50001");
	});

	it("treats the placement address the same way", () => {
		// Placement is only needed for actors and workflow. Its absence is a
		// valid deployment, not a missing field.
		expect(parseDaprRuntimeConfig(doc()).placementAddress).toBeUndefined();
		expect(
			parseDaprRuntimeConfig(doc({ placement_address: "placement:50005" }))
				.placementAddress,
		).toBe("placement:50005");
	});
});

describe("the parsed config is frozen", () => {
	it("refuses mutation after parsing", () => {
		// The config is read on every invocation. A caller editing the endpoint
		// in place would redirect traffic for the life of the process, with no
		// record of where the change came from.
		const config = parseDaprRuntimeConfig(doc());
		expect(Object.isFrozen(config)).toBe(true);
		expect(() => {
			(config as { httpEndpoint: string }).httpEndpoint = "http://evil";
		}).toThrow();
	});
});

describe("defaultDaprRuntimeConfig", () => {
	it("produces a scoped, actor-and-pubsub-enabled self-hosted config", () => {
		const config = defaultDaprRuntimeConfig("acme", "camp-1");
		expect(config.appId).toBe("acme.camp-1.app");
		expect(config.mode).toBe("self-hosted");
		expect(config.actorsEnabled).toBe(true);
		expect(config.pubsubEnabled).toBe(true);
	});

	it("enables workflow, unlike the bare parse default", () => {
		// The convenience default is for a fully-featured local camp, where the
		// placement service comes up alongside. Pinned because the two defaults
		// deliberately differ — a caller reading one and expecting the other
		// would be surprised by whether workflow is available.
		expect(defaultDaprRuntimeConfig("acme", "camp-1").workflowEnabled).toBe(
			true,
		);
		expect(parseDaprRuntimeConfig(doc()).workflowEnabled).toBe(false);
	});

	it("refuses an empty tenant or camp, like the parser it delegates to", () => {
		expect(() => defaultDaprRuntimeConfig("", "camp-1")).toThrow(/tenantId/);
		expect(() => defaultDaprRuntimeConfig("acme", "")).toThrow(/campId/);
	});
});
