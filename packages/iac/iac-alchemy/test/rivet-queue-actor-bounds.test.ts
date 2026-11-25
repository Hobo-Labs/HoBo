/* oxlint-disable anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- SAFETY: these fixtures deliberately exercise hostile runtime values and minimal transaction stubs that implement only the methods under test. */

import { types } from "node:util";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRivetQueueActor } from "../src/rivet-queue-runtime.js";
import { readRivetQueueStream } from "../src/rivet-queue-stream.js";

afterEach(() => vi.useRealTimers());

function fixture() {
	let commits = 0;
	let queries = 0;
	const transaction = async <T>(
		run: (tx: RawAccess) => Promise<T>,
	): Promise<T> => {
		const result = await run({
			execute: async () => {
				queries++;
				return [];
			},
		} as unknown as RawAccess);
		commits++;
		return result;
	};
	const db = { transaction } as unknown as RawAccess;
	return {
		context: { name: "jobs", key: ["tenant-a"], db },
		request: () =>
			new Request("https://queue.test/dequeue", {
				method: "POST",
				headers: { authorization: "token" },
				body: JSON.stringify({ maxMessages: 1, visibilityTimeoutMs: 100 }),
			}),
		commits: () => commits,
		queries: () => queries,
	};
}

describe("bounded queue actor authority", () => {
	it.each([
		"outer",
		"decision",
	] as const)("does not start authorization when the %s timer fires immediately", async (stage) => {
		const f = fixture();
		let calls = 0;
		const original = globalThis.setTimeout;
		const timer = vi.spyOn(globalThis, "setTimeout");
		if (stage === "decision") timer.mockImplementationOnce(original);
		timer.mockImplementationOnce((callback) => {
			callback();
			return 0 as never;
		});
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => {
				calls++;
				return true;
			},
		});
		let result: Response;
		try {
			result = await binding.handle(f.context, f.request());
		} finally {
			timer.mockRestore();
		}
		expect(result.status).toBe(503);
		expect(calls).toBe(0);
		expect(f.queries()).toBe(0);
	});

	it("cancels an unread stream without starting ingress when its timer fires immediately", async () => {
		let cancellations = 0;
		let ingressCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancellations++;
			},
		});
		const timer = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementationOnce((callback) => {
				callback();
				return 0 as never;
			});
		let failure: unknown;
		try {
			await readRivetQueueStream(stream, 1024, undefined, () => {
				ingressCalls++;
				return true;
			});
		} catch (error) {
			failure = error;
		} finally {
			timer.mockRestore();
		}
		expect(failure).toMatchObject({ code: "timeout" });
		expect(ingressCalls).toBe(0);
		expect(cancellations).toBe(1);
	});

	it("contains an ingress abort that throws before the deadline race is built", async () => {
		let cancellations = 0;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancellations++;
			},
		});
		const controller = new AbortController();
		await expect(
			readRivetQueueStream(stream, 1024, controller.signal, () => {
				controller.abort();
				throw new Error("ingress failed");
			}),
		).rejects.toMatchObject({ code: "unverified" });
		expect(cancellations).toBe(1);
	});

	it("does not start authorization when its decision timer cannot be armed", async () => {
		const f = fixture();
		let calls = 0;
		const original = globalThis.setTimeout;
		const timer = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementationOnce(original)
			.mockImplementationOnce(() => {
				throw new Error("decision timer unavailable");
			});
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => {
				calls++;
				return true;
			},
		});
		let result: Response;
		try {
			result = await binding.handle(f.context, f.request());
		} finally {
			timer.mockRestore();
		}
		expect(await result.json()).toEqual({ error: "policy-unavailable" });
		expect(calls).toBe(0);
		expect(f.queries()).toBe(0);
	});

	it("cancels an unread stream without starting ingress when its timer fails", async () => {
		let cancellations = 0;
		let ingressCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancellations++;
			},
		});
		const timer = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementationOnce(() => {
				throw new Error("stream timer unavailable");
			});
		let failure: unknown;
		try {
			await readRivetQueueStream(stream, 1024, undefined, () => {
				ingressCalls++;
				return true;
			});
		} catch (error) {
			failure = error;
		} finally {
			timer.mockRestore();
		}
		expect(failure).toMatchObject({ code: "unavailable" });
		expect(ingressCalls).toBe(0);
		expect(cancellations).toBe(1);
	});

	it("does not start authorization when the outer deadline timer cannot be armed", async () => {
		const f = fixture();
		let authorizeCalls = 0;
		let cancellations = 0;
		const request = new Request("https://queue.test/dequeue", {
			method: "POST",
			duplex: "half",
			body: new ReadableStream({
				cancel() {
					cancellations++;
				},
			}),
		} as RequestInit);
		const timer = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementationOnce(() => {
				throw new Error("timer unavailable");
			});
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => {
				authorizeCalls++;
				return true;
			},
		});
		let result: Response;
		try {
			result = await binding.handle(f.context, request);
		} finally {
			timer.mockRestore();
		}
		expect(await result.json()).toEqual({ error: "request-unavailable" });
		expect(authorizeCalls).toBe(0);
		expect(cancellations).toBe(1);
		expect(f.queries()).toBe(0);
	});
	it("retains slots for early-rejected bodies until cancellation settles and leaves overflow to the host", async () => {
		const f = fixture();
		const cancellations: Array<() => void> = [];
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const request = () =>
			new Request("https://queue.test/dequeue", {
				method: "POST",
				duplex: "half",
				body: new ReadableStream({
					cancel: () =>
						new Promise<void>((resolve) => cancellations.push(resolve)),
				}),
			} as RequestInit);
		const invalid = { ...f.context, name: "foreign" };
		for (const result of await Promise.all(
			Array.from({ length: 32 }, () => binding.handle(invalid, request())),
		))
			expect(result.status).toBe(403);
		expect(cancellations).toHaveLength(32);
		let traps = 0;
		const unaccepted = request();
		const overflow = new Proxy(unaccepted, {
			getPrototypeOf() {
				traps++;
				throw new Error("trap");
			},
		});
		expect(await (await binding.handle(f.context, overflow)).json()).toEqual({
			error: "capacity-exhausted",
		});
		expect(traps).toBe(0);
		void unaccepted.body?.cancel();
		expect(cancellations).toHaveLength(33);
		for (const finish of cancellations) finish();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect((await binding.handle(f.context, f.request())).status).toBe(200);
	});

	it("quarantines a slot when an unread body's cancellation fails", async () => {
		const f = fixture();
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const request = () =>
			new Request("https://queue.test/dequeue", {
				method: "POST",
				duplex: "half",
				body: new ReadableStream({
					cancel: () => Promise.reject(new Error("cancel failed")),
				}),
			} as RequestInit);
		const invalid = { ...f.context, name: "foreign" };
		for (const result of await Promise.all(
			Array.from({ length: 32 }, () => binding.handle(invalid, request())),
		))
			expect(result.status).toBe(403);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(await (await binding.handle(f.context, f.request())).json()).toEqual(
			{ error: "capacity-exhausted" },
		);
		expect(f.commits()).toBe(0);
	});

	it("rolls back rather than dispatching a later SQL statement after expiry", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let release = (_rows: unknown[]) => {};
		let queries = 0;
		let rollbacks = 0;
		const database = {
			transaction: async <T>(run: (tx: RawAccess) => Promise<T>) => {
				try {
					return await run({
						execute: () => {
							queries++;
							return new Promise<unknown[]>((resolve) => {
								release = resolve;
							});
						},
					} as unknown as RawAccess);
				} catch (error) {
					rollbacks++;
					throw error;
				}
			},
		} as unknown as RawAccess;
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const pending = binding.handle({ ...f.context, db: database }, f.request());
		await vi.advanceTimersByTimeAsync(10_001);
		expect((await pending).status).toBe(503);
		release([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(queries).toBe(1);
		expect(rollbacks).toBe(1);
	});

	it("rolls back when the final SQL write completes after expiry", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let finishWrite = (_rows: unknown[]) => {};
		let writes = 0;
		let commits = 0;
		let rollbacks = 0;
		const database = {
			transaction: async <T>(run: (tx: RawAccess) => Promise<T>) => {
				try {
					const result = await run({
						execute: (query: string) => {
							if (query.startsWith("SELECT COUNT"))
								return Promise.resolve([{ n: 0 }]);
							if (query.startsWith("INSERT INTO hobo_queue_messages")) {
								writes++;
								return new Promise<unknown[]>((resolve) => {
									finishWrite = resolve;
								});
							}
							return Promise.resolve([]);
						},
					} as unknown as RawAccess);
					commits++;
					return result;
				} catch (error) {
					rollbacks++;
					throw error;
				}
			},
		} as unknown as RawAccess;
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const request = new Request("https://queue.test/enqueue", {
			method: "POST",
			body: '{"idempotencyKey":"key","body":1}',
		});
		const pending = binding.handle({ ...f.context, db: database }, request);
		await vi.advanceTimersByTimeAsync(0);
		expect(writes).toBe(1);
		await vi.advanceTimersByTimeAsync(10_001);
		expect((await pending).status).toBe(503);
		finishWrite([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(rollbacks).toBe(1);
		expect(commits).toBe(0);
	});

	it("uses its captured timer cleanup after an authority callback replaces it", async () => {
		const f = fixture();
		const original = globalThis.clearTimeout;
		let substitutions = 0;
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => {
				globalThis.clearTimeout = () => {
					substitutions++;
					throw new Error("timer cleanup replaced");
				};
				return true;
			},
		});
		let result: Response;
		try {
			result = await binding.handle(f.context, f.request());
		} finally {
			globalThis.clearTimeout = original;
		}
		expect(result.status).toBe(200);
		expect(substitutions).toBe(0);
	});
	it("contains an accidentally rejected native Promise returned by the synchronous clock", async () => {
		const f = fixture();
		const binding = createRivetQueueActor({
			actorName: "jobs",
			authorize: () => true,
			now: () => Promise.reject(new Error("clock failed")) as never,
		});
		const result = await binding.handle(f.context, f.request());
		expect(result.status).toBe(503);
		expect(await result.json()).toEqual({ error: "clock-unavailable" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.commits()).toBe(0);
	});

	it("does not accept inherited queue request fields or unknown fields", async () => {
		const f = fixture();
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const missing = new Request("https://queue.test/dequeue", {
			method: "POST",
			body: "{}",
		});
		const extra = new Request("https://queue.test/dequeue", {
			method: "POST",
			body: '{"maxMessages":1,"visibilityTimeoutMs":100,"extra":true}',
		});
		const keys = ["maxMessages", "visibilityTimeoutMs"] as const;
		const previous = keys.map((key) =>
			Object.getOwnPropertyDescriptor(Object.prototype, key),
		);
		let missingResult: Response | undefined;
		try {
			Object.defineProperty(Object.prototype, "maxMessages", {
				configurable: true,
				value: 1,
			});
			Object.defineProperty(Object.prototype, "visibilityTimeoutMs", {
				configurable: true,
				value: 100,
			});
			missingResult = await binding.handle(f.context, missing);
		} finally {
			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];
				if (key === undefined) continue;
				const prior = previous[index];
				if (prior === undefined) Reflect.deleteProperty(Object.prototype, key);
				else Object.defineProperty(Object.prototype, key, prior);
			}
		}
		expect(missingResult?.status).toBe(400);
		expect((await binding.handle(f.context, extra)).status).toBe(400);
		expect(f.commits()).toBe(0);
	});

	it("does not let an inherited optional schedule change an enqueue", async () => {
		const f = fixture();
		let inserted: unknown[] | undefined;
		const transaction = async <T>(run: (tx: RawAccess) => Promise<T>) =>
			run({
				execute: async (query: string, ...args: unknown[]) => {
					if (query.startsWith("SELECT COUNT")) return [{ n: 0 }];
					if (query.startsWith("INSERT INTO hobo_queue_messages"))
						inserted = args;
					return [];
				},
			} as unknown as RawAccess);
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const request = new Request("https://queue.test/enqueue", {
			method: "POST",
			body: '{"idempotencyKey":"key","body":1}',
		});
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"availableAtMs",
		);
		let result: Response | undefined;
		try {
			Object.defineProperty(Object.prototype, "availableAtMs", {
				configurable: true,
				value: 9_999,
			});
			result = await binding.handle(
				{ ...f.context, db: { transaction } as unknown as RawAccess },
				request,
			);
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "availableAtMs");
			else Object.defineProperty(Object.prototype, "availableAtMs", previous);
		}
		expect(result?.status).toBe(200);
		expect(inserted?.slice(3)).toEqual([1000, null]);
	});

	it("does not invoke post-transaction authority after a deadline expires", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let finish = (_value: Response) => {};
		let after = 0;
		const database = {
			transaction: () =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		} as unknown as RawAccess;
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: ({ phase }) => {
				if (phase === "after") after++;
				return true;
			},
		});
		const pending = binding.handle({ ...f.context, db: database }, f.request());
		await vi.advanceTimersByTimeAsync(10_001);
		expect((await pending).status).toBe(503);
		finish(Response.json({ messages: [] }));
		await vi.advanceTimersByTimeAsync(0);
		expect(after).toBe(0);
	});
	it("uses captured own-descriptor and proxy checks even when public intrinsics change", () => {
		let traps = 0;
		const options = Object.defineProperty(
			{ actorName: "jobs", now: () => 1000 },
			"authorize",
			{
				enumerable: true,
				get() {
					traps++;
					throw new Error("callback");
				},
			},
		);
		const proxy = new Proxy(
			{ actorName: "jobs", authorize: () => true, now: () => 1000 },
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
		const errors: unknown[] = [];
		try {
			for (const candidate of [options, proxy]) {
				try {
					createRivetQueueActor(candidate as never);
				} catch (error) {
					errors.push(error);
				}
			}
		} finally {
			if (oldValue === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", oldValue);
			if (oldProxy !== undefined)
				Object.defineProperty(types, "isProxy", oldProxy);
		}
		expect(errors).toHaveLength(2);
		expect(errors.every((error) => error instanceof TypeError)).toBe(true);
		expect(traps).toBe(0);
	});

	it("rejects proxied or accessor-backed host options and requests before traps", async () => {
		let traps = 0;
		const options = {
			actorName: "jobs",
			authorize: () => true,
			now: () => 1000,
		};
		const proxy = new Proxy(options, {
			get() {
				traps++;
				throw new Error("get");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("descriptor");
			},
		});
		expect(() => createRivetQueueActor(proxy)).toThrow("queue actor");
		for (const key of ["actorName", "authorize", "now", "verifyIngress"]) {
			const candidate = { ...options };
			Object.defineProperty(candidate, key, {
				enumerable: true,
				get() {
					traps++;
					throw new Error("get");
				},
			});
			expect(() => createRivetQueueActor(candidate)).toThrow("queue actor");
		}
		const f = fixture();
		let calls = 0;
		const binding = createRivetQueueActor({
			...options,
			authorize: () => {
				calls++;
				return true;
			},
		});
		const requestProxy = new Proxy(f.request(), {
			getPrototypeOf() {
				traps++;
				throw new Error("prototype");
			},
		});
		const accessor = f.request();
		Object.defineProperty(accessor, "method", {
			get() {
				traps++;
				throw new Error("get");
			},
		});
		for (const request of [requestProxy, accessor])
			expect((await binding.handle(f.context, request)).status).toBe(400);
		const context = new Proxy(f.context, {
			get() {
				traps++;
				throw new Error("context");
			},
		});
		const key = new Proxy(["tenant-a"], {
			get() {
				traps++;
				throw new Error("key");
			},
		});
		for (const candidate of [context, { ...f.context, key }])
			expect((await binding.handle(candidate, f.request())).status).toBe(403);
		expect(traps).toBe(0);
		expect(calls).toBe(0);
	});

	it("captures callback identities and rechecks the same receiver before and after a transaction", async () => {
		const f = fixture();
		const phases: string[] = [];
		let traps = 0;
		const options = {
			actorName: "jobs",
			allowed: true,
			now() {
				expect(this).toBe(options);
				return 1000;
			},
			authorize(claim: { phase: "before" | "after" }) {
				expect(this).toBe(options);
				phases.push(claim.phase);
				return this.allowed;
			},
		};
		for (const callback of [options.now, options.authorize])
			for (const key of ["call", "bind"])
				Object.defineProperty(callback, key, {
					get() {
						traps++;
						throw new Error("trap");
					},
				});
		const binding = createRivetQueueActor(options);
		options.now = () => {
			throw new Error("substituted");
		};
		options.authorize = () => {
			throw new Error("substituted");
		};
		const result = await binding.handle(f.context, f.request());
		expect(result.status).toBe(200);
		expect(phases).toEqual(["before", "after"]);
		expect(f.commits()).toBe(1);
		expect(traps).toBe(0);
	});

	it("uses captured transaction and executor methods after host callbacks mutate their owners", async () => {
		let substituted = 0;
		let queries = 0;
		const tx = {
			async execute() {
				queries++;
				tx.execute = async () => {
					substituted++;
					return [];
				};
				return [];
			},
		};
		const database = {
			transaction: async <T>(run: (tx: RawAccess) => Promise<T>) =>
				run(tx as unknown as RawAccess),
		};
		const f = fixture();
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: ({ phase }) => {
				if (phase === "before")
					database.transaction = async () => {
						substituted++;
						throw new Error("substituted");
					};
				return true;
			},
		});
		const result = await binding.handle(
			{ ...f.context, db: database as unknown as RawAccess },
			f.request(),
		);
		expect(result.status).toBe(200);
		expect(queries).toBeGreaterThan(1);
		expect(substituted).toBe(0);
	});

	it("withholds a definitive response if authority is lost after commit", async () => {
		const f = fixture();
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: ({ phase }) => phase === "before",
		});
		const result = await binding.handle(f.context, f.request());
		expect(result.status).toBe(503);
		expect(await result.json()).toEqual({ error: "policy-unavailable" });
		expect(f.commits()).toBe(1);
	});

	it("keeps timed-out authorization work in a bounded active slot", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const decisions: ((value: boolean) => void)[] = [];
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () =>
				new Promise<boolean>((resolve) => decisions.push(resolve)),
		});
		const requests = Array.from({ length: 32 }, () =>
			binding.handle(f.context, f.request()),
		);
		await vi.advanceTimersByTimeAsync(10_001);
		for (const result of await Promise.all(requests))
			expect(result.status).toBe(503);
		expect(decisions).toHaveLength(32);
		const overflow = await binding.handle(f.context, f.request());
		expect(await overflow.json()).toEqual({ error: "capacity-exhausted" });
		expect(f.commits()).toBe(0);
		for (const finish of decisions) finish(false);
		await vi.advanceTimersByTimeAsync(0);
	});

	it("keeps timed-out ingress verifiers in their slots and never opens a transaction", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const decisions: ((value: boolean) => void)[] = [];
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
			verifyIngress: () =>
				new Promise<boolean>((resolve) => decisions.push(resolve)),
		});
		const request = () =>
			new Request("https://queue.test/dequeue", {
				method: "POST",
				duplex: "half",
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'{"maxMessages":1,"visibilityTimeoutMs":100}',
							),
						);
						controller.close();
					},
				}),
			} as RequestInit);
		const calls = Array.from({ length: 32 }, () =>
			binding.handle(f.context, request()),
		);
		await vi.advanceTimersByTimeAsync(10_001);
		for (const result of await Promise.all(calls))
			expect(result.status).toBe(503);
		expect(decisions).toHaveLength(32);
		expect(await (await binding.handle(f.context, request())).json()).toEqual({
			error: "capacity-exhausted",
		});
		expect(f.commits()).toBe(0);
		for (const finish of decisions) finish(false);
		await vi.advanceTimersByTimeAsync(0);
	});

	it("keeps a timed-out transaction in its slot until the transaction actually settles", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const transactions: ((result: Response) => void)[] = [];
		const db = {
			transaction: () =>
				new Promise<Response>((resolve) => transactions.push(resolve)),
		} as unknown as RawAccess;
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const calls = Array.from({ length: 32 }, () =>
			binding.handle({ ...f.context, db }, f.request()),
		);
		await vi.advanceTimersByTimeAsync(10_001);
		for (const result of await Promise.all(calls))
			expect(result.status).toBe(503);
		expect(transactions).toHaveLength(32);
		expect(
			await (await binding.handle({ ...f.context, db }, f.request())).json(),
		).toEqual({ error: "capacity-exhausted" });
		for (const finish of transactions) finish(Response.json({ messages: [] }));
		await vi.advanceTimersByTimeAsync(0);
	});

	it("checks cancellation again when a delayed transaction callback starts", async () => {
		vi.useFakeTimers();
		let begin = () => {};
		let queries = 0;
		const db = {
			transaction: <T>(run: (tx: RawAccess) => Promise<T>) =>
				new Promise<T>((resolve, reject) => {
					begin = () => {
						void run({
							execute: async () => {
								queries++;
								return [];
							},
						} as unknown as RawAccess).then(resolve, reject);
					};
				}),
		} as unknown as RawAccess;
		const f = fixture();
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize: () => true,
		});
		const pending = binding.handle({ ...f.context, db }, f.request());
		await vi.advanceTimersByTimeAsync(10_001);
		expect((await pending).status).toBe(503);
		begin();
		await vi.advanceTimersByTimeAsync(0);
		expect(queries).toBe(0);
	});

	it.each([
		true,
		false,
	])("checks monotonic elapsed time after a blocking policy result %s", async (decision) => {
		const f = fixture();
		const binding = createRivetQueueActor({
			actorName: "jobs",
			now: () => 1000,
			authorize() {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_050);
				return decision;
			},
		});
		expect((await binding.handle(f.context, f.request())).status).toBe(503);
		expect(f.commits()).toBe(0);
		expect(f.queries()).toBe(0);
	}, 15_000);
});
