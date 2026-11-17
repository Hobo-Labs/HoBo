import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";

import { createTailscaleApiClient } from "../../src/overlay/tailscale-api.js";

type Call = { url: string; init: RequestInit };

function transport(
	script: Record<
		string,
		{ status?: number; body?: unknown; text?: string } | undefined
	>,
) {
	const calls: Call[] = [];
	const impl = (async (url: string | URL, init: RequestInit = {}) => {
		const href = String(url);
		calls.push({ url: href, init });
		const method = String(init.method ?? "GET");
		const key =
			Object.keys(script).find((k) => {
				const [m, suffix] = k.split(" ");
				return m === method && href.includes(String(suffix));
			}) ?? "";
		const entry = script[key] ?? { status: 200, body: {} };
		const status = entry.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => entry.body ?? {},
			text: async () => entry.text ?? "",
		} as Response;
	}) as typeof fetch;
	return { impl, calls };
}

const client = (
	script: Parameters<typeof transport>[0] = {},
	options: JsonObject = {},
) => {
	const { impl, calls } = transport(script);
	return {
		calls,
		api: createTailscaleApiClient({
			apiKey: "tskey-secret",
			fetchImpl: impl,
			...options,
		}),
	};
};

describe("client construction", () => {
	it("defaults the tailnet to the token's own", () => {
		expect(client().api.tailnet).toBe("-");
	});

	it("uses an explicit tailnet", () => {
		expect(client({}, { tailnet: "example.com" }).api.tailnet).toBe(
			"example.com",
		);
	});

	it("addresses the public API by default", async () => {
		const { api, calls } = client();
		await api.getDnsPreferences();
		expect(calls[0]?.url).toContain("https://api.tailscale.com/api/v2");
	});

	it("honours a self-hosted base", async () => {
		const { api, calls } = client(
			{},
			{ apiBase: "https://headscale.internal" },
		);
		await api.getDnsPreferences();
		expect(calls[0]?.url).toContain("https://headscale.internal/tailnet");
	});

	it("tolerates a trailing slash on the base rather than doubling it", async () => {
		const { api, calls } = client(
			{},
			{ apiBase: "https://headscale.internal/" },
		);
		await api.getDnsPreferences();
		expect(calls[0]?.url).not.toContain("//tailnet");
	});

	it("percent-encodes the tailnet in the path", async () => {
		const { api, calls } = client({}, { tailnet: "a b/c" });
		await api.getDnsPreferences();
		expect(calls[0]?.url).toContain("a%20b%2Fc");
	});
});

describe("authentication", () => {
	it("sends the key as a bearer token", async () => {
		const { api, calls } = client();
		await api.getDnsPreferences();
		const call = calls[0];
		if (call === undefined) throw new Error("expected a request");
		const headers = call.init.headers;
		if (!headers || headers instanceof Headers || Array.isArray(headers)) {
			throw new Error("expected header object");
		}
		expect(headers.authorization).toBe("Bearer tskey-secret");
	});

	it("asks for JSON on every call", async () => {
		const { api, calls } = client();
		await api.listDevices();
		const call = calls[0];
		if (call === undefined) throw new Error("expected a request");
		const headers = call.init.headers;
		if (!headers || headers instanceof Headers || Array.isArray(headers)) {
			throw new Error("expected header object");
		}
		expect(headers.accept).toBe("application/json");
	});

	it("declares a JSON content type only when it sends a body", async () => {
		const { api, calls } = client();
		await api.getDnsPreferences();
		const getCall = calls[0];
		if (getCall === undefined) throw new Error("expected a GET");
		const getHeaders = getCall.init.headers;
		if (
			!getHeaders ||
			getHeaders instanceof Headers ||
			Array.isArray(getHeaders)
		) {
			throw new Error("expected header object");
		}
		expect(getHeaders["content-type"]).toBeUndefined();
		await api.setDnsPreferences({ magicDNS: true });
		const putCall = calls[1];
		if (putCall === undefined) throw new Error("expected a PUT");
		const putHeaders = putCall.init.headers;
		if (
			!putHeaders ||
			putHeaders instanceof Headers ||
			Array.isArray(putHeaders)
		) {
			throw new Error("expected header object");
		}
		expect(putHeaders["content-type"]).toBe("application/json");
	});

	it("sends no body at all on a read", async () => {
		const { api, calls } = client();
		await api.getDnsPreferences();
		expect(calls[0]?.init.body).toBeUndefined();
	});

	it("keeps the key out of the failure message", async () => {
		const { api } = client({ "GET dns/preferences": { status: 401 } });
		await expect(api.getDnsPreferences()).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining("tskey-secret"),
			}),
		);
	});
});

describe("API failures", () => {
	it("names the method, path and status", async () => {
		const { api } = client({ "GET dns/preferences": { status: 403 } });
		await expect(api.getDnsPreferences()).rejects.toThrow(
			/tailscale api GET .*dns\/preferences failed \(403\)/u,
		);
	});

	it("includes the provider's own explanation", async () => {
		const { api } = client({
			"GET devices": { status: 400, text: "invalid tailnet" },
		});
		await expect(api.listDevices()).rejects.toThrow(/invalid tailnet/u);
	});

	it("bounds the body it quotes", async () => {
		const { api } = client({
			"GET devices": { status: 500, text: "x".repeat(5000) },
		});
		const error = await api.listDevices().catch((error: Error) => error);
		expect(error.message.length).toBeLessThan(500);
	});

	it("still fails usefully when the body cannot be read", async () => {
		const impl = (async () =>
			({
				ok: false,
				status: 502,
				text: async () => {
					throw new Error("stream closed");
				},
				json: async () => ({}),
			}) as Response) as typeof fetch;
		const api = createTailscaleApiClient({ apiKey: "k", fetchImpl: impl });
		await expect(api.listDevices()).rejects.toThrow(/502/u);
	});
});

describe("split DNS", () => {
	it("reads the tailnet's map", async () => {
		const { api } = client({
			"GET split-dns": { body: { "hobo.internal": ["100.64.0.1"] } },
		});
		expect(await api.getSplitDns()).toEqual({
			"hobo.internal": ["100.64.0.1"],
		});
	});

	it("drops an entry whose nameservers are not a list", async () => {
		const { api } = client({
			"GET split-dns": { body: { good: ["100.64.0.1"], bad: "100.64.0.2" } },
		});
		expect(await api.getSplitDns()).toEqual({ good: ["100.64.0.1"] });
	});

	it("copies the nameserver list rather than aliasing the response", async () => {
		const body = { "hobo.internal": ["100.64.0.1"] };
		const { api } = client({ "GET split-dns": { body } });
		const map = await api.getSplitDns();
		body["hobo.internal"].push("100.64.0.9");
		expect(map["hobo.internal"]).toHaveLength(1);
	});

	it("returns an empty map rather than throwing on an empty tailnet", async () => {
		const { api } = client({ "GET split-dns": { body: {} } });
		expect(await api.getSplitDns()).toEqual({});
	});

	it("merges into the existing map instead of replacing it", async () => {
		const { api, calls } = client({
			"GET split-dns": { body: { "other.internal": ["100.64.0.9"] } },
			"PATCH split-dns": { body: { patched: ["1.1.1.1"] } },
		});
		await api.putSplitDns(["hobo.internal"], ["100.64.0.1"]);
		const patched = JSON.parse(String(calls[1]?.init.body));
		expect(patched["other.internal"]).toEqual(["100.64.0.9"]);
		expect(patched["hobo.internal"]).toEqual(["100.64.0.1"]);
	});

	it("overwrites a domain it already owns rather than appending", async () => {
		const { api, calls } = client({
			"GET split-dns": { body: { "hobo.internal": ["100.64.0.1"] } },
			"PATCH split-dns": { body: { ok: ["1"] } },
		});
		await api.putSplitDns(["hobo.internal"], ["100.64.0.2"]);
		expect(JSON.parse(String(calls[1]?.init.body))["hobo.internal"]).toEqual([
			"100.64.0.2",
		]);
	});

	it("writes several domains in one call", async () => {
		const { api, calls } = client({
			"GET split-dns": { body: {} },
			"PATCH split-dns": { body: { ok: ["1"] } },
		});
		await api.putSplitDns(["a.internal", "b.internal"], ["100.64.0.1"]);
		expect(Object.keys(JSON.parse(String(calls[1]?.init.body)))).toEqual([
			"a.internal",
			"b.internal",
		]);
	});

	it("keys a domain exactly as written, dot and all", async () => {
		const { api, calls } = client({
			"GET split-dns": { body: {} },
			"PATCH split-dns": { body: { ok: ["1"] } },
		});
		await api.putSplitDns([".hobo.internal"], ["100.64.0.1"]);
		expect(
			JSON.parse(String(calls[1]?.init.body))[".hobo.internal"],
		).toBeDefined();
	});

	it("returns the map the PATCH answered with", async () => {
		const { api } = client({
			"GET split-dns": { body: {} },
			"PATCH split-dns": { body: { "hobo.internal": ["100.64.0.1"] } },
		});
		expect(await api.putSplitDns(["hobo.internal"], ["100.64.0.1"])).toEqual({
			"hobo.internal": ["100.64.0.1"],
		});
	});

	it("falls back to a full PUT when the PATCH answers empty", async () => {
		const { api, calls } = client({
			"GET split-dns": { body: { "hobo.internal": ["100.64.0.1"] } },
			"PATCH split-dns": { body: {} },
			"PUT split-dns": { body: {} },
		});
		await api.putSplitDns(["hobo.internal"], ["100.64.0.1"]);
		expect(calls.map((c) => c.init.method)).toEqual([
			"GET",
			"PATCH",
			"PUT",
			"GET",
		]);
	});

	it("re-reads the live map after the fallback rather than guessing", async () => {
		const { api } = client({
			"GET split-dns": { body: { "hobo.internal": ["100.64.0.1"] } },
			"PATCH split-dns": { body: {} },
			"PUT split-dns": { body: {} },
		});
		expect(await api.putSplitDns(["hobo.internal"], ["100.64.0.1"])).toEqual({
			"hobo.internal": ["100.64.0.1"],
		});
	});
});

describe("DNS preferences", () => {
	it("reads the tailnet's preferences", async () => {
		const { api } = client({
			"GET dns/preferences": { body: { magicDNS: true } },
		});
		expect(await api.getDnsPreferences()).toEqual({ magicDNS: true });
	});

	it("reports empty preferences rather than null", async () => {
		const { api } = client({ "GET dns/preferences": { body: null } });
		expect(await api.getDnsPreferences()).toEqual({});
	});

	it("sends the preferences it was given", async () => {
		const { api, calls } = client({
			"POST dns/preferences": { body: { magicDNS: true } },
		});
		await api.setDnsPreferences({ magicDNS: true, overrideLocalDNS: false });
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			magicDNS: true,
			overrideLocalDNS: false,
		});
	});

	it("returns what the API confirmed, not what was asked for", async () => {
		const { api } = client({
			"POST dns/preferences": { body: { magicDNS: false } },
		});
		expect(await api.setDnsPreferences({ magicDNS: true })).toEqual({
			magicDNS: false,
		});
	});

	it("falls back to the requested preferences when the API answers nothing", async () => {
		const { api } = client({ "POST dns/preferences": { body: null } });
		expect(await api.setDnsPreferences({ magicDNS: true })).toEqual({
			magicDNS: true,
		});
	});

	it("treats a 204 as an empty answer rather than parsing no body", async () => {
		const { api } = client({ "POST dns/preferences": { status: 204 } });
		expect(await api.setDnsPreferences({ magicDNS: true })).toEqual({
			magicDNS: true,
		});
	});
});

describe("devices", () => {
	it("lists the tailnet's devices", async () => {
		const { api } = client({
			"GET devices": {
				body: {
					devices: [{ id: "d1", name: "yard-1", addresses: ["100.64.0.1"] }],
				},
			},
		});
		expect(await api.listDevices()).toEqual([
			{ id: "d1", name: "yard-1", addresses: ["100.64.0.1"] },
		]);
	});

	it("returns an empty list for a tailnet with no devices", async () => {
		const { api } = client({ "GET devices": { body: {} } });
		expect(await api.listDevices()).toEqual([]);
	});

	it("falls back to the hostname when a device has no name", async () => {
		const { api } = client({
			"GET devices": { body: { devices: [{ id: "d1", hostname: "host-1" }] } },
		});
		expect((await api.listDevices())[0]?.name).toBe("host-1");
	});

	it("prefers the name over the hostname when both are present", async () => {
		const { api } = client({
			"GET devices": {
				body: { devices: [{ id: "d1", name: "n", hostname: "h" }] },
			},
		});
		expect((await api.listDevices())[0]?.name).toBe("n");
	});

	it("reports empty strings rather than undefined for a nameless device", async () => {
		const { api } = client({ "GET devices": { body: { devices: [{}] } } });
		expect((await api.listDevices())[0]).toMatchObject({
			id: "",
			name: "",
			addresses: [],
		});
	});

	it("omits tags entirely when a device has none", async () => {
		const { api } = client({
			"GET devices": { body: { devices: [{ id: "d1" }] } },
		});
		expect((await api.listDevices())[0]).not.toHaveProperty("tags");
	});

	it("keeps the tags a device carries", async () => {
		const { api } = client({
			"GET devices": {
				body: { devices: [{ id: "d1", tags: ["tag:yard"] }] },
			},
		});
		expect((await api.listDevices())[0]?.tags).toEqual(["tag:yard"]);
	});
});
