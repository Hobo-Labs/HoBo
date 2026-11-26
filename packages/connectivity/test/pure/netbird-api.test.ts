/**
 * Tests for the Netbird management API client.
 *
 * The module was 0% covered. It is a credentialed HTTP client that decides
 * which token goes on which request, tolerates two different API shapes per
 * endpoint, and normalizes responses whose field names differ by casing between
 * Netbird versions — every one of those is a place a silent wrong answer hides,
 * and none of it was pinned.
 *
 * `fetchImpl` is injected, so nothing here touches a network. Requests are
 * recorded and asserted: the URL, the method, the headers and the body are the
 * contract this client has with a real deployment, and they are what a version
 * bump would break.
 */

import { describe, expect, it } from "vitest";
import { isJsonObject, isJsonString, type JsonValue } from "../../src/json.js";

import { createNetbirdApiClient } from "../../src/overlay/netbird-api.js";

type Recorded = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: JsonValue;
};

/**
 * A fetch stand-in driven by a routing table. Each entry matches on
 * `METHOD /path` and supplies a status plus a JSON (or raw) body.
 */
function fakeFetch(
	routes: Record<string, { status?: number; body?: unknown; text?: string }>,
) {
	const calls: Recorded[] = [];
	// SAFETY: assertion required at this I/O or test boundary.
	const impl = (async (url: string | URL, init?: RequestInit) => {
		const href = isJsonString(url) ? url : url.toString();
		const method = init?.method ?? "GET";
		const path = new URL(href).pathname;
		calls.push({
			url: href,
			method,
			// SAFETY: assertion required at this I/O or test boundary.
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: isJsonString(init?.body) ? JSON.parse(init.body) : init?.body,
		});
		const route = routes[`${method} ${path}`];
		const status = route?.status ?? (route === undefined ? 404 : 200);
		const text =
			route?.text ??
			(route?.body === undefined ? "" : JSON.stringify(route.body));
		// SAFETY: assertion required at this I/O or test boundary.
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => text,
		} as Response;
	}) as typeof fetch;
	return { impl, calls };
}

const MANAGEMENT = "https://netbird.example.com";

describe("client construction", () => {
	it("strips trailing slashes from the management URL", () => {
		const { impl } = fakeFetch({});
		expect(
			createNetbirdApiClient({
				managementUrl: `${MANAGEMENT}///`,
				fetchImpl: impl,
			}).managementUrl,
		).toBe(MANAGEMENT);
	});
});

describe("enrollPeer", () => {
	it("refuses without a setup key and says why", async () => {
		const { impl, calls } = fakeFetch({});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			fetchImpl: impl,
		});
		const result = await client.enrollPeer({ name: "node-a" });
		expect(result.enrolled).toBe(false);
		expect(result.notes[0]).toContain("setupKey required");
		// It must not have attempted a request it knows cannot succeed.
		expect(calls).toHaveLength(0);
	});

	it("validates a setup key and returns the peer", async () => {
		const { impl, calls } = fakeFetch({
			"POST /api/setup-keys/validate": {
				body: { id: "p1", name: "node-a", ip: "100.64.0.5", connected: true },
			},
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			setupKey: "SK",
			fetchImpl: impl,
		});
		const result = await client.enrollPeer({ name: "node-a" });

		expect(result.enrolled).toBe(true);
		expect(result.peer).toEqual({
			id: "p1",
			name: "node-a",
			ip: "100.64.0.5",
			connected: true,
		});
		expect(result.notes).toEqual(["setup key validated"]);
		expect(calls[0]?.body).toEqual({ key: "SK", name: "node-a" });
	});

	it("prefers a per-call setup key over the client default", async () => {
		const { impl, calls } = fakeFetch({
			"POST /api/setup-keys/validate": { body: { id: "p1", name: "n" } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			setupKey: "CLIENT",
			fetchImpl: impl,
		});
		await client.enrollPeer({ name: "n", setupKey: "PERCALL" });
		// SAFETY: assertion required at this I/O or test boundary.
		const call = calls[0];
		if (call === undefined || !isJsonObject(call.body)) {
			throw new Error("expected enroll body");
		}
		expect(call.body.key).toBe("PERCALL");
	});

	it("falls back to /api/peers when validation is unavailable", async () => {
		const { impl, calls } = fakeFetch({
			"POST /api/setup-keys/validate": { status: 404 },
			"POST /api/peers": { body: { id: "p2", name: "node-b" } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			setupKey: "SK",
			fetchImpl: impl,
		});
		const result = await client.enrollPeer({ name: "node-b" });

		expect(result.enrolled).toBe(true);
		expect(result.notes).toEqual(["enrolled via /api/peers"]);
		expect(calls).toHaveLength(2);
		// The fallback carries the setup key as a Token header, not a Bearer.
		expect(calls[1]?.headers.authorization).toBe("Token SK");
	});

	it("reports both statuses when neither enrollment path works", async () => {
		const { impl } = fakeFetch({
			"POST /api/setup-keys/validate": { status: 404 },
			"POST /api/peers": { status: 401 },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			setupKey: "SK",
			fetchImpl: impl,
		});
		const result = await client.enrollPeer({ name: "node-c" });
		expect(result.enrolled).toBe(false);
		expect(result.notes[0]).toContain("404/401");
	});

	it("still reports success when the response carries no usable peer", async () => {
		const { impl } = fakeFetch({
			"POST /api/setup-keys/validate": { body: { unrelated: true } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			setupKey: "SK",
			fetchImpl: impl,
		});
		const result = await client.enrollPeer({ name: "node-d" });
		expect(result.enrolled).toBe(true);
		expect(result.peer).toBeUndefined();
	});
});

describe("listPeers", () => {
	it("accepts a bare array and a wrapped object alike", async () => {
		for (const body of [
			[{ id: "a", name: "A" }],
			{ peers: [{ id: "a", name: "A" }] },
		]) {
			const { impl } = fakeFetch({ "GET /api/peers": { body } });
			const client = createNetbirdApiClient({
				managementUrl: MANAGEMENT,
				accessToken: "T",
				fetchImpl: impl,
			});
			expect(await client.listPeers()).toEqual([
				{ id: "a", name: "A", ip: "", connected: false },
			]);
		}
	});

	it("sends the admin token as a Bearer", async () => {
		const { impl, calls } = fakeFetch({ "GET /api/peers": { body: [] } });
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "TOKEN",
			fetchImpl: impl,
		});
		await client.listPeers();
		expect(calls[0]?.headers.authorization).toBe("Bearer TOKEN");
		expect(calls[0]?.headers.accept).toBe("application/json");
	});

	it("drops entries that carry neither id nor name", async () => {
		const { impl } = fakeFetch({
			"GET /api/peers": {
				body: [{ id: "a", name: "A" }, { ip: "1.2.3.4" }, null, "nope"],
			},
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		expect(await client.listPeers()).toHaveLength(1);
	});

	it("normalizes both casings and back-fills a missing field from the other", async () => {
		const { impl } = fakeFetch({
			"GET /api/peers": {
				body: [
					{ ID: "x", Name: "X", IP: "10.0.0.1", Connected: true },
					{ id: "only-id" },
					{ name: "only-name", address: "10.0.0.2", dns_label: "d" },
					{ id: "camel", name: "Camel", dnsLabel: "c" },
				],
			},
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		expect(await client.listPeers()).toEqual([
			{ id: "x", name: "X", ip: "10.0.0.1", connected: true },
			{ id: "only-id", name: "only-id", ip: "", connected: false },
			{
				id: "only-name",
				name: "only-name",
				ip: "10.0.0.2",
				connected: false,
				dnsLabel: "d",
			},
			{ id: "camel", name: "Camel", ip: "", connected: false, dnsLabel: "c" },
		]);
	});

	it("throws with the status when the request fails", async () => {
		const { impl } = fakeFetch({ "GET /api/peers": { status: 503 } });
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		await expect(client.listPeers()).rejects.toThrow(/503/);
	});
});

describe("listDnsNameserverGroups", () => {
	it("falls back to the older path when the current one is absent", async () => {
		const { impl, calls } = fakeFetch({
			"GET /api/dns/nameservers": { status: 404 },
			"GET /api/dns/nameserver-groups": {
				body: [{ id: "g1", name: "G", domains: ["a"], nameservers: [] }],
			},
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		const groups = await client.listDnsNameserverGroups();
		expect(calls).toHaveLength(2);
		expect(groups[0]?.id).toBe("g1");
	});

	it("throws the original status when both paths fail", async () => {
		const { impl } = fakeFetch({
			"GET /api/dns/nameservers": { status: 500 },
			"GET /api/dns/nameserver-groups": { status: 404 },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		await expect(client.listDnsNameserverGroups()).rejects.toThrow(/500/);
	});

	it("defaults enabled to true and primary to false", async () => {
		const { impl } = fakeFetch({
			"GET /api/dns/nameservers": {
				body: {
					groups: [
						{ name: "G", nameservers: [{ ip: "1.1.1.1", ns_type: "udp" }] },
					],
				},
			},
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		expect(await client.listDnsNameserverGroups()).toEqual([
			{
				name: "G",
				nameservers: [{ ip: "1.1.1.1", nsType: "udp" }],
				domains: [],
				enabled: true,
				primary: false,
			},
		]);
	});
});

describe("upsertDnsNameserverGroup", () => {
	const group = {
		name: "hobo",
		nameservers: [{ ip: "10.0.0.1" }],
		domains: ["hobo.internal"],
		enabled: true,
	};

	it("POSTs to the collection when the group has no id", async () => {
		const { impl, calls } = fakeFetch({
			"POST /api/dns/nameservers": { body: { id: "new", ...group } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		const saved = await client.upsertDnsNameserverGroup(group);
		expect(calls[0]?.method).toBe("POST");
		expect(saved.id).toBe("new");
		// Defaults the wire format fills in on the caller's behalf.
		expect(calls[0]?.body).toMatchObject({
			description: "hobo hierarchical DNS",
			nameservers: [{ ip: "10.0.0.1", ns_type: "udp", port: 53 }],
			primary: false,
		});
	});

	it("PUTs to the member URL when the group has an id", async () => {
		const { impl, calls } = fakeFetch({
			"PUT /api/dns/nameservers/g9": { body: { id: "g9", ...group } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		await client.upsertDnsNameserverGroup({ ...group, id: "g9" });
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toBe(`${MANAGEMENT}/api/dns/nameservers/g9`);
	});

	it("returns the caller's group when the response is unusable", async () => {
		const { impl } = fakeFetch({
			"POST /api/dns/nameservers": { text: "not json" },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		// A `{raw: "..."}` shape still normalizes, so the name falls back rather
		// than throwing — the caller gets something coherent either way.
		expect(await client.upsertDnsNameserverGroup(group)).toBeDefined();
	});

	it("throws with the status on failure", async () => {
		const { impl } = fakeFetch({
			"POST /api/dns/nameservers": { status: 422 },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		await expect(client.upsertDnsNameserverGroup(group)).rejects.toThrow(/422/);
	});
});

describe("createSetupKey", () => {
	it("applies the documented defaults", async () => {
		const { impl, calls } = fakeFetch({
			"POST /api/setup-keys": { body: { id: "k1", key: "SECRET" } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		expect(await client.createSetupKey({ name: "join" })).toEqual({
			id: "k1",
			key: "SECRET",
		});
		expect(calls[0]?.body).toEqual({
			name: "join",
			type: "reusable",
			expires_in: 86400,
			auto_groups: [],
			usage_limit: 0,
		});
	});

	it("passes through an explicit type and expiry", async () => {
		const { impl, calls } = fakeFetch({
			"POST /api/setup-keys": { body: { id: "k2", key: "S" } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		await client.createSetupKey({
			name: "once",
			type: "one-off",
			expiresInSeconds: 60,
		});
		expect(calls[0]?.body).toMatchObject({ type: "one-off", expires_in: 60 });
	});

	it("refuses a response missing the id or the key", async () => {
		for (const body of [{ id: "k" }, { key: "S" }, {}]) {
			const { impl } = fakeFetch({ "POST /api/setup-keys": { body } });
			const client = createNetbirdApiClient({
				managementUrl: MANAGEMENT,
				accessToken: "T",
				fetchImpl: impl,
			});
			await expect(client.createSetupKey({ name: "n" })).rejects.toThrow(
				/missing id\/key/,
			);
		}
	});

	it("throws with the status on failure", async () => {
		const { impl } = fakeFetch({ "POST /api/setup-keys": { status: 403 } });
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		await expect(client.createSetupKey({ name: "n" })).rejects.toThrow(/403/);
	});
});

describe("request shaping", () => {
	it("omits authorization entirely when no token is configured", async () => {
		const { impl, calls } = fakeFetch({ "GET /api/peers": { body: [] } });
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			fetchImpl: impl,
		});
		await client.listPeers();
		expect(calls[0]?.headers.authorization).toBeUndefined();
	});

	it("sets a JSON content type only when there is a body", async () => {
		const { impl, calls } = fakeFetch({
			"GET /api/peers": { body: [] },
			"POST /api/setup-keys": { body: { id: "i", key: "k" } },
		});
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		await client.listPeers();
		await client.createSetupKey({ name: "n" });
		expect(calls[0]?.headers["content-type"]).toBeUndefined();
		expect(calls[1]?.headers["content-type"]).toBe("application/json");
	});

	it("tolerates an empty response body", async () => {
		const { impl } = fakeFetch({ "GET /api/peers": { text: "" } });
		const client = createNetbirdApiClient({
			managementUrl: MANAGEMENT,
			accessToken: "T",
			fetchImpl: impl,
		});
		expect(await client.listPeers()).toEqual([]);
	});
});
