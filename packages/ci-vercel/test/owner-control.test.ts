import { createCiRelayClient } from "@hobo/ci-gh-actions/client";
import { describe, expect, it, vi } from "vitest";
import { createOwnerControlDelegation } from "../src/owner-control.js";

const origin = "https://relay.example";
function request(
	path: string,
	method = "GET",
	overrides: Record<string, string> = {},
) {
	const headers = new Headers({
		origin,
		"x-hobo-owner-control": "1",
	});
	if (method !== "GET") headers.set("content-type", "application/json");
	for (const [name, value] of Object.entries(overrides))
		headers.set(name, value);
	const init: RequestInit = {
		method,
		headers,
	};
	if (method !== "GET") init.body = "{}";
	return new Request(`${origin}${path}`, init);
}

describe("owner session control delegation", () => {
	it.each([
		["/v1/accounts/self/policy", "GET"],
		["/v1/accounts/self/installations", "GET"],
		["/v2/accounts/self/policy", "PUT"],
		["/v2/accounts/self/providers", "PUT"],
		["/v1/accounts/self/repositories/isolated-connect", "POST"],
	])("delegates verified owner access for %s %s", async (path, method) => {
		const resolve = vi.fn(async () => "server-side-token");
		const delegate = createOwnerControlDelegation({
			publicOrigin: origin,
			resolve,
		});
		const original = request(path, method);
		const delegated = await delegate(original);
		expect(delegated.headers.get("authorization")).toBe(
			"Bearer server-side-token",
		);
		expect(original.headers.has("authorization")).toBe(false);
		expect(resolve).toHaveBeenCalledOnce();
		if (method !== "GET") expect(await delegated.text()).toBe("{}");
	});
	it.each([
		["/v1/accounts/self/leases", "GET", {}],
		["/v1/accounts/self/repositories/prepare", "POST", {}],
		["/v1/accounts/self/repositories/isolated-connect/extra", "POST", {}],
		["/v1/accounts/self/policy", "POST", {}],
		["/v1/accounts/self/policy", "PUT", {}],
		["/v2/accounts/self/providers/extra", "PUT", {}],
		["/v2/accounts/self/providers", "POST", {}],
		[
			"/v2/accounts/self/providers",
			"PUT",
			{ origin: "https://attacker.example" },
		],
		["/v1/accounts/self/policy", "GET", { origin: "https://attacker.example" }],
		["/v1/accounts/self/policy", "GET", { "x-hobo-owner-control": "" }],
		["/v1/accounts/self/policy", "PUT", { "content-type": "text/plain" }],
		[
			"/v1/accounts/self/policy",
			"GET",
			{ authorization: "Bearer caller-token" },
		],
	])("does not delegate unauthorized or unrelated operation %s %s", async (path, method, headers) => {
		const resolve = vi.fn(async () => "server-side-token");
		const delegate = createOwnerControlDelegation({
			publicOrigin: origin,
			resolve,
		});
		const original = request(path, method, headers);
		expect(await delegate(original)).toBe(original);
		expect(resolve).not.toHaveBeenCalled();
	});
	it("does not delegate an unverified or expired owner session", async () => {
		const delegate = createOwnerControlDelegation({
			publicOrigin: origin,
			resolve: async () => undefined,
		});
		const original = request("/v1/accounts/self/policy");
		expect(await delegate(original)).toBe(original);
		expect(original.headers.has("authorization")).toBe(false);
	});
	it("supports same-origin browser GETs that omit Origin", async () => {
		const delegate = createOwnerControlDelegation({
			publicOrigin: origin,
			resolve: async () => "server-side-token",
		});
		const req = new Request(`${origin}/v1/accounts/self/policy`, {
			headers: { "sec-fetch-site": "same-origin", "x-hobo-owner-control": "1" },
		});
		expect((await delegate(req)).headers.get("authorization")).toBe(
			"Bearer server-side-token",
		);
	});
	it("lets the SDK use a browser owner session without exposing an account token", async () => {
		const resolve = vi.fn(async () => "server-side-token");
		const delegate = createOwnerControlDelegation({
			publicOrigin: origin,
			resolve,
		});
		const client = createCiRelayClient({
			origin,
			ownerSession: true,
			fetch: async (input, init) => {
				expect(init?.credentials).toBe("same-origin");
				const browserHeaders = new Headers(init?.headers);
				expect(browserHeaders.has("authorization")).toBe(false);
				browserHeaders.set("origin", origin);
				const req = await delegate(
					new Request(input, { ...init, headers: browserHeaders }),
				);
				expect(req.headers.get("authorization")).toBe(
					"Bearer server-side-token",
				);
				return Response.json({ revision: 1 });
			},
		});
		expect((await client.getPolicy()).revision).toBe(1);
		expect(resolve).toHaveBeenCalledOnce();
	});
	it("routes SDK provider updates through the verified owner session", async () => {
		const delegate = createOwnerControlDelegation({
			publicOrigin: origin,
			resolve: async () => "server-side-token",
		});
		const client = createCiRelayClient({
			origin,
			ownerSession: true,
			fetch: async (input, init) => {
				const headers = new Headers(init?.headers);
				expect(headers.has("authorization")).toBe(false);
				headers.set("origin", origin);
				const req = await delegate(new Request(input, { ...init, headers }));
				expect(new URL(req.url).pathname).toBe("/v2/accounts/self/providers");
				expect(req.method).toBe("PUT");
				expect(req.headers.get("if-match")).toBe('"4"');
				expect(req.headers.get("authorization")).toBe(
					"Bearer server-side-token",
				);
				return Response.json({ revision: 5 });
			},
		});
		expect(
			(await client.putProvider({ id: "sandbox-a" }, { revision: 4 })).revision,
		).toBe(5);
	});
});
