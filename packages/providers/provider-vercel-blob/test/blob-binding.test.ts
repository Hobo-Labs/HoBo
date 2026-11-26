/**
 * Behaviour the conformance suite does not reach: the record format and the
 * pathname encoding, refusal classification, lost replies, contention limits,
 * a concurrent `expire` under a compare-and-set, lazy expiry, foreign blobs,
 * and the purge.
 */
import {
	parseEphemeralKey,
	parseEphemeralTtlMs,
	parseEphemeralVersion,
} from "@hobo/core";
import {
	createManualClock,
	KvRedisCompatibleError,
} from "@hobo/kv-redis-compatible";
import {
	BlobAccessError,
	BlobError,
	BlobPreconditionFailedError,
	BlobServiceRateLimited,
	BlobUnknownError,
} from "@vercel/blob";
import { describe, expect, it } from "vitest";

import {
	blobPathname,
	classifyBlobWriteError,
	createMemoryBlobSdk,
	createVercelBlobEphemeralState,
	type MemoryBlobSdkOptions,
	parseStoredRecord,
	parseVercelBlobNamespace,
	purgeExpiredBlobs,
	VERCEL_BLOB_RECORD_FORMAT,
	VercelBlobContentionError,
	type VercelBlobSdk,
} from "../src/index.js";

const key = parseEphemeralKey;
const ttl = parseEphemeralTtlMs(60_000);
const START = 1_800_000_000_000;

function setup(options: MemoryBlobSdkOptions = {}) {
	const clock = createManualClock(START);
	const sdk = createMemoryBlobSdk({ now: clock.now, ...options });
	let ids = 0;
	const port = createVercelBlobEphemeralState({
		sdk,
		now: clock.now,
		newIncarnation: () => `inc-${++ids}`,
		newWriteId: () => `w-${++ids}`,
		retry: { sleep: async () => {} },
	});
	return { clock, sdk, port };
}

describe("storage layout", () => {
	it("keeps one protobuf-JSON record per key under the namespace", async () => {
		const { sdk, port } = setup();
		const write = await port.putIfAbsent(key("ring:{feed}:e:7"), "café", ttl);
		expect(write).toEqual({ applied: true, version: "inc-1:1" });
		const pathname = blobPathname(
			parseVercelBlobNamespace("hobo-ephemeral"),
			key("ring:{feed}:e:7"),
		);
		expect(pathname).toBe("hobo-ephemeral/cmluZzp7ZmVlZH06ZTo3");
		const stored = sdk.blobs().get(pathname);
		expect(JSON.parse(stored?.body ?? "")).toEqual({
			format: VERCEL_BLOB_RECORD_FORMAT,
			value: "café",
			incarnation: "inc-1",
			revision: "1",
			expiresAtMs: String(START + 60_000),
			writeId: "w-2",
		});
	});

	it("encodes the longest key under the longest namespace within Blob's pathname limit", () => {
		const longest = key("~".repeat(512));
		const namespace = parseVercelBlobNamespace(`a${"/b".repeat(99)}c`);
		const pathname = blobPathname(namespace, longest);
		expect(pathname.length).toBeLessThanOrEqual(950);
		expect(pathname).toMatch(/^[a-z0-9_/-]+\/[A-Za-z0-9_-]+$/u);
		expect(pathname).not.toContain("//");
	});

	it("refuses namespaces Blob would mangle", () => {
		for (const bad of [
			"",
			"Upper",
			"a//b",
			"/a",
			"a/",
			"a b",
			"x".repeat(201),
		]) {
			expect(() => parseVercelBlobNamespace(bad), bad).toThrow(RangeError);
		}
	});

	it("rejects a foreign blob under the namespace instead of overwriting it", async () => {
		const { sdk, port } = setup();
		sdk.seed(
			blobPathname(parseVercelBlobNamespace("hobo-ephemeral"), key("x")),
			"{}",
		);
		await expect(port.get(key("x"))).rejects.toMatchObject({
			code: "EPHEMERAL_BACKEND_CONTRACT",
		});
		await expect(port.putIfAbsent(key("x"), "v", ttl)).rejects.toBeInstanceOf(
			KvRedisCompatibleError,
		);
		expect(() => parseStoredRecord("not json")).toThrow(KvRedisCompatibleError);
	});
});

describe("refusal classification", () => {
	it("tells a refused write from a failure", () => {
		expect(classifyBlobWriteError(new BlobPreconditionFailedError())).toBe(
			"precondition-failed",
		);
		expect(
			classifyBlobWriteError(
				new BlobError("This blob already exists, use `allowOverwrite: true`"),
			),
		).toBe("refused");
		// Unclassified: treated as a refusal, which the binding confirms by reading.
		expect(classifyBlobWriteError(new BlobUnknownError())).toBe("refused");
		expect(classifyBlobWriteError(new BlobAccessError())).toBeUndefined();
		expect(
			classifyBlobWriteError(new BlobServiceRateLimited(3)),
		).toBeUndefined();
		expect(classifyBlobWriteError(new Error("socket hang up"))).toBeUndefined();
	});

	it("propagates a failure that is not a refusal", async () => {
		const { sdk, port } = setup();
		const denied = createVercelBlobEphemeralState({
			sdk: {
				...sdk,
				put: () => Promise.reject(new BlobAccessError()),
			},
		});
		await expect(denied.putIfAbsent(key("k"), "v", ttl)).rejects.toBeInstanceOf(
			BlobAccessError,
		);
		await expect(port.get(key("k"))).resolves.toBeUndefined();
	});
});

describe("lost replies", () => {
	it("recognises its own landed write when the SDK's retry is refused", async () => {
		const { port } = setup({ loseReplyWhen: (method) => method === "put" });
		const created = await port.putIfAbsent(key("k"), "a", ttl);
		expect(created).toEqual({ applied: true, version: "inc-1:1" });
		if (!created.applied) return;
		expect(
			await port.compareAndSet(key("k"), created.version, "b", ttl),
		).toEqual({
			applied: true,
			version: "inc-1:2",
		});
		expect(await port.increment(key("n"), 5, ttl)).toBe(5);
		expect(await port.increment(key("n"), 5, ttl)).toBe(10);
		expect(await port.expire(key("n"), ttl)).toBe(true);
		expect((await port.get(key("n")))?.value).toBe("10");
	});

	it("reports a delete whose reply was lost as not removed", async () => {
		const { port } = setup({ loseReplyWhen: (method) => method === "del" });
		await port.putIfAbsent(key("k"), "a", ttl);
		expect(await port.delete(key("k"))).toBe(false);
		expect(await port.get(key("k"))).toBeUndefined();
	});
});

describe("contention", () => {
	/** An SDK whose every conditional write loses to another writer first. */
	type Contested = { readonly sdk: VercelBlobSdk; readonly now: () => number };

	function alwaysLoses(): Contested {
		const clock = createManualClock(START);
		const inner = createMemoryBlobSdk({ now: clock.now });
		const rival = createVercelBlobEphemeralState({
			sdk: inner,
			now: clock.now,
		});
		return {
			now: clock.now,
			sdk: {
				...inner,
				async put(pathname, body, options) {
					if (options.ifMatch !== undefined) {
						await rival.increment(key("hot"), 100, ttl);
					}
					return inner.put(pathname, body, options);
				},
			},
		};
	}

	it("gives up after maxAttempts and applies nothing", async () => {
		const { sdk, now } = alwaysLoses();
		const port = createVercelBlobEphemeralState({
			sdk,
			now,
			retry: { maxAttempts: 3, sleep: async () => {} },
		});
		await port.increment(key("hot"), 1, ttl);
		await expect(port.increment(key("hot"), 1, ttl)).rejects.toBeInstanceOf(
			VercelBlobContentionError,
		);
		// 1, then three rival bumps of 100; none of the second call's writes landed.
		expect((await port.get(key("hot")))?.value).toBe("301");
	});

	it("backs off with jitter between rounds, doubling to the cap", async () => {
		const { sdk, now } = alwaysLoses();
		const waits: number[] = [];
		const port = createVercelBlobEphemeralState({
			sdk,
			now,
			retry: {
				maxAttempts: 6,
				baseDelayMs: 10,
				maxDelayMs: 40,
				random: () => 0.5,
				sleep: async (ms) => {
					waits.push(ms);
				},
			},
		});
		await port.increment(key("hot"), 1, ttl);
		await expect(port.increment(key("hot"), 1, ttl)).rejects.toThrow(
			/gave up after 6/u,
		);
		expect(waits).toEqual([5, 10, 20, 20, 20]);
	});

	it("retries a compare-and-set that lost only to an expire, which keeps the version", async () => {
		const clock = createManualClock(START);
		const inner = createMemoryBlobSdk({ now: clock.now });
		const other = createVercelBlobEphemeralState({
			sdk: inner,
			now: clock.now,
		});
		let interfered = false;
		const port = createVercelBlobEphemeralState({
			now: clock.now,
			retry: { sleep: async () => {} },
			sdk: {
				...inner,
				async put(pathname, body, options) {
					if (options.ifMatch !== undefined && !interfered) {
						interfered = true;
						await other.expire(key("lease"), parseEphemeralTtlMs(120_000));
					}
					return inner.put(pathname, body, options);
				},
			},
		});
		const created = await port.putIfAbsent(key("lease"), "a", ttl);
		if (!created.applied) throw new Error("setup");
		const moved = await port.compareAndSet(
			key("lease"),
			created.version,
			"b",
			ttl,
		);
		expect(interfered).toBe(true);
		expect(moved.applied).toBe(true);
		expect((await port.get(key("lease")))?.value).toBe("b");
	});

	it("does not retry a compare-and-set whose version moved", async () => {
		const { port } = setup();
		const created = await port.putIfAbsent(key("k"), "a", ttl);
		if (!created.applied) throw new Error("setup");
		await port.compareAndSet(key("k"), created.version, "b", ttl);
		expect(
			await port.compareAndSet(
				key("k"),
				parseEphemeralVersion("inc-1:1"),
				"c",
				ttl,
			),
		).toEqual({ applied: false });
	});
});

describe("lazy expiry", () => {
	it("replaces an expired blob in place with a new incarnation", async () => {
		const { clock, sdk, port } = setup();
		const first = await port.putIfAbsent(key("k"), "old", ttl);
		clock.advance(ttl);
		expect(await port.get(key("k"))).toBeUndefined();
		expect(sdk.blobs().size).toBe(1);
		const second = await port.putIfAbsent(key("k"), "new", ttl);
		expect(first).toEqual({ applied: true, version: "inc-1:1" });
		// The refused create drew inc-3 (and w-4); the replace draws inc-5.
		expect(second).toEqual({ applied: true, version: "inc-5:1" });
		expect(sdk.blobs().size).toBe(1);
	});

	it("restarts an expired counter and deletes an expired key without reporting it", async () => {
		const { clock, sdk, port } = setup();
		await port.increment(key("n"), 7, ttl);
		await port.putIfAbsent(key("gone"), "x", ttl);
		clock.advance(ttl);
		expect(await port.increment(key("n"), 1, ttl)).toBe(1);
		expect(await port.delete(key("gone"))).toBe(false);
		expect([...sdk.blobs().keys()]).toHaveLength(1);
	});
});

describe("purge", () => {
	const namespace = parseVercelBlobNamespace("hobo-ephemeral");

	it("deletes long-dead blobs unread, reads younger ones within budget, keeps live ones", async () => {
		const { clock, sdk, port } = setup();
		await port.putIfAbsent(key("live"), "x", parseEphemeralTtlMs(10 * ttl));
		await port.putIfAbsent(key("expired-1"), "x", ttl);
		await port.putIfAbsent(key("expired-2"), "x", ttl);
		const ancient = sdk.seed(
			blobPathname(namespace, key("ancient")),
			"never read",
			START - 31 * 24 * 60 * 60 * 1000,
		);
		sdk.seed("other-namespace/x", "{}");
		clock.advance(ttl);

		const first = await purgeExpiredBlobs({ sdk, now: clock.now, maxReads: 1 });
		expect(first).toMatchObject({ listed: 4, read: 1, cursor: undefined });
		expect(first.deleted).toBeGreaterThanOrEqual(1);
		expect(sdk.blobs().has(blobPathname(namespace, key("ancient")))).toBe(
			false,
		);
		expect(ancient.body).toBe("never read");

		const second = await purgeExpiredBlobs({ sdk, now: clock.now });
		expect(first.deleted + second.deleted).toBe(3);
		expect([...sdk.blobs().keys()].sort()).toEqual([
			blobPathname(namespace, key("live")),
			"other-namespace/x",
		]);
	});

	it("pages with a cursor", async () => {
		const { clock, sdk, port } = setup();
		for (const name of ["a", "b", "c"])
			await port.putIfAbsent(key(name), "x", ttl);
		clock.advance(ttl);
		const page = await purgeExpiredBlobs({ sdk, now: clock.now, pageSize: 2 });
		expect(page).toMatchObject({ listed: 2, deleted: 2 });
		const cursor = page.cursor;
		if (cursor === undefined) throw new Error("expected a cursor");
		const rest = await purgeExpiredBlobs({
			sdk,
			now: clock.now,
			pageSize: 2,
			cursor,
		});
		expect(rest).toEqual({ listed: 1, read: 1, deleted: 1, cursor: undefined });
	});

	it("leaves a blob rewritten after it was read", async () => {
		const clock = createManualClock(START);
		const inner = createMemoryBlobSdk({ now: clock.now });
		const port = createVercelBlobEphemeralState({ sdk: inner, now: clock.now });
		await port.putIfAbsent(key("k"), "x", ttl);
		clock.advance(ttl);
		const result = await purgeExpiredBlobs({
			now: clock.now,
			sdk: {
				...inner,
				async del(pathname, options) {
					await port.putIfAbsent(key("k"), "fresh", ttl);
					return inner.del(pathname, options);
				},
			},
		});
		expect(result.deleted).toBe(0);
		expect((await port.get(key("k")))?.value).toBe("fresh");
	});
});
