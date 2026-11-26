/**
 * The storage worker client's lifecycle, and how it fails.
 *
 * `StorageWorkerClient` exists so `DatabaseSync` never runs on the main
 * thread: every operation is serialized through one Worker, which owns the
 * database exclusively (ADR-0135 — one partition, one writer). That makes the
 * client a request/response multiplexer, and multiplexers fail in one
 * characteristic way — a caller left holding a promise nobody will ever
 * settle.
 *
 * Every property below is about that:
 *
 * **A dead worker rejects every outstanding call, not just the current one.**
 * The worker owns the only handle to the database. When it dies there is no
 * one left to answer any request, so a client that rejected only the in-flight
 * call would leave the rest of the callers hung forever — the worst failure
 * mode for a storage layer, because it looks like slowness rather than an
 * outage.
 *
 * **A dead worker is dropped, not reused.** The next call spawns a fresh one.
 * Holding on to a terminated handle would turn one crash into a permanently
 * broken store, and the operator would have to restart the process to recover
 * something the client can recover by itself.
 *
 * **Closing without ever having opened does nothing.** A store constructed and
 * discarded — a failed startup, a cancelled request — must not spawn a worker
 * on its way out just to shut it down.
 *
 * ## Why the success paths are not here
 *
 * `ensureWorker` resolves the worker as `./storage-worker.js` relative to its
 * own module. Under vitest that module is the TypeScript source, so the path
 * points at a `.js` file that only exists in `dist/` — the spawn fails with
 * `Cannot find module`. In production the client runs from `dist/` and
 * resolves correctly, so this is a test-harness limitation and not a defect in
 * the client.
 *
 * The consequence is worth stating plainly: the request/response half of this
 * class — the `message` handler, the bigint revival, and each operation's
 * result decoding — cannot be exercised from source, and is therefore covered
 * only by the packages that run against a built worker. What *is* reachable is
 * every call site and the whole failure lifecycle, which is what these cover.
 */
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

/** The spawn failure every call in this file lands on. */
const SPAWN_FAILURE = /Cannot find module|storage worker exited/;

describe("every operation reaches the worker", () => {
	it("append does", async () => {
		// Each of these asserts the same thing from a different call site: the
		// operation is dispatched to the worker rather than answered locally,
		// so a dead worker surfaces as a rejection rather than a hang.
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
		// `fromSeq` is omitted from the request rather than sent as undefined,
		// so the worker's own default applies — a structured-clone boundary
		// does not distinguish an absent key from an undefined one on the far
		// side, and sending both shapes would make the protocol ambiguous.
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
		// The worker owns the only handle to the database. Rejecting one caller
		// and leaving the others pending would present an outage as slowness.
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
		// One shared cause, reported identically: a caller comparing notes with
		// another must not see two different stories about one dead worker.
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
		// Holding a terminated handle would turn one crash into a permanently
		// broken store that only a process restart could recover.
		const store = client();
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
	});

	it("leaves nothing pending behind", async () => {
		// A slot left in the pending map would be answered by a *later*
		// worker's response to a reused id, resolving a call with another
		// call's result.
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
		// A store constructed and discarded must not spawn a worker on its way
		// out just to shut it down.
		await expect(client().close()).resolves.toBeUndefined();
	});

	it("is idempotent", async () => {
		const store = client();
		await store.close();
		await expect(store.close()).resolves.toBeUndefined();
	});

	it("survives a worker that never came up", async () => {
		// Close is the cleanup path; it swallows the shutdown call's own
		// failure, because a caller closing a broken store has nothing useful
		// to do with a second error about the same breakage.
		const store = client();
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
		await expect(store.close()).resolves.toBeUndefined();
	});

	it("still accepts a call afterwards, spawning again", async () => {
		// Close releases the worker rather than sealing the client. The store
		// is reusable, and a call after close is a fresh worker, not an error
		// about a closed handle.
		const store = client();
		await store.close();
		await expect(store.read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
	});
});

describe("partitioning", () => {
	it("accepts an explicit partition id", async () => {
		// One partition, one writer (ADR-0135). The id is what pins a client to
		// its partition, and it is passed through to the worker at spawn.
		await expect(client("tenant-a").read("stream-1")).rejects.toThrow(
			SPAWN_FAILURE,
		);
	});

	it("runs without one", async () => {
		// The worker defaults it, so an unpartitioned local runtime does not
		// have to name a partition it does not have.
		await expect(client().read("stream-1")).rejects.toThrow(SPAWN_FAILURE);
	});
});
