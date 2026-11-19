/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof -- SAFETY: fixtures exercise untrusted HTTP and native callback boundaries. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { types } from "node:util";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRivetAsyncQueueClient,
	type RivetAsyncQueueTransport,
} from "../src/rivet-queue.js";
import {
	createRivetQueueActor,
	isRivetQueueBinding,
} from "../src/rivet-queue-runtime.js";
import { readRivetQueueStream } from "../src/rivet-queue-stream.js";

const queueAuthority = {
	scope: {
		tenantId: "tenant-a",
		instanceId: "instance-a",
		actorName: "jobs",
		actorKey: ["tenant-a", "jobs"],
	},
	verifyDispatch: () => true,
};

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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the queue actor passes only SQLite-supported primitive bindings.
		sql.prepare(query).all(...(args as SQLInputValue[]));
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
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the transaction callback uses only the SQL execute member in this fixture.
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the actor under test uses only execute and transaction from this fixture.
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
	it.each([
		"name",
		"key",
		"db",
	] as const)("rejects a context %s accessor without invoking it or consuming ingress", async (field) => {
		const f = fixture();
		let traps = 0;
		const context = { name: "jobs", key: ["tenant-a"], db: f.database };
		Object.defineProperty(context, field, {
			configurable: true,
			get() {
				traps++;
				throw new Error("unexpected context accessor");
			},
		});
		const request = new Request("https://queue.test/enqueue", {
			method: "POST",
			body: JSON.stringify({ idempotencyKey: "key", body: 1 }),
		});
		expect((await f.binding.handle(context, request)).status).toBe(403);
		expect(traps).toBe(0);
		expect(request.bodyUsed).toBe(false);
		expect(
			f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
		).toBe(0);
	});

	it("rejects proxied and sparse context keys without executing traps", async () => {
		const f = fixture();
		let traps = 0;
		const proxied = new Proxy(["tenant-a"], {
			get() {
				traps++;
				throw new Error("key trap");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("descriptor trap");
			},
		});
		const revoked = Proxy.revocable(["tenant-a"], {});
		revoked.revoke();
		const accessor = ["tenant-a"];
		Object.defineProperty(accessor, "0", {
			get() {
				traps++;
				throw new Error("key accessor");
			},
		});
		const sparse: string[] = [];
		sparse.length = 1;
		for (const key of [proxied, revoked.proxy, accessor, sparse]) {
			const request = new Request("https://queue.test/enqueue", {
				method: "POST",
				body: "{}",
			});
			expect(
				(await f.binding.handle({ name: "jobs", key, db: f.database }, request))
					.status,
			).toBe(403);
			expect(request.bodyUsed).toBe(false);
		}
		expect(traps).toBe(0);
	});
	it("rejects proxied contexts and transaction accessors before authorization", async () => {
		const f = fixture();
		let traps = 0;
		const context = { name: "jobs", key: ["tenant-a"], db: f.database };
		const proxied = new Proxy(context, {
			get() {
				traps++;
				throw new Error("context trap");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("context descriptor trap");
			},
		});
		const revoked = Proxy.revocable(context, {});
		revoked.revoke();
		const db = new Proxy(f.database, {
			get() {
				traps++;
				throw new Error("database trap");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("database descriptor trap");
			},
		});
		const accessorDb = Object.create(null);
		Object.defineProperty(accessorDb, "transaction", {
			get() {
				traps++;
				throw new Error("transaction accessor");
			},
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these proxies and accessors deliberately violate the host context contract.
		const cases = [
			proxied,
			revoked.proxy,
			{ ...context, db },
			{ ...context, db: accessorDb },
		] as (typeof context)[];
		for (const value of cases) {
			const request = new Request("https://queue.test/enqueue", {
				method: "POST",
				body: "{}",
			});
			expect((await f.binding.handle(value, request)).status).toBe(403);
			expect(request.bodyUsed).toBe(false);
		}
		expect(traps).toBe(0);
	});

	it("rejects own context accessors on the native actor callback before reading them", async () => {
		const f = fixture();
		let traps = 0;
		const context = { name: "jobs", key: ["tenant-a"], db: f.database };
		Object.defineProperty(context, "name", {
			get() {
				traps++;
				throw new Error("context accessor");
			},
		});
		const onRequest = f.binding.actor.config.onRequest;
		if (typeof onRequest !== "function")
			throw new Error("missing actor callback");
		const request = new Request("https://queue.test/enqueue", {
			method: "POST",
			body: "{}",
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the fixture intentionally passes a malformed Rivet context.
		const result = await onRequest(context as never, request);
		expect(result.status).toBe(403);
		expect(request.bodyUsed).toBe(false);
		expect(traps).toBe(0);
	});

	it("keeps the authorized key, database and transaction captured before an await", async () => {
		const f = fixture();
		const context = { name: "jobs", key: ["tenant-a"], db: f.database };
		let substitutedCalls = 0;
		const original = f.database.transaction;
		const substitute: RawAccess["transaction"] = async () => {
			substitutedCalls++;
			throw new Error("substituted transaction");
		};
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: async ({ actorKey }) => {
				await Promise.resolve();
				context.name = "other";
				context.key[0] = "tenant-b";
				context.db = { ...f.database, transaction: substitute };
				f.database.transaction = substitute;
				return Object.isFrozen(actorKey) && actorKey[0] === "tenant-a";
			},
		});
		const result = await binding.handle(
			context,
			new Request("https://queue.test/enqueue", {
				method: "POST",
				body: JSON.stringify({ idempotencyKey: "key", body: 1 }),
			}),
		);
		f.database.transaction = original;
		expect(result.status).toBe(200);
		expect(substitutedCalls).toBe(0);
		expect(
			f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
		).toBe(1);
	});

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
		...queueAuthority,
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
	const extended = await client.extend(leased.messageId, leased.leaseId, 100);
	expect(extended.queueName).toBe("jobs");
	await client.release(leased.messageId, leased.leaseId);
	const [released] = await client.dequeue(1, 100);
	if (!released) throw new Error("released lease missing");
	expect(
		(await client.complete(released.messageId, released.leaseId)).deduped,
	).toBe(false);
	expect(
		(await client.complete(released.messageId, released.leaseId)).deduped,
	).toBe(true);
});

it("captures the original queue transport callbacks without their mutable bind or call properties", async () => {
	let traps = 0;
	const calls: string[] = [];
	const transport = {
		...queueAuthority,
		verifyDispatch() {
			expect(this).toBe(transport);
			calls.push("dispatch");
			return true;
		},
		async fetch() {
			expect(this).toBe(transport);
			calls.push("fetch");
			const bytes = new TextEncoder().encode(
				'{"messageId":"m","idempotencyKey":"key","deduped":false}',
			);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
			);
		},
		verifyResponseBounds() {
			expect(this).toBe(transport);
			calls.push("bounds");
			return false;
		},
	};
	for (const callback of [
		transport.fetch,
		transport.verifyDispatch,
		transport.verifyResponseBounds,
	]) {
		for (const key of ["bind", "call"])
			Object.defineProperty(callback, key, {
				get() {
					traps++;
					return () => () => true;
				},
			});
	}
	const client = createRivetAsyncQueueClient(transport);
	let substituted = 0;
	transport.fetch = async () => {
		substituted++;
		return new Response("forged");
	};
	transport.verifyDispatch = () => {
		substituted++;
		return false;
	};
	transport.verifyResponseBounds = () => {
		substituted++;
		return true;
	};
	const originalApply = Reflect.apply;
	let pending: Promise<unknown>;
	Reflect.apply = () => {
		substituted++;
		throw new Error("substituted intrinsic");
	};
	try {
		pending = client.enqueue("key", 1);
	} finally {
		Reflect.apply = originalApply;
	}
	await expect(pending).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(calls).toEqual(["dispatch", "fetch", "bounds"]);
	expect(traps).toBe(0);
	expect(substituted).toBe(0);
});

it("rejects proxied and accessor-backed queue transports before invoking traps", () => {
	for (const key of [
		"fetch",
		"verifyDispatch",
		"verifyResponseBounds",
		"scope",
	]) {
		for (const mode of ["container", "callback", "accessor"] as const) {
			let traps = 0;
			const transport = {
				...queueAuthority,
				fetch: async () => new Response(),
				verifyResponseBounds: () => true,
			};
			if (mode === "callback")
				Object.defineProperty(transport, key, {
					value: new Proxy(() => true, {
						apply() {
							traps++;
							throw new Error("trap");
						},
					}),
					enumerable: true,
				});
			if (mode === "accessor")
				Object.defineProperty(transport, key, {
					get() {
						traps++;
						throw new Error("trap");
					},
					enumerable: true,
				});
			const candidate =
				mode === "container"
					? new Proxy(transport, {
							get() {
								traps++;
								throw new Error("trap");
							},
							getOwnPropertyDescriptor() {
								traps++;
								throw new Error("trap");
							},
						})
					: transport;
			expect(() => createRivetAsyncQueueClient(candidate)).toThrow(
				"queue transport",
			);
			expect(traps).toBe(0);
		}
	}
});

it("rejects polluted descriptor values and replaced proxy predicates without traps", async () => {
	let traps = 0;
	let sends = 0;
	const transport = {
		...queueAuthority,
		async fetch() {
			sends++;
			return new Response();
		},
	};
	const client = createRivetAsyncQueueClient(transport);
	const candidate = Object.defineProperty({ ...transport }, "fetch", {
		enumerable: true,
		get() {
			traps++;
			throw new Error("accessor");
		},
	});
	const body = new Proxy(
		{ amount: 1 },
		{
			get() {
				traps++;
				throw new Error("proxy");
			},
		},
	);
	const oldValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
	const oldProxy = Object.getOwnPropertyDescriptor(types, "isProxy");
	Object.defineProperty(Object.prototype, "value", {
		configurable: true,
		get() {
			traps++;
			throw new Error("polluted");
		},
	});
	Object.defineProperty(types, "isProxy", {
		configurable: true,
		writable: true,
		value: () => false,
	});
	let error: unknown;
	let pending: Promise<unknown>;
	try {
		try {
			createRivetAsyncQueueClient(candidate);
		} catch (caught) {
			error = caught;
		}
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the proxy deliberately exercises the untrusted request-body boundary.
		pending = client.enqueue("key", body as never);
	} finally {
		if (oldValue === undefined)
			Reflect.deleteProperty(Object.prototype, "value");
		else Object.defineProperty(Object.prototype, "value", oldValue);
		if (oldProxy !== undefined)
			Object.defineProperty(types, "isProxy", oldProxy);
	}
	expect(error).toBeInstanceOf(TypeError);
	await expect(pending).rejects.toMatchObject({ code: "invalid-argument" });
	expect(traps).toBe(0);
	expect(sends).toBe(0);
});

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this test inspects the actual transport body crossing the JavaScript boundary. */
it("binds each single-dispatch proof to the immutable destination and exact request before and after delivery", async () => {
	const scope = {
		tenantId: "tenant-a",
		instanceId: "instance-a",
		actorName: "jobs",
		actorKey: ["tenant-a", "jobs"],
	};
	const claims: Parameters<RivetAsyncQueueTransport["verifyDispatch"]>[0][] =
		[];
	let sent = "";
	const transport = {
		scope,
		verifyDispatch(
			claim: Parameters<RivetAsyncQueueTransport["verifyDispatch"]>[0],
		) {
			claims.push(claim);
			expect(Object.isFrozen(claim)).toBe(true);
			expect(Object.isFrozen(claim.scope.actorKey)).toBe(true);
			return (
				claim.scope.tenantId === "tenant-a" &&
				claim.scope.actorKey[0] === "tenant-a"
			);
		},
		verifyResponseBounds: () => true,
		async fetch(_path, init) {
			if (typeof init.body !== "string") throw new Error("unexpected body");
			expect(init.redirect).toBe("error");
			sent = init.body;
			return Response.json({
				messageId: "message",
				idempotencyKey: "key",
				deduped: false,
			});
		},
	};
	const originalFetch = transport.fetch;
	const client = createRivetAsyncQueueClient(transport);
	scope.tenantId = "other";
	scope.actorKey[0] = "other";
	await client.enqueue("key", { value: 3 });
	expect(claims.map((claim) => claim.phase)).toEqual(["before", "after"]);
	for (const claim of claims)
		expect(claim).toMatchObject({
			scope: {
				tenantId: "tenant-a",
				instanceId: "instance-a",
				actorName: "jobs",
				actorKey: ["tenant-a", "jobs"],
			},
			operation: "/enqueue",
			requestBody: sent,
			maxAttempts: 1,
			fetch: originalFetch,
			receiver: transport,
		});
	const responseBody = JSON.stringify({
		messageId: "message",
		idempotencyKey: "key",
		deduped: false,
	});
	expect(claims[1]).toMatchObject({
		responseStatus: 200,
		responseDigest: `sha256:${createHash("sha256").update(responseBody).digest("hex")}`,
	});
	expect(JSON.parse(sent)).toEqual({
		idempotencyKey: "key",
		body: { value: 3 },
	});
});

/* oxlint-enable anti-slop/no-runtime-typeof */
it("refuses an absent, denied, or revoked single-dispatch proof", async () => {
	let calls = 0;
	const fetch = async () => {
		calls++;
		return Response.json({
			messageId: "message",
			idempotencyKey: "key",
			deduped: false,
		});
	};
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the missing host verifier intentionally exercises the runtime input boundary.
	expect(() =>
		createRivetAsyncQueueClient({
			scope: queueAuthority.scope,
			fetch,
		} as never),
	).toThrow("queue transport");
	const denied = createRivetAsyncQueueClient({
		...queueAuthority,
		fetch,
		verifyDispatch: () => false,
	});
	await expect(denied.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(calls).toBe(0);
	const revoked = createRivetAsyncQueueClient({
		...queueAuthority,
		fetch,
		verifyResponseBounds: () => true,
		verifyDispatch: (claim) => claim.phase === "before",
	});
	await expect(revoked.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(calls).toBe(1);
});

it("lets the host reject receiver substitution and a forged response digest", async () => {
	let calls = 0;
	const goodFetch = async () => {
		calls++;
		return Response.json({
			messageId: "forged",
			idempotencyKey: "key",
			deduped: false,
		});
	};
	const expected = `sha256:${createHash("sha256").update('{"messageId":"real","idempotencyKey":"key","deduped":false}').digest("hex")}`;
	const transport: RivetAsyncQueueTransport = {
		...queueAuthority,
		fetch: goodFetch,
		verifyResponseBounds: () => true,
		verifyDispatch(claim) {
			return (
				claim.receiver === transport &&
				claim.fetch === goodFetch &&
				transport.fetch === goodFetch &&
				(claim.phase === "before" || claim.responseDigest === expected)
			);
		},
	};
	const client = createRivetAsyncQueueClient(transport);
	await expect(client.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(calls).toBe(1);
	transport.fetch = async () => {
		throw new Error("substituted");
	};
	await expect(client.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(calls).toBe(1);
});

it("never accepts inherited fields as an authenticated queue receipt or denial", async () => {
	let status = 200;
	let payload = "{}";
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		fetch: async () => new Response(payload, { status }),
		verifyResponseBounds: () => true,
	});
	const message = {
		messageId: "m",
		queueName: "jobs",
		idempotencyKey: "key",
		body: 1,
		leaseId: "lease",
		leaseExpiresAt: "2026-01-01T00:00:00.000Z",
		deliveryAttempt: 1,
	};
	const inherited = {
		...message,
		deduped: false,
		messages: [],
		message,
		error: "forbidden",
	};
	const previous = Object.entries(inherited).map(
		([key]) =>
			[key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const,
	);
	const results: unknown[] = [];
	const record = async (pending: Promise<unknown>) => {
		try {
			results.push(await pending);
		} catch (error) {
			results.push(error);
		}
	};
	try {
		for (const [key, value] of Object.entries(inherited))
			Object.defineProperty(Object.prototype, key, {
				configurable: true,
				writable: true,
				value,
			});
		await record(client.enqueue("key", 1));
		await record(client.complete("m", "lease"));
		await record(client.release("m", "lease"));
		await record(client.dequeue(1, 1_000));
		await record(client.extend("m", "lease", 1_000));
		payload = '{"message":{}}';
		await record(client.extend("m", "lease", 1_000));
		payload = '{"messages":[{}]}';
		await record(client.dequeue(1, 1_000));
		status = 403;
		payload = "{}";
		await record(client.enqueue("key", 1));
	} finally {
		for (const [key, descriptor] of previous)
			if (descriptor === undefined)
				Reflect.deleteProperty(Object.prototype, key);
			else Object.defineProperty(Object.prototype, key, descriptor);
	}
	expect(results).toHaveLength(8);
	for (const result of results)
		expect(result).toMatchObject({ code: "outcome-unknown" });
});

it("rejects contradictory, extra and foreign-queue receipts after response authentication", async () => {
	let status = 200;
	let payload = "{}";
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		fetch: async () => new Response(payload, { status }),
		verifyResponseBounds: () => true,
	});
	const foreign = {
		messageId: "m",
		queueName: "other-queue",
		idempotencyKey: "key",
		body: 1,
		leaseId: "lease",
		leaseExpiresAt: "2026-01-01T00:00:00.000Z",
		deliveryAttempt: 1,
	};
	payload = JSON.stringify({
		messageId: "m",
		idempotencyKey: "key",
		deduped: false,
		error: "forbidden",
	});
	await expect(client.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	payload = JSON.stringify({ messageId: "m", extra: true });
	await expect(client.release("m", "lease")).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	payload = JSON.stringify({ messages: [foreign] });
	await expect(client.dequeue(1, 1_000)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	payload = JSON.stringify({ message: foreign });
	await expect(client.extend("m", "lease", 1_000)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	payload = JSON.stringify({
		messages: [{ ...foreign, queueName: "jobs", extra: true }],
	});
	await expect(client.dequeue(1, 1_000)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	status = 409;
	payload = JSON.stringify({ error: "lease-lost", messageId: "m" });
	await expect(client.complete("m", "lease")).rejects.toMatchObject({
		code: "outcome-unknown",
	});
});

it("uses the host-fenced receiver state when an asynchronous verifier resumes", async () => {
	let resume = () => {};
	const gate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	let calls = 0;
	const transport = {
		...queueAuthority,
		allowed: true,
		async verifyDispatch() {
			await gate;
			return this.allowed;
		},
		async fetch() {
			calls++;
			return new Response();
		},
	};
	const client = createRivetAsyncQueueClient(transport);
	const pending = client.enqueue("key", 1);
	transport.allowed = false;
	resume();
	await expect(pending).rejects.toMatchObject({ code: "outcome-unknown" });
	expect(calls).toBe(0);
});

it("quarantines unobservable verifier promises without reading proxy traps", async () => {
	let traps = 0;
	let verifications = 0;
	let dispatches = 0;
	const pending = new Proxy(Promise.resolve(true), {
		get() {
			traps++;
			throw new Error("unexpected promise access");
		},
	});
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyDispatch: () => {
			verifications++;
			return pending;
		},
		fetch: async () => {
			dispatches++;
			return new Response();
		},
	});
	for (let index = 0; index < 32; index++)
		await expect(client.enqueue(`key-${index}`, 1)).rejects.toMatchObject({
			code: "outcome-unknown",
		});
	await expect(client.enqueue("overflow", 1)).rejects.toMatchObject({
		code: "capacity-exhausted",
	});
	expect(verifications).toBe(32);
	expect(dispatches).toBe(0);
	expect(traps).toBe(0);
});

it("observes ordinary rejected verifier promises and releases settled work", async () => {
	let verifications = 0;
	let dispatches = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyDispatch: () => {
			verifications++;
			return Promise.reject("unavailable");
		},
		fetch: async () => {
			dispatches++;
			return new Response();
		},
	});
	for (let index = 0; index < 33; index++)
		await expect(client.enqueue(`key-${index}`, 1)).rejects.toMatchObject({
			code: "outcome-unknown",
		});
	expect(verifications).toBe(33);
	expect(dispatches).toBe(0);
});

it("quarantines an unobservable transaction without reading proxy traps", async () => {
	let traps = 0;
	let transactions = 0;
	const unresolved = new Promise<Response>(() => {});
	const database = {
		transaction: () => {
			transactions++;
			return new Proxy(unresolved, {
				get() {
					traps++;
					throw new Error("unexpected promise access");
				},
			});
		},
	};
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1000,
		authorize: () => true,
		verifyIngress: () => true,
	});
	const request = () =>
		new Request("https://queue.test/dequeue", {
			method: "POST",
			body: JSON.stringify({ maxMessages: 1, visibilityTimeoutMs: 100 }),
		});
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the actor uses only the own transaction capability in this fixture.
	const context = {
		name: "jobs",
		key: ["tenant-a"],
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the actor uses only this own transaction capability.
		db: database as unknown as RawAccess,
	};
	for (let index = 0; index < 32; index++)
		expect((await binding.handle(context, request())).status).toBe(503);
	const overflow = await binding.handle(context, request());
	expect(await overflow.json()).toEqual({ error: "capacity-exhausted" });
	expect(transactions).toBe(32);
	expect(traps).toBe(0);
});

it("does not disclose a substituted transaction response after a committed write", async () => {
	const f = fixture();
	let after = 0;
	const database = {
		transaction: async <T>(run: (tx: RawAccess) => Promise<T>) => {
			await f.database.transaction(run);
			return new Response('{"messageId":"forged"}');
		},
	};
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1000,
		authorize: ({ phase }) => {
			if (phase === "after") after++;
			return true;
		},
		verifyIngress: () => true,
	});
	const context = {
		name: "jobs",
		key: ["tenant-a"],
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fixture exposes only the used transaction capability.
		db: database as unknown as RawAccess,
	};
	const result = await binding.handle(
		context,
		new Request("https://queue.test/enqueue", {
			method: "POST",
			body: JSON.stringify({ idempotencyKey: "written", body: 1 }),
		}),
	);
	expect(result.status).toBe(503);
	expect(await result.json()).toEqual({ error: "queue-unavailable" });
	expect(
		f.sql.prepare("SELECT COUNT(*) AS n FROM hobo_queue_messages").get()?.n,
	).toBe(1);
	expect(after).toBe(0);
});

it("does not start SQL when the host invokes the transaction callback twice", async () => {
	let queries = 0;
	const database = {
		transaction: async <T>(run: (tx: RawAccess) => Promise<T>) => {
			const tx = {
				execute: async () => {
					queries++;
					return [];
				},
			};
			// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the callback uses only this own execute capability.
			const captured = tx as unknown as RawAccess;
			const first = run(captured);
			const second = run(captured);
			await Promise.allSettled([first, second]);
			return new Response();
		},
	};
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1000,
		authorize: () => true,
		verifyIngress: () => true,
	});
	const context = {
		name: "jobs",
		key: ["tenant-a"],
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fixture exposes only the used transaction capability.
		db: database as unknown as RawAccess,
	};
	const result = await binding.handle(
		context,
		new Request("https://queue.test/dequeue", {
			method: "POST",
			body: JSON.stringify({ maxMessages: 1, visibilityTimeoutMs: 100 }),
		}),
	);
	expect(result.status).toBe(503);
	expect(queries).toBe(0);
});

it.each([
	"unavailable",
	"early",
] as const)("does not authorize or send a queue request when its timer is %s", async (mode) => {
	let verifications = 0;
	let dispatches = 0;
	const original = globalThis.setTimeout;
	const timer = vi
		.spyOn(globalThis, "setTimeout")
		.mockImplementationOnce((callback) => {
			if (mode === "unavailable") throw new Error("timer unavailable");
			callback();
			return original(() => {}, 10_000);
		});
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyDispatch: () => {
			verifications++;
			return true;
		},
		fetch: async () => {
			dispatches++;
			return new Response();
		},
	});
	try {
		await expect(client.enqueue("key", 1)).rejects.toMatchObject({
			code: "outcome-unknown",
		});
		await Promise.resolve();
	} finally {
		timer.mockRestore();
	}
	expect(verifications).toBe(0);
	expect(dispatches).toBe(0);
});

it("uses captured timer cleanup after a queue transport replaces it", async () => {
	const original = globalThis.clearTimeout;
	let substitutions = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyResponseBounds: () => true,
		verifyDispatch: () => {
			globalThis.clearTimeout = () => {
				substitutions++;
				throw new Error("timer cleanup replaced");
			};
			return true;
		},
		fetch: async () =>
			Response.json({ messageId: "m", idempotencyKey: "key", deduped: false }),
	});
	let result: unknown;
	try {
		result = await client.enqueue("key", 1);
	} finally {
		globalThis.clearTimeout = original;
	}
	expect(result).toMatchObject({ messageId: "m" });
	expect(substitutions).toBe(0);
});

it("retains bounded capacity until timed-out fetches actually settle", async () => {
	vi.useFakeTimers();
	const completions: ((response: Response) => void)[] = [];
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyResponseBounds: () => true,
		fetch: () => new Promise<Response>((resolve) => completions.push(resolve)),
	});
	const calls = Array.from({ length: 32 }, (_, index) =>
		client.enqueue(`key-${index}`, index).catch((error) => error),
	);
	await vi.advanceTimersByTimeAsync(10_001);
	for (const result of await Promise.all(calls))
		expect(result).toMatchObject({ code: "outcome-unknown" });
	expect(completions).toHaveLength(32);
	await expect(client.enqueue("overflow", 1)).rejects.toMatchObject({
		code: "capacity-exhausted",
	});
	completions[0]?.(new Response());
	await vi.advanceTimersByTimeAsync(0);
	const next = client.enqueue("next", 1);
	await vi.advanceTimersByTimeAsync(0);
	expect(completions).toHaveLength(33);
	completions[32]?.(
		Response.json({ messageId: "m", idempotencyKey: "next", deduped: false }),
	);
	await expect(next).resolves.toMatchObject({ messageId: "m" });
	for (const finish of completions.slice(1, 32)) finish(new Response());
	await vi.advanceTimersByTimeAsync(0);
});

it("retains a timed-out slot until a late response body is cancelled", async () => {
	vi.useFakeTimers();
	const completions: ((response: Response) => void)[] = [];
	let finishCancel = () => {};
	let cancels = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		fetch: () => new Promise<Response>((resolve) => completions.push(resolve)),
	});
	const calls = Array.from({ length: 32 }, (_, index) =>
		client.enqueue(`key-${index}`, index).catch((error) => error),
	);
	await vi.advanceTimersByTimeAsync(10_001);
	for (const result of await Promise.all(calls))
		expect(result).toMatchObject({ code: "outcome-unknown" });
	completions[0]?.(
		new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancels++;
					return new Promise<void>((resolve) => {
						finishCancel = resolve;
					});
				},
			}),
		),
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(cancels).toBe(1);
	await expect(client.enqueue("overflow", 1)).rejects.toMatchObject({
		code: "capacity-exhausted",
	});
	finishCancel();
	await vi.advanceTimersByTimeAsync(0);
	const next = client.enqueue("next", 1).catch((error) => error);
	await vi.advanceTimersByTimeAsync(0);
	expect(completions).toHaveLength(33);
	await vi.advanceTimersByTimeAsync(10_001);
	expect(await next).toMatchObject({ code: "outcome-unknown" });
	for (const finish of completions.slice(1)) finish(new Response());
	await vi.advanceTimersByTimeAsync(0);
});

it("retains capacity while timed-out response-bound verifiers are still pending", async () => {
	vi.useFakeTimers();
	const completions: ((verified: boolean) => void)[] = [];
	let sends = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		fetch: async () => {
			sends++;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("{}"));
						controller.close();
					},
				}),
			);
		},
		verifyResponseBounds: () =>
			new Promise<boolean>((resolve) => completions.push(resolve)),
	});
	const calls = Array.from({ length: 32 }, () =>
		client.enqueue("key", 1).catch((error) => error),
	);
	await vi.advanceTimersByTimeAsync(10_001);
	for (const result of await Promise.all(calls))
		expect(result).toMatchObject({ code: "outcome-unknown" });
	expect(completions).toHaveLength(32);
	await expect(client.enqueue("overflow", 1)).rejects.toMatchObject({
		code: "capacity-exhausted",
	});
	expect(sends).toBe(32);
	for (const finish of completions) finish(false);
	await vi.advanceTimersByTimeAsync(0);
});

it("retains capacity while timed-out stream cancellations are still pending", async () => {
	vi.useFakeTimers();
	const cancellations: (() => void)[] = [];
	let sends = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		fetch: async () => {
			sends++;
			return new Response(
				new ReadableStream<Uint8Array>({
					type: "bytes",
					pull() {},
					cancel: () =>
						new Promise<void>((resolve) => cancellations.push(resolve)),
				}),
			);
		},
	});
	const calls = Array.from({ length: 32 }, () =>
		client.enqueue("key", 1).catch((error) => error),
	);
	await vi.advanceTimersByTimeAsync(10_001);
	for (const result of await Promise.all(calls))
		expect(result).toMatchObject({ code: "outcome-unknown" });
	expect(cancellations).toHaveLength(32);
	await expect(client.enqueue("overflow", 1)).rejects.toMatchObject({
		code: "capacity-exhausted",
	});
	expect(sends).toBe(32);
	for (const finish of cancellations) finish();
	await vi.advanceTimersByTimeAsync(0);
});

it("rejects proxied or overridden response state without invoking traps", async () => {
	let traps = 0;
	const responses = ["status", "ok", "body"].map((key) => {
		const response = Response.json({ error: "forbidden" }, { status: 403 });
		Object.defineProperty(response, key, {
			get() {
				traps++;
				throw new Error("trap");
			},
		});
		return response;
	});
	const proxy = new Proxy(new Response(), {
		getPrototypeOf() {
			traps++;
			throw new Error("trap");
		},
	});
	for (const supplied of [...responses, proxy]) {
		const client = createRivetAsyncQueueClient({
			...queueAuthority,
			verifyResponseBounds: () => true,
			fetch: async () => supplied,
		});
		await expect(client.enqueue("key", 1)).rejects.toMatchObject({
			code: "outcome-unknown",
		});
	}
	expect(traps).toBe(0);
});

it("classifies a redirect as unknown without following it", async () => {
	let calls = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyResponseBounds: () => true,
		async fetch(_path, init) {
			calls++;
			expect(init.redirect).toBe("error");
			return new Response('{"error":"forbidden"}', {
				status: 307,
				headers: { location: "https://other.test" },
			});
		},
	});
	await expect(client.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(calls).toBe(1);
});

it("rejects proxied streams, overridden methods, proxied chunks and shared chunk buffers without traps", async () => {
	let traps = 0;
	const proxied = new Proxy(new ReadableStream(), {
		getPrototypeOf() {
			traps++;
			throw new Error("trap");
		},
	});
	const overridden = new ReadableStream();
	Object.defineProperty(overridden, "getReader", {
		get() {
			traps++;
			throw new Error("trap");
		},
	});
	for (const stream of [proxied, overridden])
		await expect(readRivetQueueStream(stream, 64)).rejects.toMatchObject({
			code: "invalid",
		});
	const chunk = new Proxy(new Uint8Array([1]), {
		getPrototypeOf() {
			traps++;
			throw new Error("trap");
		},
	});
	for (const value of [chunk, new Uint8Array(new SharedArrayBuffer(1))]) {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(value);
				controller.close();
			},
		});
		await expect(
			readRivetQueueStream(stream, 64, undefined, () => true),
		).rejects.toMatchObject({ code: "invalid" });
	}
	expect(traps).toBe(0);
});

it("uses native stream and typed-array accessors even if later overrides are installed", async () => {
	let traps = 0;
	const chunk = new Uint8Array([1, 2, 3]);
	Object.defineProperty(chunk, "byteLength", {
		get() {
			traps++;
			throw new Error("trap");
		},
	});
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});
	const original = Object.getOwnPropertyDescriptor(
		ReadableStream.prototype,
		"getReader",
	);
	Object.defineProperty(ReadableStream.prototype, "getReader", {
		configurable: true,
		value() {
			traps++;
			throw new Error("trap");
		},
	});
	let result: Uint8Array | undefined;
	try {
		result = (await readRivetQueueStream(stream, 64, undefined, () => true))
			.value;
	} finally {
		if (original !== undefined)
			Object.defineProperty(ReadableStream.prototype, "getReader", original);
	}
	expect(result).toEqual(new Uint8Array([1, 2, 3]));
	expect(traps).toBe(0);
});

it("checks monotonic elapsed time after a blocking dispatch verifier before sending", async () => {
	let calls = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyDispatch() {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_050);
			return true;
		},
		fetch: async () => {
			calls++;
			return new Response();
		},
	});
	await expect(client.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(calls).toBe(0);
}, 15_000);

it("does not invoke the response verifier after a blocking stream verifier exceeds the deadline", async () => {
	let after = 0;
	let pulls = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		verifyDispatch: (claim) => {
			if (claim.phase === "after") after++;
			return true;
		},
		verifyResponseBounds() {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_050);
			return true;
		},
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							pulls++;
							controller.enqueue(new TextEncoder().encode("{}"));
							controller.close();
						},
					},
					{ highWaterMark: 0 },
				),
			),
	});
	await expect(client.enqueue("key", 1)).rejects.toMatchObject({
		code: "outcome-unknown",
	});
	expect(after).toBe(0);
	expect(pulls).toBe(0);
}, 15_000);

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
		...queueAuthority,
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

it("rejects proxied, nested-proxy and oversized request bodies before any transport call", async () => {
	let traps = 0;
	let sends = 0;
	const hostile = new Proxy(
		{ amount: 1 },
		{
			get() {
				traps++;
				return 999;
			},
			ownKeys() {
				traps++;
				throw new Error("trap");
			},
			getPrototypeOf() {
				traps++;
				throw new Error("trap");
			},
		},
	);
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	const accessor = Object.defineProperty({}, "amount", {
		enumerable: true,
		get() {
			traps++;
			return 999;
		},
	});
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		async fetch() {
			sends++;
			return new Response();
		},
	});
	for (const body of [
		hostile,
		{ nested: hostile },
		revoked.proxy,
		accessor,
		{ text: "x".repeat(65_537) },
	]) {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally malformed values exercise the untrusted JavaScript boundary.
		await expect(client.enqueue("key", body as never)).rejects.toMatchObject({
			code: "invalid-argument",
		});
	}
	expect(traps).toBe(0);
	expect(sends).toBe(0);
});

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these tests inspect the actual transport body at the JavaScript boundary. */
it("sends the detached data even if the caller mutates it or installs an inherited toJSON hook", async () => {
	const body = { nested: [1, { amount: 2 }] };
	let transmitted = "";
	let traps = 0;
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		async fetch(_path, init) {
			if (typeof init.body !== "string") throw new Error("missing body");
			transmitted = init.body;
			throw new Error("response lost");
		},
	});
	const original = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
	Object.defineProperty(Array.prototype, "toJSON", {
		configurable: true,
		value() {
			traps++;
			return ["forged"];
		},
	});
	let pending: Promise<unknown>;
	try {
		pending = client.enqueue("key", body);
		body.nested[0] = 999;
	} finally {
		if (original === undefined)
			Reflect.deleteProperty(Array.prototype, "toJSON");
		else Object.defineProperty(Array.prototype, "toJSON", original);
	}
	await expect(pending).rejects.toMatchObject({ code: "outcome-unknown" });
	expect(JSON.parse(transmitted)).toEqual({
		idempotencyKey: "key",
		body: { nested: [1, { amount: 2 }] },
	});
	expect(traps).toBe(0);
});

it("preserves every value in a bounded nested JSON matrix", async () => {
	const values = [null, false, true, 0, 7, "", "x", "雪"] as const;
	let sent = "";
	const client = createRivetAsyncQueueClient({
		...queueAuthority,
		async fetch(_path, init) {
			if (typeof init.body !== "string") throw new Error("missing body");
			sent = init.body;
			return Response.json({
				messageId: "m",
				idempotencyKey: "key",
				deduped: false,
			});
		},
		verifyResponseBounds: () => true,
	});
	for (const first of values)
		for (const second of values) {
			const body = [first, { nested: second }];
			await client.enqueue("key", body);
			expect(JSON.parse(sent)).toEqual({ idempotencyKey: "key", body });
		}
});
/* oxlint-enable anti-slop/no-runtime-typeof */

it("treats an uncommitted success status as an unknown queue outcome", async () => {
	const queue = createRivetAsyncQueueClient({
		...queueAuthority,
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
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
	expect(result.status).toBe(503);
	expect(await result.json()).toEqual({ error: "ingress-unverified" });
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
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
	const result = await outcome;
	expect(result.status).toBe(503);
	expect(await result.json()).toEqual({ error: "request-timeout" });
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
		...queueAuthority,
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
		...queueAuthority,
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
		...queueAuthority,
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
		...queueAuthority,
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

it("distinguishes denied and unavailable authorization and bounds a stalled policy", async () => {
	vi.useFakeTimers();
	const f = fixture();
	const create = (authorize: () => boolean | Promise<boolean>) =>
		createRivetQueueActor({ actorName: "jobs", now: () => 1000, authorize });
	const request = () =>
		new Request("https://queue.test/enqueue", {
			method: "POST",
			body: JSON.stringify({ idempotencyKey: "k", body: 1 }),
		});
	const context = { name: "jobs", key: ["tenant-a"], db: f.database };
	const denied = await create(() => false).handle(context, request());
	expect(denied.status).toBe(403);
	expect(await denied.json()).toEqual({ error: "forbidden" });
	const broken = await create(() => {
		throw new Error("policy offline");
	}).handle(context, request());
	expect(broken.status).toBe(503);
	expect(await broken.json()).toEqual({ error: "policy-unavailable" });
	let resolvePolicy: (value: boolean) => void = () => {};
	const stalled = create(
		() =>
			new Promise<boolean>((resolve) => {
				resolvePolicy = resolve;
			}),
	).handle(context, request());
	await vi.advanceTimersByTimeAsync(10_001);
	const timedOut = await stalled;
	expect(timedOut.status).toBe(503);
	expect(await timedOut.json()).toEqual({ error: "request-timeout" });
	resolvePolicy(true);
	await Promise.resolve();
	expect(
		f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
	).toBe(0);
});

it("reports failed ingress verification as unavailable and never opens a transaction", async () => {
	const f = fixture();
	for (const verifyIngress of [
		() => false,
		() => {
			throw new Error("offline");
		},
	]) {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node requires duplex for streaming request bodies, which the DOM RequestInit type omits.
		const request = new Request("https://queue.test/enqueue", {
			method: "POST",
			body: stream,
			duplex: "half",
		} as RequestInit);
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
			verifyIngress,
		});
		const result = await binding.handle(
			{ name: "jobs", key: ["tenant-a"], db: f.database },
			request,
		);
		expect(result.status).toBe(503);
		expect(await result.json()).toEqual({ error: "ingress-unverified" });
		expect(cancelled).toBe(true);
	}
	expect(
		f.sql.prepare("SELECT count(*) AS n FROM hobo_queue_messages").get()?.n,
	).toBe(0);
});
