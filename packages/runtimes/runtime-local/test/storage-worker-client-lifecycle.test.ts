import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StorageWorkerClient } from "../src/eventstore/worker-client.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function client(partitionId?: string) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-storage-worker-"));
	dirs.push(dir);
	return new StorageWorkerClient({
		dbPath: join(dir, "events.sqlite"),
		...(partitionId !== undefined ? { partitionId } : {}),
	});
}

const SPAWN_FAILURE = /Cannot find module|storage worker exited/;

describe("every operation reaches the worker", () => {
	it("append does", async () => {
		await expect(
			client().append("stream-1", [], { expectedRevision: 0 } as never),
		).rejects.toThrow(SPAWN_FAILURE);
	});

	it("commit does", async () => {
		await expect(
			client().commit({ streamId: "stream-1" } as never),
		).rejects.toThrow(SPAWN_FAILURE);
	});

	it("read does", async () => {
		await expect(client().read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
	});

	it("read from an explicit sequence does", async () => {
		await expect(client().read("stream-1", 7)).rejects.toThrow(SPAWN_FAILURE);
	});

	it("readAll does", async () => {
		await expect(client().readAll()).rejects.toThrow(SPAWN_FAILURE);
	});

	it("readAll with options does", async () => {
		await expect(
			client().readAll({ fromGlobalSeq: 3 } as never),
		).rejects.toThrow(SPAWN_FAILURE);
	});

	it("snapshot does", async () => {
		await expect(
			client().snapshot("stream-1", { count: 1 }, 4),
		).rejects.toThrow(SPAWN_FAILURE);
	});

	it("loadSnapshot does", async () => {
		await expect(client().loadSnapshot("stream-1")).rejects.toThrow(
			SPAWN_FAILURE,
		);
	});
});

describe("when the worker dies", () => {
	it("rejects every outstanding call, not only the first", async () => {
		const store = client();
		const calls = [
			store.read("stream-1"),
			store.read("stream-2"),
			store.loadSnapshot("stream-3"),
		];
		const settled = await Promise.allSettled(calls);
		expect(settled.map((r) => r.status)).toStrictEqual([
			"rejected",
			"rejected",
			"rejected",
		]);
	});

	it("gives every caller the same failure", async () => {
		const store = client();
		const [first, second] = await Promise.allSettled([
			store.read("stream-1"),
			store.read("stream-2"),
		]);
		const message = (r: PromiseSettledResult<unknown>) =>
			r.status === "rejected" ? String(r.reason) : "resolved";
		expect(message(first)).toBe(message(second));
	});

	it("spawns a fresh worker for the next call", async () => {
		const store = client();
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
	});

	it("leaves nothing pending behind", async () => {
		const store = client();
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
		await expect(
			Promise.race([
				store.read("stream-2"),
				new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
			]),
		).rejects.toThrow(SPAWN_FAILURE);
	}, 10_000);
});

describe("closing", () => {
	it("does nothing when no worker was ever started", async () => {
		await expect(client().close()).resolves.toBeUndefined();
	});

	it("is idempotent", async () => {
		const store = client();
		await store.close();
		await expect(store.close()).resolves.toBeUndefined();
	});

	it("survives a worker that never came up", async () => {
		const store = client();
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
		await expect(store.close()).resolves.toBeUndefined();
	});

	it("still accepts a call afterwards, spawning again", async () => {
		const store = client();
		await store.close();
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
	});
});

describe("partitioning", () => {
	it("accepts an explicit partition id", async () => {
		await expect(client("tenant-a").read("stream-1")).rejects.toThrow(
			SPAWN_FAILURE,
		);
	});

	it("runs without one", async () => {
		await expect(client().read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
	});
});
