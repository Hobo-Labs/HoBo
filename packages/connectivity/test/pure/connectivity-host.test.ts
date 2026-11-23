import { describe, expect, it } from "vitest";
import {
	CONNECTIVITY_HOST_PROVIDER_NAME,
	createConnectivityHostHandler,
} from "../../src/connectivity-host.js";
import {
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../../src/json.js";

const host = () => createConnectivityHostHandler();

const get = (path: string) => host().handle({ method: "GET", path });
const post = (path: string, body?: JsonValue) =>
	host().handle({
		method: "POST",
		path,
		...(body === undefined ? undefined : { body }),
	});

describe("identity and routing", () => {
	it("names itself as the PACT provider", () => {
		expect(host().name).toBe(CONNECTIVITY_HOST_PROVIDER_NAME);
		expect(CONNECTIVITY_HOST_PROVIDER_NAME).toBe("ConnectivityHost");
	});

	it("404s an unknown path and echoes it back", async () => {
		const response = await post("/nope");
		expect(response.status).toBe(404);
		expect(response.body).toEqual({
			error: { code: "UNKNOWN_PATH", path: "/nope" },
		});
	});

	it("routes on method as well as path", async () => {
		expect((await get("/policy/evaluate")).status).toBe(404);
		expect((await post("/metering/events")).status).toBe(404);
	});

	it("matches named endpoints by prefix but other routes exactly", async () => {
		expect((await get("/named-endpoints/anything")).status).toBe(200);
		expect((await post("/dns/reconcile/extra")).status).toBe(404);
	});
});

describe("named endpoints", () => {
	it("defaults resource, app and mode when the query supplies none", async () => {
		const response = await get("/named-endpoints/local");
		expect(response.status).toBe(200);
		const body = response.body as {
			url: string;
			hostname: string;
			mode: string;
		};
		expect(body.mode).toBe("local");
		expect(body.url).toContain("myapp");
		expect(body.url).toContain("web");
	});

	it("selects overlay mode from the path suffix", async () => {
		const body = (await get("/named-endpoints/overlay")).body as {
			mode: string;
		};
		expect(body.mode).toBe("overlay");
	});

	it("treats any non-overlay suffix as local", async () => {
		for (const suffix of ["local", "", "overlayish", "OVERLAY"]) {
			const body = (await get(`/named-endpoints/${suffix}`)).body as {
				mode: string;
			};
			expect(body.mode).toBe("local");
		}
	});

	it("threads resource, app, env, tenant and branch from the query", async () => {
		const response = await get(
			"/named-endpoints/local?resource=api&app=shop&env=staging&tenant=acme&branch=feat",
		);
		expect(response.status).toBe(200);
		const body = response.body as { url: string };
		expect(body.url).toContain("api");
		expect(body.url).toContain("shop");
	});

	it("derives hostname by stripping the scheme from the url", async () => {
		const body = (await get("/named-endpoints/local")).body as {
			url: string;
			hostname: string;
		};
		expect(body.hostname).toBe(body.url.replace(/^https?:\/\//, ""));
		expect(body.hostname).not.toMatch(/^https?:/);
	});

	it("reports an invalid endpoint as a 400 carrying the underlying reason", async () => {
		const response = await get("/named-endpoints/local?resource=%20");
		expect(response.status).toBe(400);
		expect(response.body).toEqual({
			error: {
				code: "NAMED_ENDPOINT_INVALID",
				message: "named endpoint resource sanitizes to empty label",
			},
		});
	});
});

describe("policy evaluation", () => {
	const evaluate = (body: JsonObject) => post("/policy/evaluate", body);

	it("defaults to the tag-acl engine", async () => {
		const body = (await evaluate({})).body as { engineId: string };
		expect(body.engineId).toBeTruthy();
		expect(body.engineId).not.toContain("opa");
	});

	it("selects OPA only on an exact engine match", async () => {
		const opa = (await evaluate({ engine: "opa" })).body as {
			engineId: string;
		};
		expect(opa.engineId).toContain("opa");

		for (const engine of ["OPA", "opa-lite", true, 1, null]) {
			const other = (await evaluate({ engine })).body as { engineId: string };
			expect(other.engineId).not.toContain("opa");
		}
	});

	it("returns effect, engineId and reasons on every decision", async () => {
		const body = (await evaluate({ action: "read" })).body as {
			effect: string;
			engineId: string;
			reasons: unknown;
		};
		expect(isJsonString(body.effect)).toBe(true);
		expect(isJsonString(body.engineId)).toBe(true);
		expect(Array.isArray(body.reasons)).toBe(true);
	});

	it("defaults the resource tenant to the subject tenant", async () => {
		const sameTenant = (await evaluate({ subjectTenant: "acme" })).body as {
			effect: string;
		};
		const crossTenant = (
			await evaluate({
				subjectTenant: "acme",
				resourceTenant: "other",
			})
		).body as { effect: string };
		expect(sameTenant.effect).not.toBe(crossTenant.effect);
	});

	it("adds a development env tag to whichever side omits one", async () => {
		const bothDefaulted = (
			await evaluate({ subjectTags: [], resourceTags: [] })
		).body as { effect: string };
		const inherited = (
			await evaluate({
				subjectTags: ["env:production"],
				resourceTags: [],
			})
		).body as { effect: string };
		expect(bothDefaulted.effect).toBe(inherited.effect);
	});

	it("keeps an explicit env tag on each side rather than overwriting it", async () => {
		const mismatched = (
			await evaluate({
				subjectTags: ["env:development"],
				resourceTags: ["env:production"],
			})
		).body as { effect: string };
		const matched = (
			await evaluate({
				subjectTags: ["env:production"],
				resourceTags: ["env:production"],
			})
		).body as { effect: string };
		expect(mismatched.effect).not.toBe(matched.effect);
	});

	it("ignores non-string entries in the tag arrays", async () => {
		const response = await evaluate({
			subjectTags: ["env:production", 42, null, {}],
			resourceTags: ["env:production", false],
		});
		expect(response.status).toBe(200);
	});

	it("ignores tags entirely when they are not arrays", async () => {
		for (const subjectTags of ["env:production", 7, null, {}]) {
			const response = await evaluate({ subjectTags });
			expect(response.status).toBe(200);
		}
	});

	it("marks a resource shared only on strict boolean true", async () => {
		const shared = (
			await evaluate({
				subjectTenant: "acme",
				resourceTenant: "other",
				resourceShared: true,
			})
		).body as { effect: string };
		const notShared = (
			await evaluate({
				subjectTenant: "acme",
				resourceTenant: "other",
				resourceShared: "true",
			})
		).body as { effect: string };
		expect(shared.effect).not.toBe(notShared.effect);
	});

	it("tolerates a missing body", async () => {
		expect((await post("/policy/evaluate")).status).toBe(200);
	});
});

describe("DNS reconcile", () => {
	it("applies a CNAME to an allowed gateway suffix", async () => {
		const response = await post("/dns/reconcile", {
			tenantId: "acme",
			hostname: "web.myapp.hobo.example.com",
			gatewayHostname: "funnel.ts.net",
		});
		expect(response.status).toBe(200);
		expect(response.body).toEqual({
			applied: true,
			suggested: {
				name: "web.myapp.hobo.example.com",
				type: "CNAME",
				content: "funnel.ts.net",
				ttl: 300,
				gatewayTarget: true,
			},
		});
	});

	it("uses documented defaults when the body omits fields", async () => {
		expect((await post("/dns/reconcile", {})).status).toBe(200);
		expect((await post("/dns/reconcile")).status).toBe(200);
	});

	it("refuses a gateway outside the allowed suffixes", async () => {
		const response = await post("/dns/reconcile", {
			gatewayHostname: "attacker.example.net",
		});
		expect(response.status).toBe(400);
		expect(response.body).toEqual({
			error: {
				code: "DNS_RECONCILE_FAILED",
				message:
					"public DNS must target an authenticated gateway, not raw overlay IP or untrusted host: attacker.example.net",
			},
		});
	});

	it("surfaces an unparseable tenant as a 400, not a crash", async () => {
		const response = await post("/dns/reconcile", { tenantId: "" });
		expect(response.status).toBe(400);
		expect(response.body).toEqual({
			error: {
				code: "DNS_RECONCILE_FAILED",
				message: "tenantId must be non-empty",
			},
		});
	});
});

describe("DNS suggest", () => {
	it("returns a suggestion without applying it", async () => {
		const response = await post("/dns/suggest", {
			tenantId: "acme",
			hostname: "web.myapp.hobo.example.com",
			gatewayHostname: "funnel.ts.net",
		});
		expect(response.status).toBe(200);
		expect(response.body).toHaveProperty("suggested");
		expect(response.body).not.toHaveProperty("applied");
	});

	it("uses documented defaults when the body omits fields", async () => {
		expect((await post("/dns/suggest", {})).status).toBe(200);
		expect((await post("/dns/suggest")).status).toBe(200);
	});

	it("reports failure under its own code, distinct from reconcile", async () => {
		const response = await post("/dns/suggest", {
			gatewayHostname: "attacker.example.net",
		});
		expect(response.status).toBe(400);
		expect(response.body).toEqual({
			error: {
				code: "DNS_SUGGEST_FAILED",
				message:
					"public DNS must target an authenticated gateway, not raw overlay IP or untrusted host: attacker.example.net",
			},
		});
	});
});

describe("metering", () => {
	it("starts empty", async () => {
		const body = (await get("/metering/events")).body as {
			count: number;
			eventTypes: string[];
		};
		expect(body.count).toBe(0);
		expect(body.eventTypes).toEqual([]);
	});

	it("records events as work flows through the host", async () => {
		const handler = host();
		await handler.handle({
			method: "POST",
			path: "/policy/evaluate",
			body: { action: "read" },
		});
		const body = (
			await handler.handle({ method: "GET", path: "/metering/events" })
		).body as { count: number; eventTypes: string[] };
		expect(body.count).toBeGreaterThan(0);
		expect(body.eventTypes).toHaveLength(body.count);
	});

	it("keeps each handler's meter independent", async () => {
		const busy = host();
		await busy.handle({
			method: "POST",
			path: "/policy/evaluate",
			body: {},
		});
		const busyCount = (
			await busy.handle({ method: "GET", path: "/metering/events" })
		).body as { count: number };
		const fresh = (await get("/metering/events")).body as { count: number };
		expect(busyCount.count).toBeGreaterThan(0);
		expect(fresh.count).toBe(0);
	});
});
