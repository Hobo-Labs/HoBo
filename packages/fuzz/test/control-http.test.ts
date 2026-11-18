import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createControlFuzzServer } from "../src/control-http.js";
import { hasPrototypePollution } from "../src/manifest.js";
import { assertLocalSchema, runSchemathesis } from "../src/schemathesis.js";

it("serves a private control model and preserves tenant and method boundaries", async () => {
	const server = await createControlFuzzServer();
	const request = (path: string, init?: RequestInit) =>
		fetch(server.url + path, init);
	const name = "app-name";
	const tenant = "tenant-a";
	const headers = {
		"content-type": "application/json",
		"x-hobo-tenant": tenant,
	};
	try {
		const created = await request("/v1/bindles", {
			method: "POST",
			headers,
			body: JSON.stringify({ bindleId: name, manifestHash: "hash" }),
		});
		expect(created.status).toBe(200);
		const applied = await request("/v1/bindles/" + "%61pp-name" + "/apply", {
			method: "POST",
			headers,
			body: JSON.stringify({ idempotencyKey: "once" }),
		});
		expect(applied.status).toBe(200);
		const repeated = await request("/v1/bindles/" + "%61pp-name" + "/apply", {
			method: "POST",
			headers,
			body: JSON.stringify({ idempotencyKey: "once" }),
		});
		expect(await applied.json()).toEqual(await repeated.json());
		const denied = await request("/v1/tenants/tenant-a/resources", {
			headers: { "x-hobo-tenant": "tenant-b" },
		});
		expect(denied.status).toBe(403);
		const unsupportedMethod = await request("/v1/bindles");
		expect(unsupportedMethod.status).toBe(405);
		expect(unsupportedMethod.headers.get("allow")).toBe("POST");
		expect(
			(await request("/v1/bindles/%C3%97/destroy", { method: "POST", headers }))
				.status,
		).toBe(400);
		expect(
			(await request("/v1/bindles", { method: "POST", headers, body: "{" }))
				.status,
		).toBe(400);
		expect(
			(
				await request("/v1/bindles", {
					method: "POST",
					headers,
					body: JSON.stringify({
						bindleId: "x",
						manifestHash: "hash",
						extra: true,
					}),
				})
			).status,
		).toBe(400);
		expect(
			(
				await request("/v1/bindles", {
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: "{}",
				})
			).status,
		).toBe(415);
		expect(
			(
				await request("/v1/bindles", {
					method: "POST",
					headers,
					body: "a".repeat(65_537),
				})
			).status,
		).toBe(413);
		expect(server.requests()).toBe(10);
		expect(server.operations()).toEqual([
			"applyBindle",
			"createBindle",
			"destroyBindle",
			"listResources",
		]);
	} finally {
		await server.close();
	}
});

it("checks deeply nested input without overflowing the call stack", () => {
	const depth = 20_000;
	const prefix = "[".repeat(depth);
	const suffix = "]".repeat(depth);
	expect(hasPrototypePollution(JSON.parse(prefix + "0" + suffix))).toBe(false);
	expect(
		hasPrototypePollution(JSON.parse(prefix + '{"__proto__":{}}' + suffix)),
	).toBe(true);
});

it("rejects external schema locations at every depth", () => {
	expect(() =>
		assertLocalSchema({
			paths: { "/v1": { $ref: "#/components/schemas/Item" } },
		}),
	).not.toThrow();
	expect(() =>
		assertLocalSchema({
			paths: { "/v1": { $ref: "https://example.com/api.json" } },
		}),
	).toThrow();
	expect(() =>
		assertLocalSchema({ paths: { "/v1": { $ref: "../other.json" } } }),
	).toThrow();
	expect(() =>
		assertLocalSchema({ paths: {}, servers: [{ url: "http://example.com" }] }),
	).toThrow();
	expect(() =>
		assertLocalSchema({ info: { description: "http://example.com" } }),
	).toThrow();
});

it("reports an unavailable Schemathesis executable without sending a request", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-missing-schemathesis-"));
	try {
		expect(
			await runSchemathesis({ binary: join(directory, "schemathesis") }),
		).toEqual({ ran: false, reason: "schemathesis executable unavailable" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([
	{ seconds: 0 },
	{ seconds: 61 },
	{ seed: -1 },
	{ seed: Number.NaN },
])("rejects invalid tool limits", async (options) => {
	await expect(runSchemathesis(options)).rejects.toThrow();
});
