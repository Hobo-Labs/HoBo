/* oxlint-disable anti-slop/no-object-parameters -- SAFETY: test requests intentionally exercise the untrusted HTTP boundary. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRivetAsyncQueueClient } from "../src/rivet-queue.js";
import {
	createRivetQueueActor,
	isRivetQueueBinding,
} from "../src/rivet-queue-runtime.js";

const open: DatabaseSync[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const database of open.splice(0)) database.close();
});
function fixture(path = ":memory:") {
	const sql = new DatabaseSync(path);
	open.push(sql);
	sql.exec(
		"CREATE TABLE IF NOT EXISTS hobo_queue_messages (idempotency_key TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, available_at INTEGER NOT NULL, requested_available_at INTEGER, state TEXT NOT NULL, lease_id TEXT, lease_expires_at INTEGER, attempt INTEGER NOT NULL, completed_lease_id TEXT); CREATE TABLE IF NOT EXISTS hobo_queue_clock (id INTEGER PRIMARY KEY CHECK(id=1), observed_at INTEGER NOT NULL)",
	);
	let now = 1000;
	let tail = Promise.resolve();
	const execute = async (query: string, ...args: unknown[]) =>
		sql.prepare(query).all(...args);
	const transaction = async <T>(
		run: (tx: RawAccess) => Promise<T>,
	): Promise<T> => {
		const before = tail;
		let release: () => void = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await before;
		sql.exec("BEGIN IMMEDIATE");
		try {
			// SAFETY: the transaction callback uses only the SQL execute member in this fixture.
			const value = await run({ execute } as RawAccess);
			sql.exec("COMMIT");
			return value;
		} catch (error) {
			sql.exec("ROLLBACK");
			throw error;
		} finally {
			release();
		}
	};
	// SAFETY: the actor under test uses only execute and transaction from this fixture.
	const database = { execute, transaction } as RawAccess;
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: () => now,
		authorize: ({ actorKey, headers }) =>
			actorKey[0] === "tenant-a" && headers.get("authorization") === "test",
	});
	const call = (
		path: string,
		body: object,
		actorKey = ["tenant-a"],
		authorization = "test",
	) =>
		binding.handle(
			{ name: "jobs", key: actorKey, db: database },
			new Request(`https://queue.test/${path}`, {
				method: "POST",
				headers: { authorization },
				body: JSON.stringify(body),
			}),
		);
	return {
		binding,
		database,
		call,
		advance: (ms: number) => {
			now += ms;
		},
		sql,
		close: () => {
			sql.close();
			const index = open.indexOf(sql);
			if (index >= 0) open.splice(index, 1);
		},
	};
}

describe("Rivet durable async queue actor", () => {
	it("creates a real RivetKit actor and authenticates before parsing input", async () => {
		const f = fixture();
		expect(isRivetQueueBinding(f.binding)).toBe(true);
		expect(
			(
				await f.call("enqueue", { idempotencyKey: "key", body: 1 }, [
					"tenant-b",
				])
			).status,
		).toBe(403);
		expect(
			(
				await f.call(
					"enqueue",
					{ idempotencyKey: "key", body: 1 },
					["tenant-a"],
					"forged",
				)
			).status,
		).toBe(403);
		expect(
			f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
		).toBe(0);
	});
	it("deduplicates concurrent retries permanently, including after completion", async () => {
		const f = fixture();
		const values = await Promise.all(
			Array.from({ length: 12 }, () =>
				f
					.call("enqueue", { idempotencyKey: "order-1", body: { n: 1 } })
					.then((r) => r.json()),
			),
		);
		expect(new Set(values.map((value) => value.messageId)).size).toBe(1);
		expect(values.filter((value) => !value.deduped)).toHaveLength(1);
		const lease = (
			await (
				await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 100 })
			).json()
		).messages[0];
		expect(
			(
				await f.call("complete", {
					messageId: lease.messageId,
					leaseId: lease.leaseId,
				})
			).status,
		).toBe(200);
		const duplicate = await (
			await f.call("enqueue", { idempotencyKey: "order-1", body: { n: 1 } })
		).json();
		expect(duplicate).toMatchObject({
			messageId: lease.messageId,
			deduped: true,
		});
	});
	it("expires, fences, extends, releases and idempotently completes leases", async () => {
		const f = fixture();
		await f.call("enqueue", { idempotencyKey: "k", body: "data" });
		const first = (
			await (
				await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 20 })
			).json()
		).messages[0];
		expect(
			(
				await (
					await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 20 })
				).json()
			).messages,
		).toEqual([]);
		f.advance(20);
		const second = (
			await (
				await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 40 })
			).json()
		).messages[0];
		expect(second).toMatchObject({
			messageId: first.messageId,
			deliveryAttempt: 2,
		});
		expect(second.leaseId).not.toBe(first.leaseId);
		expect(
			(
				await f.call("complete", {
					messageId: first.messageId,
					leaseId: first.leaseId,
				})
			).status,
		).toBe(409);
		expect(
			(
				await f.call("extend", {
					messageId: second.messageId,
					leaseId: second.leaseId,
					visibilityTimeoutMs: 80,
				})
			).status,
		).toBe(200);
		expect(
			(
				await f.call("release", {
					messageId: second.messageId,
					leaseId: second.leaseId,
				})
			).status,
		).toBe(200);
		const third = (
			await (
				await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 80 })
			).json()
		).messages[0];
		expect(third.deliveryAttempt).toBe(3);
		const completed = { messageId: third.messageId, leaseId: third.leaseId };
		expect(await (await f.call("complete", completed)).json()).toMatchObject({
			deduped: false,
		});
		expect(await (await f.call("complete", completed)).json()).toMatchObject({
			deduped: true,
		});
		expect(
			(
				await f.call("complete", {
					messageId: third.messageId,
					leaseId: second.leaseId,
				})
			).status,
		).toBe(409);
	});
	it("preserves delayed delivery and fails closed if the clock regresses", async () => {
		const f = fixture();
		await f.call("enqueue", {
			idempotencyKey: "later",
			body: 1,
			availableAtMs: 1100,
		});
		expect(
			(
				await (
					await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 10 })
				).json()
			).messages,
		).toEqual([]);
		f.advance(100);
		expect(
			(
				await (
					await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 10 })
				).json()
			).messages,
		).toHaveLength(1);
		f.advance(-1);
		expect(
			(await f.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 10 }))
				.status,
		).toBe(503);
	});
});

it("does not silently coerce non-finite JSON numbers", async () => {
	const f = fixture();
	const result = await f.binding.handle(
		{ name: "jobs", key: ["tenant-a"], db: f.database },
		new Request("https://queue.test/enqueue", {
			method: "POST",
			headers: { authorization: "test" },
			body: '{"idempotencyKey":"bad","body":1e400}',
		}),
	);
	expect(result.status).toBe(400);
});

it("retains deduplication and leases after a SQLite actor restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-queue-state-"));
	try {
		const path = join(directory, "queue.sqlite");
		const first = fixture(path);
		const original = await (
			await first.call("enqueue", { idempotencyKey: "persist", body: { n: 7 } })
		).json();
		const lease = (
			await (
				await first.call("dequeue", { maxMessages: 1, visibilityTimeoutMs: 10 })
			).json()
		).messages[0];
		first.close();
		const second = fixture(path);
		const retry = await (
			await second.call("enqueue", {
				idempotencyKey: "persist",
				body: { n: 7 },
			})
		).json();
		expect(retry).toMatchObject({
			messageId: original.messageId,
			deduped: true,
		});
		expect(
			(
				await (
					await second.call("dequeue", {
						maxMessages: 1,
						visibilityTimeoutMs: 10,
					})
				).json()
			).messages,
		).toEqual([]);
		second.advance(10);
		const redelivery = (
			await (
				await second.call("dequeue", {
					maxMessages: 1,
					visibilityTimeoutMs: 10,
				})
			).json()
		).messages[0];
		expect(redelivery).toMatchObject({
			messageId: original.messageId,
			body: { n: 7 },
			deliveryAttempt: 2,
		});
		expect(
			(
				await second.call("complete", {
					messageId: lease.messageId,
					leaseId: lease.leaseId,
				})
			).status,
		).toBe(409);
		second.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("exposes the separate async client with explicit lost-ack handling", async () => {
	const f = fixture();
	let loseAcknowledgement = true;
	const client = createRivetAsyncQueueClient({
		fetch: async (path, init) => {
			const headers = new Headers(init.headers);
			headers.set("authorization", "test");
			const result = await f.binding.handle(
				{ name: "jobs", key: ["tenant-a"], db: f.database },
				new Request(`https://queue.test${path}`, { ...init, headers }),
			);
			if (path === "/enqueue" && loseAcknowledgement) {
				loseAcknowledgement = false;
				throw new Error("response lost");
			}
			return result;
		},
	});
	await expect(client.enqueue("key", { hello: "world" })).rejects.toMatchObject(
		{ code: "outcome-unknown" },
	);
	const retry = await client.enqueue("key", { hello: "world" });
	expect(retry.deduped).toBe(true);
	const [leased] = await client.dequeue(1, 100);
	if (!leased) throw new Error("lease missing");
	expect(leased.messageId).toBe(retry.messageId);
	await expect(
		client.complete(leased.messageId, "wrong"),
	).rejects.toMatchObject({ code: "lease-lost" });
	expect(
		(await client.complete(leased.messageId, leased.leaseId)).deduped,
	).toBe(false);
	expect(
		(await client.complete(leased.messageId, leased.leaseId)).deduped,
	).toBe(true);
});

/* oxlint-enable anti-slop/no-object-parameters */

it("rejects changed payloads and schedules under an existing idempotency key", async () => {
	const f = fixture();
	const initial = await f.call("enqueue", {
		idempotencyKey: "same",
		body: { a: 1, b: 2 },
	});
	const first = await initial.json();
	const reordered = await f.call("enqueue", {
		idempotencyKey: "same",
		body: { b: 2, a: 1 },
	});
	expect(await reordered.json()).toMatchObject({
		messageId: first.messageId,
		deduped: true,
	});
	const changedBody = await f.call("enqueue", {
		idempotencyKey: "same",
		body: { a: 2, b: 2 },
	});
	expect(changedBody.status).toBe(409);
	expect(await changedBody.json()).toMatchObject({
		error: "idempotency-conflict",
	});
	const changedSchedule = await f.call("enqueue", {
		idempotencyKey: "same",
		body: { a: 1, b: 2 },
		availableAtMs: 1000,
	});
	expect(changedSchedule.status).toBe(409);
});

it("returns an explicit unavailable result when the trusted clock throws", async () => {
	const f = fixture();
	const binding = createRivetQueueActor({
		actorName: "jobs",
		authorize: () => true,
		now: () => {
			throw new Error("clock unavailable");
		},
	});
	const result = await binding.handle(
		{ name: "jobs", key: ["tenant"], db: f.database },
		new Request("https://queue.test/enqueue", {
			method: "POST",
			body: JSON.stringify({ idempotencyKey: "k", body: 1 }),
		}),
	);
	expect(result.status).toBe(503);
	expect(await result.json()).toEqual({ error: "clock-unavailable" });
});

it("rejects accessor-bearing client payloads before sending", async () => {
	let calls = 0;
	let reads = 0;
	const queue = createRivetAsyncQueueClient({
		fetch: async () => {
			calls++;
			return Response.json({});
		},
	});
	const body = {
		get value() {
			reads++;
			return 1;
		},
	};
	await expect(queue.enqueue("key", body)).rejects.toMatchObject({
		code: "invalid-argument",
	});
	expect(reads).toBe(0);
	expect(calls).toBe(0);
});

it("treats an uncommitted success status as an unknown queue outcome", async () => {
	const queue = createRivetAsyncQueueClient({
		fetch: async () =>
			Response.json(
				{ messageId: "message", idempotencyKey: "key", deduped: false },
				{ status: 202 },
			),
	});
	await expect(queue.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
});

it("refuses an unverified native request stream before any database transaction", async () => {
	const f = fixture();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	// SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
	const request = new Request("https://queue.test/enqueue", {
		method: "POST",
		headers: { authorization: "test" },
		body: stream,
		duplex: "half",
	} as RequestInit);
	const result = await f.binding.handle(
		{ name: "jobs", key: ["tenant-a"], db: f.database },
		request,
	);
	expect(result.status).toBe(400);
	expect(cancelled).toBe(true);
	expect(
		f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
	).toBe(0);
});

it("accepts a native request only after host verifies the exact ingress bounds", async () => {
	const f = fixture();
	const claims: object[] = [];
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1000,
		authorize: () => true,
		verifyIngress: (claim) => {
			claims.push(claim);
			return true;
		},
	});
	const body = new TextEncoder().encode(
		JSON.stringify({ idempotencyKey: "k", body: 1 }),
	);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});
	// SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
	const request = new Request("https://queue.test/enqueue", {
		method: "POST",
		body: stream,
		duplex: "half",
	} as RequestInit);
	const result = await binding.handle(
		{ name: "jobs", key: ["tenant-a"], db: f.database },
		request,
	);
	expect(result.status).toBe(200);
	expect(claims).toEqual([
		{
			actorName: "jobs",
			actorKey: ["tenant-a"],
			operation: "enqueue",
			maxRequestBytes: 65_536,
			maxChunkBytes: 65_536,
		},
	]);
});

it("rejects a trusted-ingress violation with an oversized chunk before mutation", async () => {
	const f = fixture();
	let cancelled = false;
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1000,
		authorize: () => true,
		verifyIngress: () => true,
	});
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(65_537));
		},
		cancel() {
			cancelled = true;
		},
	});
	// SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
	const request = new Request("https://queue.test/enqueue", {
		method: "POST",
		body: stream,
		duplex: "half",
	} as RequestInit);
	const result = await binding.handle(
		{ name: "jobs", key: ["tenant-a"], db: f.database },
		request,
	);
	expect(result.status).toBe(400);
	expect(cancelled).toBe(true);
	expect(
		f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
	).toBe(0);
});

it("times out and cancels a stalled actor request before mutation", async () => {
	vi.useFakeTimers();
	const f = fixture();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		type: "bytes",
		pull() {},
		cancel() {
			cancelled = true;
		},
	});
	// SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
	const request = new Request("https://queue.test/enqueue", {
		method: "POST",
		headers: { authorization: "test" },
		body: stream,
		duplex: "half",
	} as RequestInit);
	const outcome = f.binding.handle(
		{ name: "jobs", key: ["tenant-a"], db: f.database },
		request,
	);
	await vi.advanceTimersByTimeAsync(10_001);
	expect((await outcome).status).toBe(400);
	expect(cancelled).toBe(true);
	expect(
		f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
	).toBe(0);
});

it("times out a stalled transport once and reports unknown mutation outcome", async () => {
	vi.useFakeTimers();
	let calls = 0;
	let aborted = false;
	const client = createRivetAsyncQueueClient({
		fetch: async (_path, init) => {
			calls++;
			init.signal?.addEventListener("abort", () => {
				aborted = true;
			});
			return await new Promise<Response>(() => {});
		},
	});
	const outcome = expect(client.enqueue("k", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	await vi.advanceTimersByTimeAsync(10_001);
	await outcome;
	expect(calls).toBe(1);
	expect(aborted).toBe(true);
});

it("times out and cancels stalled or unsupported response streams", async () => {
	vi.useFakeTimers();
	let cancelled = false;
	const client = createRivetAsyncQueueClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					type: "bytes",
					pull() {},
					cancel() {
						cancelled = true;
					},
				}),
			),
	});
	const outcome = expect(client.enqueue("k", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	await vi.advanceTimersByTimeAsync(10_001);
	await outcome;
	expect(cancelled).toBe(true);
	let unsupportedCancelled = false;
	const unsupported = createRivetAsyncQueueClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						unsupportedCancelled = true;
					},
				}),
			),
	});
	await expect(unsupported.enqueue("k", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(unsupportedCancelled).toBe(true);
});

it("cancels an oversized BYOB response without accepting the receipt", async () => {
	let cancelled = false;
	const client = createRivetAsyncQueueClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					type: "bytes",
					start(controller) {
						controller.enqueue(new Uint8Array(8_388_609));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	});
	await expect(client.enqueue("k", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(cancelled).toBe(true);
});
