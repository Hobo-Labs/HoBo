/**
 * Opening each kind of cache member, offline: the Upstash REST client over a
 * stand-in `fetch`, the libSQL client before it has made a call, and every
 * refusal naming the variable rather than its value.
 */
import { parseEphemeralKey } from "@hobo/core";
import { createMemoryBlobSdk } from "@hobo/provider-vercel-blob";
import { describe, expect, it, vi } from "vitest";
import {
	CacheBindingError,
	discoverCacheBackends,
	onVercel,
	openCacheBackend,
	openCacheBackends,
} from "../src/cache-backend.js";

const REST_URL = "https://relay-cache-12345.upstash.io";
const TOKEN = "AXyz-secret-token-value";
const TURSO_URL = "libsql://relay-cache-hobo.turso.io";
const TURSO_TOKEN = "turso-secret-token";

describe("opening cache members", () => {
	it("meters an Upstash REST member in commands, through the fetch it is given", async () => {
		const env = {
			UPSTASH_REDIS_REST_URL: REST_URL,
			UPSTASH_REDIS_REST_TOKEN: TOKEN,
		};
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			Response.json({ result: [null, null, null] }),
		);
		const [binding] = discoverCacheBackends(env).members;
		if (!binding) throw new Error("no member");
		const upstash = await openCacheBackend(binding, env, { fetch: fetchImpl });
		expect(upstash.units).toEqual(["commands"]);
		expect(upstash.usage()).toEqual({ commands: 0 });
		await expect(
			upstash.state.get(parseEphemeralKey("k")),
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalled();
		expect(upstash.usage()).toEqual({ commands: 1 });
		await upstash.close();
	});

	it("refuses to open an Upstash member whose pair has gone, naming the variable", async () => {
		await expect(
			openCacheBackend(
				{
					id: "upstash",
					kind: "upstash-rest",
					names: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
				},
				{},
			),
		).rejects.toThrow(new CacheBindingError("KV_REST_API_URL is not set"));
	});

	it("refuses to open a Redis-protocol member whose URL has gone", async () => {
		await expect(
			openCacheBackend({ id: "valkey", kind: "redis-protocol", names: [] }, {}),
		).rejects.toThrow(/VALKEY_URL is not set/u);
	});

	it("meters a libSQL member in rows read and written, and closes it", async () => {
		const env = {
			TURSO_DATABASE_URL: TURSO_URL,
			TURSO_AUTH_TOKEN: TURSO_TOKEN,
		};
		const [binding] = discoverCacheBackends(env).members;
		if (!binding) throw new Error("no member");
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("offline");
		});
		const turso = await openCacheBackend(binding, env, { fetch: fetchImpl });
		expect(turso.units).toEqual(["rows-read", "rows-written"]);
		expect(turso.usage()).toEqual({ "rows-read": 0, "rows-written": 0 });
		await turso.close();
	});

	it("refuses a libSQL or Blob member whose binding the provider rejects, naming the variable only", async () => {
		await expect(
			openCacheBackend(
				{
					id: "turso",
					kind: "libsql",
					names: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
				},
				{},
			),
		).rejects.toThrow(CacheBindingError);
		await expect(
			openCacheBackend(
				{
					id: "turso",
					kind: "libsql",
					names: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
				},
				{
					TURSO_DATABASE_URL: "https://user:secret@host.example",
					TURSO_AUTH_TOKEN: TURSO_TOKEN,
				},
			),
		).rejects.toThrow(
			new CacheBindingError(
				"TURSO_DATABASE_URL is not a libsql: or https: URL without embedded credentials",
			),
		);
		await expect(
			openCacheBackend(
				{ id: "blob", kind: "vercel-blob", names: ["BLOB_STORE_ID"] },
				{},
			),
		).rejects.toThrow(CacheBindingError);
	});

	it("closes the members already opened when a later one fails to open", async () => {
		const env = {
			UPSTASH_REDIS_REST_URL: REST_URL,
			UPSTASH_REDIS_REST_TOKEN: TOKEN,
		};
		const upstash = discoverCacheBackends(env).members;
		await expect(
			openCacheBackends(
				{
					members: [
						...upstash,
						{ id: "valkey", kind: "redis-protocol", names: ["VALKEY_URL"] },
					],
					candidates: [],
				},
				env,
				{ fetch: vi.fn<typeof fetch>() },
			),
		).rejects.toThrow(/VALKEY_URL is not set/u);
	});

	it("opens a Redis-protocol member without connecting, and closes the in-memory and Blob members", async () => {
		const env = { VALKEY_URL: "redis://127.0.0.1:1" };
		const [binding] = discoverCacheBackends(env).members;
		if (!binding) throw new Error("no member");
		const valkey = await openCacheBackend(binding, env);
		expect(valkey.units).toEqual(["commands"]);
		expect(valkey.usage()).toEqual({ commands: 0 });
		await valkey.close();
		const [memory] = await openCacheBackends(discoverCacheBackends({}), {});
		await expect(memory?.close()).resolves.toBeUndefined();
		const blob = await openCacheBackend(
			{ id: "blob", kind: "vercel-blob", names: ["BLOB_STORE_ID"] },
			{ BLOB_STORE_ID: "store_abc123" },
			{ blobSdk: createMemoryBlobSdk() },
		);
		await expect(blob.close()).resolves.toBeUndefined();
	});

	it("knows Vercel only by production and preview", () => {
		expect(onVercel({ VERCEL_ENV: "production" })).toBe(true);
		expect(onVercel({ VERCEL_ENV: "preview" })).toBe(true);
		expect(onVercel({ VERCEL_ENV: "development" })).toBe(false);
		expect(onVercel({})).toBe(false);
	});
});
