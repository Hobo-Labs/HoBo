import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";

import {
	attachNamedEndpoints,
	createNamedPreferringBindingResolver,
	getNamedEndpointSession,
	listNamedEndpointSessions,
} from "../../src/local/named-endpoints.js";

// SAFETY: assertion required at this I/O or test boundary.
const OFF = { enabled: false } as never;
// SAFETY: assertion required at this I/O or test boundary.
const ON = { enabled: true, binPath: "/usr/bin/portless" } as never;

function endpoint(overrides: JsonObject = {}) {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		resourceName: "web",
		kind: "service",
		backendUrl: "http://127.0.0.1:3000",
		external: true,
		serviceDiscoveryKey: "WEB_URL",
		...overrides,
	} as never;
}

let session = 0;
async function attach(options: JsonObject = {}) {
	session += 1;
	// SAFETY: assertion required at this I/O or test boundary.
	return attachNamedEndpoints({
		app: "myapp",
		endpoints: [endpoint()],
		processEnv: {},
		forcePortless: OFF,
		sessionId: `s${session}`,
		...options,
	} as never);
}

describe("building named endpoints", () => {
	it("produces one entry per endpoint", async () => {
		const result = await attach({
			endpoints: [
				endpoint(),
				endpoint({ resourceName: "api", serviceDiscoveryKey: "API_URL" }),
			],
		});
		expect(result.namedEndpoints).toHaveLength(2);
	});

	it("builds a hierarchical hostname from app and resource", async () => {
		const result = await attach();
		expect(result.namedEndpoints[0]?.hostname).toContain("web");
		expect(result.namedEndpoints[0]?.hostname).toContain("myapp");
	});

	it("keeps the backend URL as the source of truth", async () => {
		const result = await attach();
		expect(result.namedEndpoints[0]?.backendUrl).toBe("http://127.0.0.1:3000");
	});

	it("handles an empty endpoint list", async () => {
		const result = await attach({ endpoints: [] });
		expect(result.namedEndpoints).toEqual([]);
		expect(result.primaryNamedUrl).toBeNull();
	});
});

describe("scheme and port selection", () => {
	it("carries the real loopback port over http without portless", async () => {
		const result = await attach({ forcePortless: OFF });
		const url = result.namedEndpoints[0]?.url ?? "";
		expect(url.startsWith("http://")).toBe(true);
		expect(url).toContain("3000");
	});

	it("uses https with no port when portless terminates TLS", async () => {
		const result = await attach({ forcePortless: ON });
		const url = result.namedEndpoints[0]?.url ?? "";
		expect(url.startsWith("https://")).toBe(true);
		expect(url).not.toContain("3000");
	});

	it("does not use https when portless is enabled but has no binary", async () => {
		const result = await attach({
			// SAFETY: assertion required at this I/O or test boundary.
			forcePortless: { enabled: true } as never,
		});
		expect(result.namedEndpoints[0]?.url.startsWith("http://")).toBe(true);
	});

	it("always uses https for a private endpoint, which rides the mesh", async () => {
		const result = await attach({
			endpoints: [endpoint({ external: false })],
			forcePortless: OFF,
		});
		expect(result.namedEndpoints[0]?.url.startsWith("https://")).toBe(true);
	});

	it("forces a private endpoint to overlay mode regardless of the session mode", async () => {
		const result = await attach({
			endpoints: [endpoint({ external: false })],
			mode: "local",
		});
		expect(result.namedEndpoints[0]?.mode).toBe("overlay");
	});

	it("keeps an external endpoint in the session's mode", async () => {
		const result = await attach({ mode: "local" });
		expect(result.namedEndpoints[0]?.mode).toBe("local");
	});
});

describe("the local-dev air-gap", () => {
	it("refuses a local endpoint pointing at a remote backend", async () => {
		await expect(
			attach({
				mode: "local",
				endpoints: [
					endpoint({ backendUrl: "https://api.production.example.com" }),
				],
			}),
		).rejects.toThrow(/local-dev air-gap/u);
	});

	it("permits a loopback backend", async () => {
		await expect(attach({ mode: "local" })).resolves.toBeTruthy();
	});

	it("does not apply the check to a private overlay endpoint", async () => {
		await expect(
			attach({
				mode: "local",
				endpoints: [
					endpoint({
						external: false,
						backendUrl: "https://api.production.example.com",
					}),
				],
			}),
		).resolves.toBeTruthy();
	});
});

describe("service discovery", () => {
	it("publishes the backend URL as preferred without portless", async () => {
		const result = await attach({ forcePortless: OFF });
		expect(result.serviceDiscovery.WEB_URL).toBe("http://127.0.0.1:3000");
	});

	it("prefers the named URL when portless is running", async () => {
		const result = await attach({ forcePortless: ON });
		expect(result.serviceDiscovery.WEB_URL).toBe(result.namedEndpoints[0]?.url);
	});

	it("always publishes the named URL under a companion key", async () => {
		const result = await attach({ forcePortless: OFF });
		expect(result.serviceDiscovery.WEB_URL__named).toBe(
			result.namedEndpoints[0]?.url,
		);
	});

	it("writes both keys into the supplied environment", async () => {
		const processEnv: NodeJS.ProcessEnv = {};
		await attach({ processEnv });
		expect(processEnv.WEB_URL).toBeTruthy();
		expect(processEnv.WEB_URL__named).toBeTruthy();
	});

	it("writes an uppercase HOBO_NAMED_ variable per resource", async () => {
		const processEnv: NodeJS.ProcessEnv = {};
		await attach({ processEnv });
		expect(processEnv.HOBO_NAMED_WEB_URL).toBeTruthy();
	});
});

describe("resolvePreferredUrl", () => {
	it("returns the backend URL without portless", async () => {
		const result = await attach({ forcePortless: OFF });
		expect(result.resolvePreferredUrl("web")).toBe("http://127.0.0.1:3000");
	});

	it("returns the named URL with portless", async () => {
		const result = await attach({ forcePortless: ON });
		expect(result.resolvePreferredUrl("web")).toBe(
			result.namedEndpoints[0]?.url,
		);
	});

	it("returns the backend URL for a private endpoint even with portless", async () => {
		const result = await attach({
			endpoints: [endpoint({ external: false })],
			forcePortless: ON,
		});
		expect(result.resolvePreferredUrl("web")).toBe("http://127.0.0.1:3000");
	});

	it("returns undefined for an unknown resource", async () => {
		const result = await attach();
		expect(result.resolvePreferredUrl("nope")).toBeUndefined();
	});
});

describe("the primary URL", () => {
	it("prefers an external endpoint over a private one", async () => {
		const result = await attach({
			endpoints: [
				endpoint({
					resourceName: "worker",
					external: false,
					serviceDiscoveryKey: "W",
				}),
				endpoint({
					resourceName: "web",
					external: true,
					serviceDiscoveryKey: "WEB_URL",
				}),
			],
		});
		expect(result.primaryNamedUrl).toBe(
			result.namedEndpoints.find((e) => e.external)?.url,
		);
	});

	it("falls back to the first endpoint when none is external", async () => {
		const result = await attach({
			endpoints: [endpoint({ external: false })],
		});
		expect(result.primaryNamedUrl).toBe(result.namedEndpoints[0]?.url);
	});
});

describe("the session registry", () => {
	it("registers the session under its id", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await attachNamedEndpoints({
			app: "myapp",
			endpoints: [endpoint()],
			processEnv: {},
			forcePortless: OFF,
			sessionId: "registry-test",
		} as never);
		expect(getNamedEndpointSession("registry-test")).toBe(result);
		await result.close();
	});

	it("returns null for an unknown session", () => {
		expect(getNamedEndpointSession("never-created")).toBeNull();
	});

	it("lists sessions with their endpoint counts", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await attachNamedEndpoints({
			app: "myapp",
			endpoints: [endpoint()],
			processEnv: {},
			forcePortless: OFF,
			sessionId: "list-test",
		} as never);
		const listed = listNamedEndpointSessions().find(
			(s) => s.sessionId === "list-test",
		);
		expect(listed?.count).toBe(1);
		await result.close();
	});

	it("removes the session on close", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await attachNamedEndpoints({
			app: "myapp",
			endpoints: [endpoint()],
			processEnv: {},
			forcePortless: OFF,
			sessionId: "close-test",
		} as never);
		await result.close();
		expect(getNamedEndpointSession("close-test")).toBeNull();
	});
});

describe("close", () => {
	it("removes the variables it set", async () => {
		const processEnv: NodeJS.ProcessEnv = {};
		const result = await attach({ processEnv });
		await result.close();
		expect(processEnv.WEB_URL).toBeUndefined();
		expect(processEnv.WEB_URL__named).toBeUndefined();
		expect(processEnv.HOBO_NAMED_WEB_URL).toBeUndefined();
	});

	it("leaves a variable another writer has since changed", async () => {
		const processEnv: NodeJS.ProcessEnv = {};
		const result = await attach({ processEnv });
		processEnv.WEB_URL = "http://someone-else";
		await result.close();
		expect(processEnv.WEB_URL).toBe("http://someone-else");
	});

	it("is safe on a session with no endpoints", async () => {
		const result = await attach({ endpoints: [] });
		await expect(result.close()).resolves.toBeUndefined();
	});
});

describe("metering", () => {
	it("emits a register event per endpoint", async () => {
		const events: { eventType: string }[] = [];
		await attach({ metering: { emit: (e: never) => void events.push(e) } });
		expect(events.map((e) => e.eventType)).toEqual(["named_endpoint.register"]);
	});

	it("emits an unregister event per endpoint on close", async () => {
		const events: { eventType: string }[] = [];
		const result = await attach({
			metering: { emit: (e: never) => void events.push(e) },
		});
		await result.close();
		expect(events.map((e) => e.eventType)).toEqual([
			"named_endpoint.register",
			"named_endpoint.unregister",
		]);
	});

	it("works with no metering bus at all", async () => {
		await expect(attach({ metering: undefined })).resolves.toBeTruthy();
	});
});

describe("progress reporting", () => {
	it("announces the primary URL", async () => {
		const lines: string[] = [];
		await attach({ emitProgress: (m: string) => lines.push(m) });
		expect(lines.join("\n")).toContain("primary");
	});

	it("relays a portless hint when there is one", async () => {
		const lines: string[] = [];
		await attach({
			// SAFETY: assertion required at this I/O or test boundary.
			forcePortless: { enabled: false, hint: "install portless" } as never,
			emitProgress: (m: string) => lines.push(m),
		});
		expect(lines.join("\n")).toContain("install portless");
	});

	it("works with no progress callback", async () => {
		await expect(attach({ emitProgress: undefined })).resolves.toBeTruthy();
	});
});

describe("createNamedPreferringBindingResolver", () => {
	it.each([
		"url",
		"http",
		"baseUrl",
	])("resolves the %s property to the preferred URL", async (property) => {
		const named = await attach({ forcePortless: OFF });
		const resolver = createNamedPreferringBindingResolver({ named });
		// SAFETY: assertion required at this I/O or test boundary.
		const resolved = await resolver.resolve("web" as never, property);
		expect(resolved.value).toBe("http://127.0.0.1:3000");
	});

	it("labels the source service-discovery when the backend URL won", async () => {
		const named = await attach({ forcePortless: OFF });
		const resolver = createNamedPreferringBindingResolver({ named });
		// SAFETY: assertion required at this I/O or test boundary.
		expect((await resolver.resolve("web" as never, "url")).source).toBe(
			"service-discovery",
		);
	});

	it("labels the source named when portless fronts the endpoint", async () => {
		const named = await attach({ forcePortless: ON });
		const resolver = createNamedPreferringBindingResolver({ named });
		// SAFETY: assertion required at this I/O or test boundary.
		expect((await resolver.resolve("web" as never, "url")).source).toBe(
			"named",
		);
	});

	it("delegates an unknown property to the fallback", async () => {
		const named = await attach();
		const resolver = createNamedPreferringBindingResolver({
			named,
			fallback: {
				async resolve() {
					// SAFETY: assertion required at this I/O or test boundary.
					return { value: "from-fallback", source: "fallback" as never };
				},
			},
		});
		// SAFETY: assertion required at this I/O or test boundary.
		expect((await resolver.resolve("web" as never, "port")).value).toBe(
			"from-fallback",
		);
	});

	it("delegates an unknown resource to the fallback", async () => {
		const named = await attach();
		const resolver = createNamedPreferringBindingResolver({
			named,
			fallback: {
				async resolve() {
					// SAFETY: assertion required at this I/O or test boundary.
					return { value: "from-fallback", source: "fallback" as never };
				},
			},
		});
		// SAFETY: assertion required at this I/O or test boundary.
		expect((await resolver.resolve("other" as never, "url")).value).toBe(
			"from-fallback",
		);
	});

	it("throws a named error when nothing can resolve it", async () => {
		const named = await attach();
		const resolver = createNamedPreferringBindingResolver({ named });
		// SAFETY: assertion required at this I/O or test boundary.
		await expect(resolver.resolve("other" as never, "url")).rejects.toThrow(
			/no binding for other\.url/u,
		);
	});
});
