/**
 * What the pinned `@vercel/blob` 2.8.2 SDK puts on the wire for the options
 * the binding passes, and how it decodes the answers the binding depends on.
 * The binding's correctness rests on these mappings, so they are asserted
 * against the real SDK, not a stand-in: a version bump that changes one
 * fails here.
 */
import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import { createManualClock } from "@hobo/kv-redis-compatible";
import {
	BlobError,
	BlobPreconditionFailedError,
	del,
	get,
	put,
} from "@vercel/blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createVercelBlobEphemeralState } from "../src/index.js";
import {
	type BlobEmulator,
	startBlobEmulator,
} from "./fixtures/http-emulator.js";
import {
	EMULATOR_TOKEN,
	sdkOverHttp,
	useEmulatorEnv,
} from "./fixtures/sdk-over-http.js";

const key = parseEphemeralKey;
const ttl = parseEphemeralTtlMs(60_000);

describe("@vercel/blob 2.8.2 on the wire", () => {
	let emulator: BlobEmulator;
	let restore: () => void;
	const clock = createManualClock(1_800_000_000_000);

	beforeAll(async () => {
		emulator = await startBlobEmulator({ now: clock.now });
		restore = useEmulatorEnv(emulator.apiUrl);
	});
	afterAll(async () => {
		restore();
		await emulator.close();
	});

	const port = () =>
		createVercelBlobEphemeralState({
			sdk: sdkOverHttp(emulator.origin),
			storeId: "store_wire",
			namespace: "wire",
			now: clock.now,
			retry: { sleep: async () => {} },
		});

	const since = (start: number) => emulator.requests.slice(start);

	it("putIfAbsent: a create-only private upload", async () => {
		const start = emulator.requests.length;
		await port().putIfAbsent(key("create"), "v", ttl);
		const [upload] = since(start);
		expect(upload).toMatchObject({
			method: "PUT",
			path: "/api/blob/",
			query: { pathname: "wire/Y3JlYXRl" },
			headers: {
				"x-vercel-blob-access": "private",
				"x-allow-overwrite": "0",
				"x-add-random-suffix": "0",
				"x-content-type": "application/json",
				"x-cache-control-max-age": "60",
			},
		});
		expect(upload?.headers["x-if-match"]).toBeUndefined();
	});

	it("putIfAbsent on a live key: the refusal is decoded, then an origin read", async () => {
		const start = emulator.requests.length;
		expect(await port().putIfAbsent(key("create"), "w", ttl)).toEqual({
			applied: false,
		});
		const [upload, read] = since(start);
		expect(upload?.method).toBe("PUT");
		expect(read).toMatchObject({
			method: "GET",
			path: "/blob/wire/Y3JlYXRl",
			query: { cache: "0" },
		});
	});

	it("compareAndSet: an origin read, then an upload conditional on its ETag", async () => {
		const state = port();
		const created = await state.putIfAbsent(key("cas"), "a", ttl);
		if (!created.applied) throw new Error("setup");
		const etag = emulator.store.blobs().get("wire/Y2Fz")?.etag;
		const start = emulator.requests.length;
		await state.compareAndSet(key("cas"), created.version, "b", ttl);
		const [read, upload] = since(start);
		expect(read?.query).toEqual({ cache: "0" });
		expect(upload?.headers).toMatchObject({
			"x-if-match": etag,
			"x-allow-overwrite": "1",
			"x-vercel-blob-access": "private",
		});
	});

	it("delete: a conditional delete of the one pathname read", async () => {
		const state = port();
		await state.putIfAbsent(key("del"), "a", ttl);
		const etag = emulator.store.blobs().get("wire/ZGVs")?.etag;
		const start = emulator.requests.length;
		expect(await state.delete(key("del"))).toBe(true);
		const [, removal] = since(start);
		expect(removal).toMatchObject({
			method: "POST",
			path: "/api/blob/delete",
			headers: { "x-if-match": etag },
		});
		expect(JSON.parse(removal?.body ?? "")).toEqual({ urls: ["wire/ZGVs"] });
	});

	it("decodes precondition_failed as BlobPreconditionFailedError for put and del", async () => {
		const options = { access: "private", token: EMULATOR_TOKEN } as const;
		await put("raw/x", "1", options);
		await expect(
			put("raw/x", "2", { ...options, ifMatch: '"stale"' }),
		).rejects.toBeInstanceOf(BlobPreconditionFailedError);
		await expect(
			del("raw/x", { token: EMULATOR_TOKEN, ifMatch: '"stale"' }),
		).rejects.toBeInstanceOf(BlobPreconditionFailedError);
	});

	it("decodes the create-only refusal as a BlobError naming the existing blob", async () => {
		const options = { access: "private", token: EMULATOR_TOKEN } as const;
		await put("raw/y", "1", options);
		const refused = put("raw/y", "2", { ...options, allowOverwrite: false });
		await expect(refused).rejects.toBeInstanceOf(BlobError);
		await expect(refused).rejects.not.toBeInstanceOf(
			BlobPreconditionFailedError,
		);
		await expect(refused).rejects.toThrow(/already exists/u);
	});

	it("reads a missing blob as null and returns the ETag of a present one", async () => {
		const read = (pathname: string) =>
			get(`${emulator.origin}/blob/${pathname}`, {
				access: "private",
				useCache: false,
				token: EMULATOR_TOKEN,
			});
		expect(await read("raw/missing")).toBeNull();
		const present = await read("raw/x");
		expect(present?.blob.etag).toBe(emulator.store.blobs().get("raw/x")?.etag);
	});

	it("refuses ifMatch together with allowOverwrite: false before sending anything", async () => {
		const start = emulator.requests.length;
		await expect(
			put("raw/z", "1", {
				access: "private",
				token: EMULATOR_TOKEN,
				allowOverwrite: false,
				ifMatch: '"1"',
			}),
		).rejects.toThrow(/contradictory/u);
		expect(since(start)).toEqual([]);
	});
});
