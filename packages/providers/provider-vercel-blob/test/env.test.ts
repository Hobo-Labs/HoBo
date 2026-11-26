/**
 * The environment helper: which names it reads, what it reports, that the
 * store id reaches every SDK call, and that no value ever appears in what it
 * returns or throws besides the store id itself (an identifier, not a secret).
 */
import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";

import {
	createMemoryBlobSdk,
	createVercelBlobEphemeralStateFromEnv,
	resolveVercelBlobEnv,
	VERCEL_BLOB_ENV_NAMES,
	type VercelBlobSdk,
	type VercelBlobStoreOptions,
} from "../src/index.js";

const OIDC = "eyJhbGciOiJSUzI1NiJ9.oidc-sentinel-value.sig";
const RW = "vercel_blob_rw_abc_rw-sentinel-value";

describe("resolveVercelBlobEnv", () => {
	it("is undefined without a store id, even with tokens present", () => {
		expect(
			resolveVercelBlobEnv({
				VERCEL_OIDC_TOKEN: OIDC,
				BLOB_READ_WRITE_TOKEN: RW,
			}),
		).toBeUndefined();
		expect(resolveVercelBlobEnv({ BLOB_STORE_ID: "  " })).toBeUndefined();
	});

	it("reports names and presence, never a token", () => {
		const resolved = resolveVercelBlobEnv({
			BLOB_STORE_ID: "store_AbC123",
			VERCEL_OIDC_TOKEN: OIDC,
			BLOB_READ_WRITE_TOKEN: RW,
		});
		expect(resolved).toEqual({
			source: {
				storeIdVariable: "BLOB_STORE_ID",
				oidcTokenInEnv: true,
				readWriteTokenPresent: true,
			},
			storeId: "store_AbC123",
		});
		expect(JSON.stringify(resolved)).not.toMatch(/sentinel/u);
		expect(resolveVercelBlobEnv({ BLOB_STORE_ID: "AbC123" })?.source).toEqual({
			storeIdVariable: "BLOB_STORE_ID",
			oidcTokenInEnv: false,
			readWriteTokenPresent: false,
		});
	});

	it("reads a prefixed store id for a store connected with a custom prefix", () => {
		expect(
			resolveVercelBlobEnv(
				{ RELAY_BLOB_STORE_ID: "abc" },
				{ prefix: "RELAY_" },
			),
		).toMatchObject({
			storeId: "abc",
			source: { storeIdVariable: "RELAY_BLOB_STORE_ID" },
		});
	});

	it("refuses a malformed store id by name, without echoing it", () => {
		const attempt = () =>
			resolveVercelBlobEnv({ BLOB_STORE_ID: "store_bad value/sentinel" });
		expect(attempt).toThrow(KvRedisCompatibleError);
		expect(attempt).toThrow(/BLOB_STORE_ID/u);
		expect(attempt).not.toThrow(/sentinel/u);
	});

	it("names the variables it reads", () => {
		expect(VERCEL_BLOB_ENV_NAMES).toEqual({
			storeId: "BLOB_STORE_ID",
			oidcToken: "VERCEL_OIDC_TOKEN",
			readWriteToken: "BLOB_READ_WRITE_TOKEN",
		});
	});
});

describe("createVercelBlobEphemeralStateFromEnv", () => {
	it("passes the store id to every SDK call and never a token", async () => {
		const seen: VercelBlobStoreOptions[] = [];
		const memory = createMemoryBlobSdk();
		const sdk: VercelBlobSdk = {
			put: (pathname, body, options) => {
				seen.push(options);
				return memory.put(pathname, body, options);
			},
			get: (pathname, options) => {
				seen.push(options);
				return memory.get(pathname, options);
			},
			del: (pathname, options) => {
				seen.push(options);
				return memory.del(pathname, options);
			},
			list: (options) => {
				seen.push(options);
				return memory.list(options);
			},
		};
		const bound = createVercelBlobEphemeralStateFromEnv({
			env: { BLOB_STORE_ID: "store_relay", VERCEL_OIDC_TOKEN: OIDC },
			sdk,
		});
		if (bound === undefined) throw new Error("not bound");
		const key = parseEphemeralKey("lease:1");
		const ttl = parseEphemeralTtlMs(1_000);
		await bound.port.putIfAbsent(key, "x", ttl);
		await bound.port.increment(parseEphemeralKey("n"), 1, ttl);
		await bound.port.delete(key);
		expect(seen.length).toBeGreaterThan(0);
		for (const options of seen) {
			expect(options.storeId).toBe("store_relay");
			expect(JSON.stringify(options)).not.toMatch(/sentinel|token/iu);
		}
	});

	it("is undefined when no store is connected", () => {
		expect(createVercelBlobEphemeralStateFromEnv({ env: {} })).toBeUndefined();
	});
});
