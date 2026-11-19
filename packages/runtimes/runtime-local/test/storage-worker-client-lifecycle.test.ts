import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { StorageWorkerClient } from "../dist/eventstore/worker-client.js";

const directories: string[] = [];
const clients: StorageWorkerClient[] = [];
const workers: Worker[] = [];
const append = {
	expectedSeq: 0,
	actor: { kind: "service" as const, id: "test" },
	tenant: "tenant",
};

function client() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-storage-worker-"));
	directories.push(directory);
	const store = new StorageWorkerClient({
		dbPath: join(directory, "events.sqlite"),
	});
	clients.push(store);
	return { store, directory };
}

function workerFor(store: StorageWorkerClient) {
	// oxlint-disable-next-line anti-slop/no-reflect-get
	const worker: unknown = Reflect.get(store, "worker");
	if (!(worker instanceof Worker)) throw new Error("worker not started");
	workers.push(worker);
	return worker;
}

afterEach(async () => {
	await Promise.allSettled(
		workers.splice(0).map((worker) => worker.terminate()),
	);
	await Promise.allSettled(clients.splice(0).map((store) => store.close()));
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

it("persists ordinary JSON objects containing bigint-like keys without changing them", async () => {
	const { store, directory } = client();
	const data = { $bigint: "42" };
	const appended = await store.append(
		"orders",
		[{ type: "order.Created", data }],
		append,
	);
	expect(appended.appended[0]?.data).toEqual(data);
	expect((await store.read("orders"))[0]?.data).toEqual(data);
	expect((await store.snapshot("orders", data, 1)).state).toEqual(data);
	expect((await store.loadSnapshot("orders"))?.state).toEqual(data);
	const all = await store.readAll();
	expect(all[0]).toMatchObject({
		position: expect.any(BigInt),
		event: { data },
	});
	await store.close();
	expect((await store.read("orders"))[0]?.data).toEqual(data);
	await store.close();
	await store.close();
	const reopened = new StorageWorkerClient({
		dbPath: join(directory, "events.sqlite"),
	});
	clients.push(reopened);
	expect((await reopened.read("orders"))[0]?.data).toEqual(data);
});

it("commits events and effects through the real storage worker", async () => {
	const { store } = client();
	const committed = await store.commit({
		streamId: "orders",
		events: [{ type: "order.Created", data: { sku: "one" } }],
		append,
		effects: [
			{
				kind: "queue",
				queueName: "orders",
				idempotencyKey: "q1",
				body: { sku: "one" },
			},
		],
	});
	expect(committed.appended).toHaveLength(1);
	expect(committed.effects).toHaveLength(1);
	await expect(
		store.append("orders", [{ type: "order.Created" }], append),
	).rejects.toMatchObject({ code: "OPTIMISTIC_SEQUENCE_CONFLICT" });
	expect((await store.read("orders"))[0]?.data).toEqual({ sku: "one" });
});

it("reports startup failures to every caller and starts a replacement after recovery", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-storage-worker-"));
	directories.push(directory);
	const databasePath = join(directory, "events.sqlite");
	mkdirSync(databasePath);
	const store = new StorageWorkerClient({ dbPath: databasePath });
	clients.push(store);
	const results = await Promise.allSettled([
		store.read("first"),
		store.read("second"),
	]);
	expect(results.map((result) => result.status)).toEqual([
		"rejected",
		"rejected",
	]);
	rmSync(databasePath, { recursive: true });
	await expect(store.read("orders")).resolves.toEqual([]);
});

it("rejects pending requests when a worker exits successfully", async () => {
	const { store } = client();
	const pending = store.read("orders");
	const worker = workerFor(store);
	worker.emit("exit", 0);
	await expect(pending).rejects.toMatchObject({
		code: "STORAGE_WORKER_TERMINATED",
	});
	await expect(store.read("orders")).resolves.toEqual([]);
});

it("keeps a replacement worker when the previous worker exits after its error", async () => {
	const { store } = client();
	const first = store.read("orders");
	const previous = workerFor(store);
	previous.emit("error", new Error("worker stopped"));
	await expect(first).rejects.toThrow("worker stopped");
	const next = store.read("orders");
	workerFor(store);
	previous.emit("exit", 1);
	await expect(next).resolves.toEqual([]);
});

it("does not terminate a replacement worker while an older worker closes", async () => {
	const { store } = client();
	await store.read("orders");
	const previous = workerFor(store);
	const closing = store.close();
	previous.emit("error", new Error("worker stopped"));
	const next = store.read("orders");
	workerFor(store);
	await expect(closing).resolves.toBeUndefined();
	await expect(next).resolves.toEqual([]);
});

it("rejects a response for a different operation and remains usable", async () => {
	const { store } = client();
	const pending = store.read("orders");
	const worker = workerFor(store);
	worker.emit("message", {
		id: "req-1",
		ok: true,
		op: "snapshot",
		result: null,
	});
	await expect(pending).rejects.toThrow("replied to read with snapshot");
	await expect(store.read("orders")).resolves.toEqual([]);
});

it("does not retain a request that cannot be sent to the worker", async () => {
	const { store } = client();
	const uncloneable = { execute: () => undefined };
	// @ts-expect-error
	await expect(store.snapshot("orders", uncloneable, 0)).rejects.toThrow();
	// oxlint-disable-next-line anti-slop/no-reflect-get
	const pending: unknown = Reflect.get(store, "pending");
	if (!(pending instanceof Map)) throw new Error("pending requests missing");
	expect(pending.size).toBe(0);
	await expect(store.read("orders")).resolves.toEqual([]);
});
