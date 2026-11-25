// biome-ignore-all lint/suspicious/noThenProperty: Hostile thenable responses are deliberate boundary test inputs.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { types as utilTypes } from "node:util";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRivetAsyncKvClient,
	RIVET_ASYNC_KV_CAPABILITIES,
	RIVET_ASYNC_KV_LIMITS,
} from "../src/rivet-kv.js";
import {
	readRivetKvStream,
	rivetKvDeadline,
} from "../src/rivet-kv-boundary.js";
import {
	kvActorKey,
	kvBytes,
	kvFingerprint,
} from "../src/rivet-kv-protocol.js";
import {
	createRivetAsyncKvActor,
	isRivetAsyncKvBinding,
	migrateRivetAsyncKv,
} from "../src/rivet-kv-runtime.js";

const timerHarness = vi.hoisted(() => {
	vi.resetModules();
	const nativeSet = globalThis.setTimeout;
	const nativeClear = globalThis.clearTimeout;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this test scheduler forwards Node timer arguments without changing them.
	const schedule = ((
		handler: (...args: unknown[]) => void,
		timeout?: number,
		...args: unknown[]
	) => {
		const current = globalThis.setTimeout;
		return (current === schedule ? nativeSet : current)(
			handler,
			timeout,
			...args,
		);
	}) as typeof setTimeout;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this test cleanup forwards the matching Node timer handle.
	const cancel = ((handle: ReturnType<typeof setTimeout>) => {
		const current = globalThis.clearTimeout;
		(current === cancel ? nativeClear : current)(handle);
	}) as typeof clearTimeout;
	globalThis.setTimeout = schedule;
	globalThis.clearTimeout = cancel;
	return { nativeSet, nativeClear };
});
globalThis.setTimeout = timerHarness.nativeSet;
globalThis.clearTimeout = timerHarness.nativeClear;

const TEST_DIGEST = `sha256:${"a".repeat(64)}`;
const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const database of databases.splice(0)) database.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

async function fixture(path = ":memory:") {
	const sqlite = new DatabaseSync(path);
	databases.push(sqlite);
	let tail = Promise.resolve();
	const execute = async (query: string, ...args: SQLInputValue[]) =>
		sqlite.prepare(query).all(...args);
	const transaction = async <T>(run: (tx: RawAccess) => Promise<T>) => {
		const before = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await before;
		let begun = false;
		try {
			sqlite.exec("BEGIN IMMEDIATE");
			begun = true;
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the actor uses only execute on a transaction in this fixture.
			const value = await run({ execute } as RawAccess);
			sqlite.exec("COMMIT");
			begun = false;
			return value;
		} catch (error) {
			if (begun) sqlite.exec("ROLLBACK");
			throw error;
		} finally {
			release();
		}
	};
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the actor uses only the execute and transaction members in this fixture.
	const database = { execute, transaction } as RawAccess;
	await migrateRivetAsyncKv(database);
	let allowed = true;
	let verified = true;
	let calls = 0;
	const binding = createRivetAsyncKvActor({
		actorName: "store",
		semanticDigest: `sha256:${"a".repeat(64)}`,
		verifyIngress: ({ actorKey, maxRequestBytes }) =>
			actorKey.join("/") === "tenant/app" &&
			maxRequestBytes === RIVET_ASYNC_KV_LIMITS.requestBytes,
		authorize: ({ actorKey, headers, phase, key }) =>
			allowed &&
			actorKey.join("/") === "tenant/app" &&
			headers.get("authorization") === "test" &&
			(phase === "access" || key !== "blocked"),
	});
	const fetch = async (path: string, init: RequestInit) => {
		calls++;
		const headers = new Headers(init.headers);
		headers.set("authorization", "test");
		return binding.handle(
			{ name: "store", key: ["tenant", "app"], db: database },
			new Request(`https://actor.test${path}`, { ...init, headers }),
		);
	};
	const client = createRivetAsyncKvClient({
		actorId: "actor-1",
		semanticDigest: TEST_DIGEST,
		actorName: "store",
		actorKey: ["tenant", "app"],
		fetch,
		verifyTransport: () => verified,
	});
	return {
		sqlite,
		database,
		binding,
		client,
		fetch,
		calls: () => calls,
		deny: () => {
			allowed = false;
		},
		unverify: () => {
			verified = false;
		},
	};
}

describe("Rivet actor-local async byte storage", () => {
	it("exposes a branded real actor and explicitly declines synchronous WIT and Bindle support", async () => {
		const f = await fixture();
		expect(isRivetAsyncKvBinding(f.binding)).toBe(true);
		expect(isRivetAsyncKvBinding({ ...f.binding })).toBe(false);
		expect(f.binding.capabilities).toEqual(RIVET_ASYNC_KV_CAPABILITIES);
		expect(f.binding.capabilities).toMatchObject({
			get: true,
			set: true,
			delete: true,
			exists: true,
			synchronousWit: false,
			bindleDependencies: false,
			compareAndSet: false,
			durableIdempotency: false,
			automaticRetries: false,
			singleDispatchRequired: true,
		});
	});

	it("binds host authority to the actor incarnation, semantics and exact request", async () => {
		const f = await fixture();
		const observed: import("../src/rivet-kv-runtime.js").RivetAsyncKvAuthorization[] =
			[];
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: (claim) =>
				claim.semanticDigest === TEST_DIGEST &&
				claim.actorKey.join("/") === "tenant/app/epoch-1",
			authorize: (claim) => {
				observed.push(claim);
				return true;
			},
		});
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app", "epoch-1"],
			verifyTransport: (claim) =>
				claim.semanticDigest === TEST_DIGEST &&
				claim.actorKey.join("/") === "tenant/app/epoch-1",
			fetch: (path, init) =>
				binding.handle(
					{ name: "store", key: ["tenant", "app", "epoch-1"], db: f.database },
					new Request(`https://actor.test${path}`, init),
				),
		});
		expect((await client.set("profile", Uint8Array.of(1))).status).toBe("ok");
		expect(observed.map((claim) => claim.phase)).toEqual([
			"access",
			"operation",
			"delivery",
		]);
		expect(
			observed.every(
				(claim) =>
					claim.semanticDigest === TEST_DIGEST &&
					claim.operation === "set" &&
					claim.actorKey.join("/") === "tenant/app/epoch-1" &&
					claim.fingerprint === observed[0]?.fingerprint &&
					claim.requestId === observed[0]?.requestId,
			),
		).toBe(true);
		expect(observed.slice(1).every((claim) => claim.key === "profile")).toBe(
			true,
		);
	});

	it("preserves byte values, missing keys, empty values, Unicode and snapshots", async () => {
		const f = await fixture();
		expect(await f.client.get("")).toEqual({ status: "ok", value: undefined });
		expect(await f.client.exists("")).toEqual({ status: "ok", value: false });
		const bytes = new Uint8Array([0, 255, 128, 1]);
		const pending = f.client.set("😀\u0000", bytes);
		bytes.fill(3);
		expect(await pending).toEqual({ status: "ok", value: undefined });
		expect(await f.client.get("😀\u0000")).toEqual({
			status: "ok",
			value: new Uint8Array([0, 255, 128, 1]),
		});
		expect(await f.client.set("", new Uint8Array())).toEqual({
			status: "ok",
			value: undefined,
		});
		expect(await f.client.get("")).toEqual({
			status: "ok",
			value: new Uint8Array(),
		});
		expect(await f.client.exists("")).toEqual({ status: "ok", value: true });
		expect(await f.client.delete("")).toEqual({
			status: "ok",
			value: undefined,
		});
		expect(await f.client.delete("")).toEqual({
			status: "ok",
			value: undefined,
		});
		expect(await f.client.exists("")).toEqual({ status: "ok", value: false });
	});

	it("matches a bounded two-key state model for every operation", async () => {
		const f = await fixture();
		const values = [undefined, new Uint8Array(), Uint8Array.of(7)] as const;
		const operations = [
			"get",
			"exists",
			"set-empty",
			"set-byte",
			"delete",
		] as const;
		let cases = 0;
		for (const left of values)
			for (const right of values)
				for (const key of ["a", "b"] as const)
					for (const operation of operations) {
						f.sqlite.exec(
							"DELETE FROM hobo_kv_entries; UPDATE hobo_kv_meta SET entries=0,total_bytes=0 WHERE id=1",
						);
						const model = new Map<string, Uint8Array>();
						if (left !== undefined) {
							model.set("a", left);
							expect((await f.client.set("a", left)).status).toBe("ok");
						}
						if (right !== undefined) {
							model.set("b", right);
							expect((await f.client.set("b", right)).status).toBe("ok");
						}
						if (operation === "get")
							expect(await f.client.get(key)).toEqual({
								status: "ok",
								value: model.get(key),
							});
						if (operation === "exists")
							expect(await f.client.exists(key)).toEqual({
								status: "ok",
								value: model.has(key),
							});
						if (operation === "delete") {
							expect((await f.client.delete(key)).status).toBe("ok");
							model.delete(key);
						}
						if (operation === "set-empty" || operation === "set-byte") {
							const value =
								operation === "set-empty" ? new Uint8Array() : Uint8Array.of(3);
							expect((await f.client.set(key, value)).status).toBe("ok");
							model.set(key, value);
						}
						for (const observed of ["a", "b"])
							expect(await f.client.get(observed)).toEqual({
								status: "ok",
								value: model.get(observed),
							});
						cases++;
					}
		expect(cases).toBe(90);
	}, 20_000);

	it("enforces per-key authority before each effect and never sends invalid input", async () => {
		const f = await fixture();
		expect(await f.client.set("blocked", Uint8Array.of(1))).toEqual({
			status: "denied",
			code: "forbidden",
		});
		expect(await f.client.get("blocked")).toEqual({
			status: "denied",
			code: "forbidden",
		});
		const before = f.calls();
		expect(
			await f.client.set(
				"k",
				new Uint8Array(RIVET_ASYNC_KV_LIMITS.valueBytes + 1),
			),
		).toEqual({ status: "denied", code: "invalid-argument" });
		expect(await f.client.get("\ud800")).toEqual({
			status: "denied",
			code: "invalid-argument",
		});
		expect(
			await f.client.get("x".repeat(RIVET_ASYNC_KV_LIMITS.keyBytes + 1)),
		).toEqual({ status: "denied", code: "invalid-argument" });
		expect(f.calls()).toBe(before);
		f.deny();
		expect(await f.client.set("allowed", Uint8Array.of(2))).toEqual({
			status: "denied",
			code: "forbidden",
		});
		expect(
			f.sqlite.prepare("SELECT COUNT(*) AS n FROM hobo_kv_entries").get()?.n,
		).toBe(0);
	});

	it("round-trips the maximum value and rejects malformed wire bytes before an effect", async () => {
		const f = await fixture();
		const maximum = new Uint8Array(RIVET_ASYNC_KV_LIMITS.valueBytes).fill(255);
		expect((await f.client.set("maximum", maximum)).status).toBe("ok");
		expect(await f.client.get("maximum")).toEqual({
			status: "ok",
			value: maximum,
		});
		const requestId = randomUUID();
		const badValue = "not-base64";
		const fingerprint = kvFingerprint(
			TEST_DIGEST,
			"set",
			requestId,
			"bad",
			badValue,
		);
		const response = await f.binding.handle(
			{ name: "store", key: ["tenant", "app"], db: f.database },
			new Request("https://actor.test/set", {
				method: "POST",
				headers: {
					authorization: "test",
					"x-hobo-kv-request-id": requestId,
					"x-hobo-kv-fingerprint": fingerprint,
					"x-hobo-kv-semantic-digest": TEST_DIGEST,
				},
				body: JSON.stringify({ requestId, key: "bad", value: badValue }),
			}),
		);
		expect(response.status).toBe(400);
		expect(await f.client.exists("bad")).toEqual({
			status: "ok",
			value: false,
		});
	});

	it("serializes concurrent updates and survives a SQLite reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-kv-"));
		directories.push(directory);
		const path = join(directory, "actor.sqlite");
		const f = await fixture(path);
		const results = await Promise.all(
			Array.from({ length: 32 }, (_, index) =>
				f.client.set(`k-${index}`, Uint8Array.of(index)),
			),
		);
		expect(results.every((result) => result.status === "ok")).toBe(true);
		expect(
			f.sqlite
				.prepare("SELECT entries,total_bytes FROM hobo_kv_meta WHERE id=1")
				.get(),
		).toMatchObject({ entries: 32, total_bytes: 32 });
		f.sqlite.close();
		databases.splice(databases.indexOf(f.sqlite), 1);
		const reopened = await fixture(path);
		expect(await reopened.client.get("k-31")).toEqual({
			status: "ok",
			value: Uint8Array.of(31),
		});
	});

	it("enforces entry and byte quotas atomically and lets deletion or replacement free capacity", async () => {
		const f = await fixture();
		const insert = f.sqlite.prepare(
			"INSERT INTO hobo_kv_entries(key,value,size) VALUES(?,?,?)",
		);
		const encoded = Buffer.alloc(RIVET_ASYNC_KV_LIMITS.valueBytes, 5).toString(
			"base64",
		);
		const fullCount =
			RIVET_ASYNC_KV_LIMITS.totalValueBytes / RIVET_ASYNC_KV_LIMITS.valueBytes;
		f.sqlite.exec("BEGIN IMMEDIATE");
		for (let index = 0; index < fullCount; index++)
			insert.run(`full-${index}`, encoded, RIVET_ASYNC_KV_LIMITS.valueBytes);
		f.sqlite
			.prepare("UPDATE hobo_kv_meta SET entries=?,total_bytes=? WHERE id=1")
			.run(fullCount, RIVET_ASYNC_KV_LIMITS.totalValueBytes);
		f.sqlite.exec("COMMIT");
		expect(await f.client.set("over", Uint8Array.of(1))).toEqual({
			status: "denied",
			code: "capacity-exhausted",
		});
		expect(await f.client.exists("over")).toEqual({
			status: "ok",
			value: false,
		});
		expect((await f.client.set("full-0", Uint8Array.of(9))).status).toBe("ok");
		expect((await f.client.set("over", Uint8Array.of(1))).status).toBe("ok");
		f.sqlite.exec("DELETE FROM hobo_kv_entries");
		f.sqlite.exec("UPDATE hobo_kv_meta SET entries=0,total_bytes=0 WHERE id=1");
		f.sqlite.exec("BEGIN IMMEDIATE");
		for (let index = 0; index < RIVET_ASYNC_KV_LIMITS.entries; index++)
			insert.run(`entry-${index}`, "", 0);
		f.sqlite
			.prepare("UPDATE hobo_kv_meta SET entries=?,total_bytes=0 WHERE id=1")
			.run(RIVET_ASYNC_KV_LIMITS.entries);
		f.sqlite.exec("COMMIT");
		expect(await f.client.set("last", Uint8Array.of(1))).toEqual({
			status: "denied",
			code: "capacity-exhausted",
		});
		expect((await f.client.delete("entry-0")).status).toBe("ok");
		expect((await f.client.set("last", Uint8Array.of(1))).status).toBe("ok");
	}, 15_000);

	it("rejects accessor descriptors even when their prototype has a value getter", () => {
		let traps = 0;
		const original = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		const actor = {
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			authorize: () => true,
			verifyIngress: () => true,
		};
		const transport = {
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => true,
			fetch: async () => new Response(),
		};
		const key = ["tenant", "app"];
		Object.defineProperty(actor, "authorize", {
			enumerable: true,
			get: () => {
				traps++;
				return () => true;
			},
		});
		Object.defineProperty(transport, "semanticDigest", {
			enumerable: true,
			get: () => {
				traps++;
				return TEST_DIGEST;
			},
		});
		Object.defineProperty(key, "0", {
			enumerable: true,
			get: () => {
				traps++;
				return "tenant";
			},
		});
		let actorRejected = false;
		let transportRejected = false;
		let keyRejected = false;
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get: () => {
				traps++;
				return TEST_DIGEST;
			},
		});
		try {
			try {
				createRivetAsyncKvActor(actor);
			} catch {
				actorRejected = true;
			}
			try {
				createRivetAsyncKvClient(transport);
			} catch {
				transportRejected = true;
			}
			keyRejected = kvActorKey(key) === undefined;
		} finally {
			if (original === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", original);
		}
		expect({ actorRejected, transportRejected, keyRejected, traps }).toEqual({
			actorRejected: true,
			transportRejected: true,
			keyRejected: true,
			traps: 0,
		});
	});

	it("uses a frozen transport receiver and binds the exact request through both verification phases", async () => {
		const f = await fixture();
		let release = () => {};
		let entered = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const seen: import("../src/rivet-kv.js").RivetAsyncKvTransportClaim[] = [];
		let sentBody = "";
		let sentPath = "";
		const transport = {
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			async verifyTransport(
				claim: import("../src/rivet-kv.js").RivetAsyncKvTransportClaim,
			) {
				seen.push(claim);
				if (claim.phase === "dispatch") {
					entered();
					await gate;
				}
				return (
					Object.isFrozen(this) &&
					this.actorId === "actor-1" &&
					claim.receiver === this
				);
			},
			async fetch(path: string, init: RequestInit) {
				sentPath = path;
				sentBody = String(init.body);
				return f.fetch(path, init);
			},
		};
		const client = createRivetAsyncKvClient(transport);
		const pending = client.set("frozen", Uint8Array.of(1));
		await started;
		transport.actorId = "other";
		transport.actorKey[0] = "other";
		release();
		expect((await pending).status).toBe("ok");
		expect(seen.map((claim) => claim.phase)).toEqual(["dispatch", "receipt"]);
		const [first, second] = seen;
		expect(first?.request).toEqual({
			method: "POST",
			path: sentPath,
			redirect: "error",
			byteLength: Buffer.byteLength(sentBody),
			sha256: `sha256:${createHash("sha256").update(sentBody).digest("hex")}`,
		});
		expect(first?.request).toBe(second?.request);
		expect(Object.isFrozen(first?.request)).toBe(true);
		expect(Object.isFrozen(first?.receiver)).toBe(true);
	});

	it("passes frozen null-prototype request and header records after verifier prototype mutation", async () => {
		const fields = [
			"method",
			"headers",
			"body",
			"redirect",
			"signal",
			"credentials",
			"mode",
		] as const;
		const descriptors = fields.map((key) =>
			Object.getOwnPropertyDescriptor(Object.prototype, key),
		);
		let traps = 0;
		let inspected = false;
		const poison = () => {
			traps++;
			throw new Error("inherited request field");
		};
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => {
				for (const key of fields)
					Object.defineProperty(Object.prototype, key, {
						configurable: true,
						get: poison,
					});
				return true;
			},
			fetch: (_path, init) => {
				const headers = init.headers;
				inspected =
					Object.getPrototypeOf(init) === null &&
					Object.isFrozen(init) &&
					// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: this fixture inspects the transport boundary.
					typeof headers === "object" &&
					headers !== null &&
					Object.getPrototypeOf(headers) === null &&
					Object.isFrozen(headers) &&
					init.method === "POST" &&
					init.redirect === "error" &&
					init.credentials === undefined &&
					init.mode === undefined;
				throw new Error("lost after dispatch");
			},
		});
		let status: string | undefined;
		try {
			status = (await client.set("key", Uint8Array.of(1))).status;
		} finally {
			for (let index = 0; index < fields.length; index++) {
				const key = fields[index];
				if (key === undefined) continue;
				const descriptor = descriptors[index];
				if (descriptor === undefined)
					Reflect.deleteProperty(Object.prototype, key);
				else Object.defineProperty(Object.prototype, key, descriptor);
			}
		}
		expect(status).toBe("unknown");
		expect(inspected).toBe(true);
		expect(traps).toBe(0);
	});

	it("rejects a malformed receipt without reading inherited identity properties", async () => {
		let inheritedReads = 0;
		let requestId = "";
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => true,
			fetch: async (_path, init) => {
				const headers = new Headers(init.headers);
				requestId = headers.get("x-hobo-kv-request-id") ?? "";
				return Response.json({
					fingerprint: headers.get("x-hobo-kv-fingerprint"),
					operation: "get",
					semanticDigest: TEST_DIGEST,
					value: null,
				});
			},
		});
		const original = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"requestId",
		);
		Object.defineProperty(Object.prototype, "requestId", {
			configurable: true,
			get: () => {
				inheritedReads++;
				return requestId;
			},
		});
		let result: Awaited<ReturnType<typeof client.get>>;
		try {
			result = await client.get("k");
		} finally {
			if (original === undefined)
				Reflect.deleteProperty(Object.prototype, "requestId");
			else Object.defineProperty(Object.prototype, "requestId", original);
		}
		expect(result.status).toBe("unknown");
		expect(inheritedReads).toBe(0);
	});

	it("does not treat an inherited error as a committed-write denial", async () => {
		const f = await fixture();
		let inheritedReads = 0;
		const original = Object.getOwnPropertyDescriptor(Object.prototype, "error");
		Object.defineProperty(Object.prototype, "error", {
			configurable: true,
			get: () => {
				inheritedReads++;
				return "capacity-exhausted";
			},
		});
		let result: Awaited<ReturnType<typeof f.client.set>>;
		try {
			result = await f.client.set("k", Uint8Array.of(1));
		} finally {
			if (original === undefined)
				Reflect.deleteProperty(Object.prototype, "error");
			else Object.defineProperty(Object.prototype, "error", original);
		}
		expect(result.status).toBe("ok");
		expect(inheritedReads).toBe(0);
		expect(await f.client.get("k")).toEqual({
			status: "ok",
			value: Uint8Array.of(1),
		});
	});

	it("uses the captured proxy predicate even if the exported predicate changes", () => {
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted proxy");
		};
		const input = new Proxy(
			{
				actorName: "store",
				actorId: "actor-1",
				actorKey: ["tenant", "app"],
				semanticDigest: TEST_DIGEST,
				verifyTransport: () => true,
				fetch: async () => new Response(),
			},
			{ get: fail, getPrototypeOf: fail, getOwnPropertyDescriptor: fail },
		);
		const spy = vi.spyOn(utilTypes, "isProxy").mockReturnValue(false);
		let rejected = false;
		try {
			try {
				createRivetAsyncKvClient(input);
			} catch {
				rejected = true;
			}
		} finally {
			spy.mockRestore();
		}
		expect(rejected).toBe(true);
		expect(traps).toBe(0);
	});

	it("captures the request, actor context, database and callback receiver before awaiting authority", async () => {
		const f = await fixture();
		let release = () => {};
		let entered = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let otherDatabaseCalls = 0;
		const seen: Array<{
			principal: string | null;
			actorName: string;
			frozen: boolean;
		}> = [];
		const options = {
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			async verifyIngress() {
				entered();
				await gate;
				return this.actorName === "store";
			},
			authorize(
				claim: import("../src/rivet-kv-runtime.js").RivetAsyncKvAuthorization,
			) {
				seen.push({
					principal: claim.headers.get("authorization"),
					actorName: this.actorName,
					frozen: Object.isFrozen(this),
				});
				return (
					claim.headers.get("authorization") === "alice" &&
					this.actorName === "store"
				);
			},
		};
		const binding = createRivetAsyncKvActor(options);
		const requestId = randomUUID();
		const fingerprint = kvFingerprint(
			TEST_DIGEST,
			"set",
			requestId,
			"captured",
			"AQ==",
		);
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				authorization: "alice",
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": fingerprint,
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "captured", value: "AQ==" }),
		});
		const originalDb = { ...f.database };
		const context = { name: "store", key: ["tenant", "app"], db: originalDb };
		const pending = binding.handle(context, request);
		await started;
		expect(request.bodyUsed).toBe(true);
		request.headers.set("authorization", "bob");
		context.name = "other";
		context.key[0] = "other";
		context.db = {
			...f.database,
			transaction: async () => {
				otherDatabaseCalls++;
				throw new Error("wrong database");
			},
		};
		originalDb.transaction = async () => {
			otherDatabaseCalls++;
			throw new Error("mutated database method");
		};
		options.actorName = "other";
		release();
		expect((await pending).status).toBe(200);
		expect(otherDatabaseCalls).toBe(0);
		expect(seen).toHaveLength(3);
		expect(
			seen.every(
				(item) =>
					item.principal === "alice" &&
					item.actorName === "store" &&
					item.frozen,
			),
		).toBe(true);
		expect(await f.client.get("captured")).toEqual({
			status: "ok",
			value: Uint8Array.of(1),
		});
	});

	it("uses captured Request and URL accessors after a prior callback replaces them", async () => {
		const f = await fixture();
		const NativeURL = globalThis.URL;
		const requestFields = ["body", "headers", "method", "url"] as const;
		const urlFields = ["pathname", "search", "hash"] as const;
		const requestDescriptors = requestFields.map((key) =>
			Object.getOwnPropertyDescriptor(Request.prototype, key),
		);
		const urlDescriptors = urlFields.map((key) =>
			Object.getOwnPropertyDescriptor(NativeURL.prototype, key),
		);
		let traps = 0;
		let changed = false;
		const poison = () => {
			traps++;
			throw new Error("replaced accessor");
		};
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: () => {
				if (!changed) {
					changed = true;
					for (const key of requestFields)
						Object.defineProperty(Request.prototype, key, {
							configurable: true,
							get: poison,
						});
					for (const key of urlFields)
						Object.defineProperty(NativeURL.prototype, key, {
							configurable: true,
							get: poison,
						});
					Object.defineProperty(globalThis, "URL", {
						value: poison,
						configurable: true,
						writable: true,
					});
				}
				return true;
			},
		});
		const makeRequest = (key: string) => {
			const requestId = randomUUID();
			return new Request("https://actor.test/set", {
				method: "POST",
				headers: {
					"x-hobo-kv-request-id": requestId,
					"x-hobo-kv-fingerprint": kvFingerprint(
						TEST_DIGEST,
						"set",
						requestId,
						key,
						"AQ==",
					),
					"x-hobo-kv-semantic-digest": TEST_DIGEST,
				},
				body: JSON.stringify({ requestId, key, value: "AQ==" }),
			});
		};
		const first = makeRequest("first");
		const second = makeRequest("second");
		let firstStatus = 0;
		let secondStatus = 0;
		try {
			firstStatus = (
				await binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					first,
				)
			).status;
			secondStatus = (
				await binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					second,
				)
			).status;
		} finally {
			globalThis.URL = NativeURL;
			for (let index = 0; index < requestFields.length; index++) {
				const key = requestFields[index];
				const descriptor = requestDescriptors[index];
				if (key !== undefined && descriptor !== undefined)
					Object.defineProperty(Request.prototype, key, descriptor);
			}
			for (let index = 0; index < urlFields.length; index++) {
				const key = urlFields[index];
				const descriptor = urlDescriptors[index];
				if (key !== undefined && descriptor !== undefined)
					Object.defineProperty(NativeURL.prototype, key, descriptor);
			}
		}
		expect(firstStatus).toBe(200);
		expect(secondStatus).toBe(200);
		expect(traps).toBe(0);
	});

	it("retires an unread request body before releasing a denied actor request", async () => {
		const f = await fixture();
		let release = () => {};
		let canceled = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cancellation = new Promise<void>((resolve) => {
			canceled = resolve;
		});
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: () => false,
		});
		const requestId = randomUUID();
		const fingerprint = kvFingerprint(
			TEST_DIGEST,
			"set",
			requestId,
			"k",
			"AQ==",
		);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node accepts duplex for an explicitly streaming request body.
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": fingerprint,
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: new ReadableStream({
				cancel: () => {
					canceled();
					return gate;
				},
			}),
			duplex: "half",
		} as RequestInit);
		let settled = false;
		const pending = binding.handle(
			{ name: "store", key: ["tenant", "app"], db: f.database },
			request,
		);
		void pending.then(() => {
			settled = true;
		});
		await cancellation;
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		expect((await pending).status).toBe(403);
	});

	it("latches actor expiry before a delayed authorization can start a transaction", async () => {
		const f = await fixture();
		let release = (_value: boolean) => {};
		let entered = () => {};
		let actorTimer = () => {};
		let transactions = 0;
		const gate = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: ({ phase }) => {
				if (phase === "access") return true;
				entered();
				return gate;
			},
		});
		const requestId = randomUUID();
		const fingerprint = kvFingerprint(
			TEST_DIGEST,
			"set",
			requestId,
			"k",
			"AQ==",
		);
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": fingerprint,
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k", value: "AQ==" }),
		});
		const database = {
			...f.database,
			transaction: async () => {
				transactions++;
				throw new Error("transaction must not start");
			},
		};
		const original = globalThis.setTimeout;
		let first = true;
		const spy = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((handler, timeout, ...args) => {
				if (first) {
					first = false;
					actorTimer = () => handler();
				}
				return original(handler, timeout, ...args);
			});
		try {
			const pending = binding.handle(
				{ name: "store", key: ["tenant", "app"], db: database },
				request,
			);
			await started;
			actorTimer();
			expect((await pending).status).toBe(503);
			release(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(transactions).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	it("leaves overflow request bodies to the bounded host ingress", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		let transactions = 0;
		let cancellations = 0;
		const database = {
			...f.database,
			transaction: () => {
				transactions++;
				return new Promise<never>(() => {});
			},
		};
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: () => true,
		});
		const call = (key: string) => {
			const requestId = randomUUID();
			const fingerprint = kvFingerprint(
				TEST_DIGEST,
				"set",
				requestId,
				key,
				"AQ==",
			);
			return binding.handle(
				{ name: "store", key: ["tenant", "app"], db: database },
				new Request("https://actor.test/set", {
					method: "POST",
					headers: {
						"x-hobo-kv-request-id": requestId,
						"x-hobo-kv-fingerprint": fingerprint,
						"x-hobo-kv-semantic-digest": TEST_DIGEST,
					},
					body: JSON.stringify({ requestId, key, value: "AQ==" }),
				}),
			);
		};
		const pending = Array.from({ length: 64 }, (_, index) =>
			call(`a-${index}`),
		);
		await vi.advanceTimersByTimeAsync(0);
		pending.push(
			...Array.from({ length: 64 }, (_, index) => call(`b-${index}`)),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(transactions).toBe(128);

		for (let i = 0; i < 256; i++) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node accepts duplex for an explicitly streaming body.
			const extra = new Request("https://actor.test/set", {
				method: "POST",
				body: new ReadableStream({
					cancel: () => {
						cancellations++;
					},
				}),
				duplex: "half",
			} as RequestInit);
			expect(
				(
					await binding.handle(
						{ name: "store", key: ["tenant", "app"], db: database },
						extra,
					)
				).status,
			).toBe(503);
			expect(extra.bodyUsed).toBe(false);
			expect(cancellations).toBe(i);
			await extra.body?.cancel();
			expect(cancellations).toBe(i + 1);
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(cancellations).toBe(256);
		expect(transactions).toBe(128);

		await vi.advanceTimersByTimeAsync(10_001);
		expect(
			(await Promise.all(pending)).every((result) => result.status === 503),
		).toBe(true);
	});

	it("retains a reserved actor slot while a failed request capture is retiring", async () => {
		const f = await fixture();
		let release = () => {};
		let allCanceled = () => {};
		let cancellations = 0;
		let ingress = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const canceled = new Promise<void>((resolve) => {
			allCanceled = resolve;
		});
		const context = { name: "store", key: ["tenant", "app"], db: f.database };
		const requests = Array.from({ length: 128 }, () => {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node accepts duplex for an explicitly streaming request.
			return new Request("https://actor.test/set", {
				method: "POST",
				duplex: "half",
				body: new ReadableStream<Uint8Array>(
					{
						cancel() {
							if (++cancellations === 128) allCanceled();
							return gate;
						},
					},
					{ highWaterMark: 0 },
				),
			} as RequestInit);
		});
		const NativeHeaders = globalThis.Headers;
		let failing = false;
		class FailingHeaders extends NativeHeaders {
			constructor(init?: HeadersInit) {
				super(init);
				if (failing) throw new Error("headers capture failed");
			}
		}
		globalThis.Headers = FailingHeaders;
		vi.resetModules();
		let createActor: typeof createRivetAsyncKvActor;
		try {
			({ createRivetAsyncKvActor: createActor } = await import(
				"../src/rivet-kv-runtime.js"
			));
		} finally {
			globalThis.Headers = NativeHeaders;
			vi.resetModules();
		}
		failing = true;
		const binding = createActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				ingress++;
				return false;
			},
			authorize: () => true,
		});
		for (const request of requests)
			expect((await binding.handle(context, request)).status).toBe(503);

		await canceled;
		let traps = 0;
		const overflow = new Proxy(
			new Request("https://actor.test/get", { method: "POST" }),
			{
				get() {
					traps++;
					throw new Error("must not inspect overflow");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("must not inspect overflow");
				},
			},
		);
		for (let i = 0; i < 256; i++)
			expect((await binding.handle(context, overflow)).status).toBe(503);
		expect(traps).toBe(0);
		expect(cancellations).toBe(128);
		release();
		failing = false;
		for (let i = 0; i < 8; i++) await Promise.resolve();
		const requestId = randomUUID();
		const request = new Request("https://actor.test/get", {
			method: "POST",
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": kvFingerprint(
					TEST_DIGEST,
					"get",
					requestId,
					"k",
				),
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k" }),
		});
		expect(
			(
				await binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					request,
				)
			).status,
		).toBe(503);
		expect(ingress).toBe(1);
	});

	it("quarantines an actor slot if request transfer leaves ownership unknown", async () => {
		const f = await fixture();
		let ingress = 0;
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				ingress++;
				return true;
			},
			authorize: () => true,
		});
		const context = { name: "store", key: ["tenant", "app"], db: f.database };
		for (let i = 0; i < 128; i++) {
			const request = new Request("https://actor.test/set", {
				method: "POST",
				body: "already used",
			});
			await request.text();
			expect((await binding.handle(context, request)).status).toBe(503);
		}
		let traps = 0;
		const overflow = new Proxy(
			new Request("https://actor.test/get", { method: "POST" }),
			{
				get() {
					traps++;
					throw new Error("must not inspect overflow");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("must not inspect overflow");
				},
			},
		);
		expect((await binding.handle(context, overflow)).status).toBe(503);
		expect(traps).toBe(0);
		expect(ingress).toBe(0);
	});

	it.each([
		{ stage: "transaction", kind: "frozen" },
		{ stage: "transaction", kind: "proxy" },
		{ stage: "transaction", kind: "throw" },
		{ stage: "execute", kind: "frozen" },
		{ stage: "execute", kind: "proxy" },
		{ stage: "execute", kind: "throw" },
	] as const)("quarantines $stage work that starts but becomes $kind", async ({
		stage,
		kind,
	}) => {
		const f = await fixture();
		let calls = 0;
		let traps = 0;
		const never = new Promise<never>(() => {});
		const unavailable =
			kind === "frozen"
				? Object.freeze(never)
				: new Proxy(never, {
						get() {
							traps++;
							throw new Error("proxy trap");
						},
						getPrototypeOf() {
							traps++;
							throw new Error("proxy trap");
						},
					});
		const start = () => {
			calls++;
			if (kind === "throw") throw new Error("started then threw");
			return unavailable;
		};
		const database: RawAccess = {
			...f.database,
			transaction:
				stage === "transaction"
					? start
					: async (run) => {
							const tx: RawAccess = {
								execute: start,
								transaction: async () => {
									throw new Error("unexpected nested transaction");
								},
								close: async () => {},
							};
							return await run(tx);
						},
		};
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: () => true,
		});
		const context = { name: "store", key: ["tenant", "app"], db: database };
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: (path, init) =>
				binding.handle(context, new Request(`https://actor.test${path}`, init)),
		});
		for (let index = 0; index < 128; index++)
			expect(await client.set("key", Uint8Array.of(1))).toMatchObject({
				status: "unknown",
				code: "outcome-unknown",
			});
		const overflow = new Proxy(
			new Request("https://actor.test/set", { method: "POST" }),
			{
				get() {
					traps++;
					throw new Error("overflow inspected");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("overflow inspected");
				},
			},
		);
		expect((await binding.handle(context, overflow)).status).toBe(503);
		expect(calls).toBe(128);
		expect(traps).toBe(0);
	});

	it("quarantines every committed actor operation when native response construction fails", async () => {
		const f = await fixture();
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"headers",
		);
		let committed = 0;
		let poisoned = 0;
		const database: RawAccess = {
			...f.database,
			transaction: async (run) => {
				const result = await f.database.transaction(run);
				committed++;
				return result;
			},
		};
		const restore = () => {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "headers");
			else Object.defineProperty(Object.prototype, "headers", previous);
		};
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: ({ phase }) => {
				if (phase === "delivery") {
					poisoned++;
					Object.defineProperty(Object.prototype, "headers", {
						configurable: true,
						get() {
							throw new Error("poisoned native response dictionary");
						},
					});
				}
				return true;
			},
		});
		const context = { name: "store", key: ["tenant", "app"], db: database };
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async (path, init) => {
				try {
					return await binding.handle(
						context,
						new Request(`https://actor.test${path}`, init),
					);
				} finally {
					restore();
				}
			},
		});
		try {
			for (let index = 0; index < 128; index++)
				expect(await client.set("key", Uint8Array.of(index))).toMatchObject({
					status: "unknown",
					code: "outcome-unknown",
				});
			let traps = 0;
			const overflow = new Proxy(
				new Request("https://actor.test/set", { method: "POST" }),
				{
					get() {
						traps++;
						throw new Error("overflow inspected");
					},
					getPrototypeOf() {
						traps++;
						throw new Error("overflow inspected");
					},
				},
			);
			expect((await binding.handle(context, overflow)).status).toBe(503);
			expect(committed).toBe(128);
			expect(poisoned).toBe(128);
			expect(traps).toBe(0);
		} finally {
			restore();
		}
	});

	it("cannot turn a denied operation into a success with a poisoned native status dictionary", async () => {
		const f = await fixture();
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"status",
		);
		let denied = 0;
		let traps = 0;
		const restore = () => {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "status");
			else Object.defineProperty(Object.prototype, "status", previous);
		};
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: ({ phase }) => {
				if (phase !== "operation") return true;
				denied++;
				Object.defineProperty(Object.prototype, "status", {
					configurable: true,
					get() {
						traps++;
						return 200;
					},
					set() {
						traps++;
					},
				});
				return false;
			},
		});
		const context = { name: "store", key: ["tenant", "app"], db: f.database };
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async (path, init) => {
				try {
					return await binding.handle(
						context,
						new Request(`https://actor.test${path}`, init),
					);
				} finally {
					restore();
				}
			},
		});
		try {
			for (let index = 0; index < 128; index++)
				expect(await client.set("denied", Uint8Array.of(1))).toMatchObject({
					status: "unknown",
					code: "outcome-unknown",
				});
			const overflow = new Proxy(
				new Request("https://actor.test/set", { method: "POST" }),
				{
					get() {
						traps++;
						throw new Error("overflow inspected");
					},
					getPrototypeOf() {
						traps++;
						throw new Error("overflow inspected");
					},
				},
			);
			expect((await binding.handle(context, overflow)).status).toBe(503);
			expect(denied).toBe(128);
			expect(traps).toBe(0);
			expect(
				f.sqlite.prepare("SELECT count(*) AS count FROM hobo_kv_entries").get()
					?.count,
			).toBe(0);
		} finally {
			restore();
		}
	});

	it("reports unknown after a committed write loses its reply, without retrying", async () => {
		const f = await fixture();
		let calls = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async (path, init) => {
				calls++;
				const response = await f.fetch(path, init);
				await response.arrayBuffer();
				throw new Error("lost acknowledgement");
			},
		});
		expect(await client.set("order", Uint8Array.of(7))).toMatchObject({
			status: "unknown",
			code: "outcome-unknown",
		});
		expect(calls).toBe(1);
		expect(await f.client.get("order")).toEqual({
			status: "ok",
			value: Uint8Array.of(7),
		});
	});

	it("returns distinct host-correlatable references for concurrent lost replies", async () => {
		const f = await fixture();
		const seen: Array<{ requestId: string; fingerprint: string }> = [];
		const client = createRivetAsyncKvClient({
			actorId: "private-actor",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: (claim) => {
				if (claim.phase === "dispatch")
					seen.push({
						requestId: claim.requestId,
						fingerprint: claim.fingerprint,
					});
				return true;
			},
			fetch: async (path, init) => {
				const response = await f.fetch(path, init);
				await response.arrayBuffer();
				throw new Error("lost reply");
			},
		});
		const results = await Promise.all([
			client.set("first", Uint8Array.of(1)),
			client.set("second", Uint8Array.of(2)),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"unknown",
			"unknown",
		]);
		for (const result of results) {
			if (result.status !== "unknown") throw new Error("expected uncertainty");
			expect(Reflect.ownKeys(result).sort()).toEqual([
				"code",
				"operation",
				"status",
			]);
			expect(Reflect.ownKeys(result.operation).sort()).toEqual([
				"fingerprint",
				"requestId",
			]);
			expect(Object.isFrozen(result.operation)).toBe(true);
			expect(seen).toContainEqual(result.operation);
		}
		expect(new Set(seen.map((item) => item.fingerprint)).size).toBe(2);
		expect(await f.client.get("first")).toEqual({
			status: "ok",
			value: Uint8Array.of(1),
		});
		expect(await f.client.get("second")).toEqual({
			status: "ok",
			value: Uint8Array.of(2),
		});
	});

	it("marks an immediate post-dispatch throw uncertain and retains its exact reference", async () => {
		let observed: { requestId: string; fingerprint: string } | undefined;
		let started = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: (claim) => {
				observed = {
					requestId: claim.requestId,
					fingerprint: claim.fingerprint,
				};
				return true;
			},
			fetch: () => {
				started++;
				throw new Error("transport threw after starting the operation");
			},
		});
		const result = await client.set("k", Uint8Array.of(1));
		expect(result).toMatchObject({
			status: "unknown",
			code: "outcome-unknown",
			operation: observed,
		});
		expect(started).toBe(1);
	});

	it.each([
		"frozen",
		"proxy",
		"throw",
	] as const)("quarantines an unobservable post-dispatch %s transport", async (kind) => {
		let traps = 0;
		let dispatches = 0;
		const source = new Promise<Response>(() => {});
		const unobservable =
			kind === "frozen"
				? Object.freeze(source)
				: new Proxy(source, {
						get() {
							traps++;
							throw new Error("promise trap");
						},
						getPrototypeOf() {
							traps++;
							throw new Error("promise prototype trap");
						},
					});
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => true,
			fetch: () => {
				dispatches++;
				if (kind === "throw") throw new Error("started then lost");
				return unobservable;
			},
		});
		for (let index = 0; index < 128; index++)
			expect((await client.set("key", Uint8Array.of(1))).status).toBe(
				"unknown",
			);
		expect(await client.get("key")).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(dispatches).toBe(128);
		expect(traps).toBe(0);
	});

	it("uses captured timer cleanup after the transport replaces the global", async () => {
		vi.resetModules();
		const { createRivetAsyncKvClient: createClient } = await import(
			"../src/rivet-kv.js"
		);
		const original = globalThis.clearTimeout;
		let cleanup: ReturnType<typeof vi.spyOn> | undefined;
		const client = createClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: () => {
				cleanup = vi
					.spyOn(globalThis, "clearTimeout")
					.mockImplementation((handle) => {
						original(handle);
						throw new Error("timer cleanup failed");
					});
				throw new Error("transport started then lost the reply");
			},
		});
		try {
			const result = await client.set("k", Uint8Array.of(1));
			expect(result).toMatchObject({
				status: "unknown",
				code: "outcome-unknown",
			});
			expect(cleanup).toBeDefined();
			expect(cleanup).not.toHaveBeenCalled();
		} finally {
			cleanup?.mockRestore();
			vi.resetModules();
		}
	});

	it("uses captured reflection for actor keys, bytes and option descriptors", () => {
		const extra = Object.assign(["tenant", "app"], { extra: true });
		const fake = Object.assign(Object.create(Array.prototype), {
			0: "tenant",
			1: "app",
			length: 2,
		});
		const wrongPrototype = ["tenant", "app"];
		Object.setPrototypeOf(wrongPrototype, Object.create(Array.prototype));
		const accessor = ["tenant", "app"];
		let getters = 0;
		Object.defineProperty(accessor, "0", {
			enumerable: true,
			get: () => {
				getters++;
				return "tenant";
			},
		});
		const bytes = Uint8Array.of(1);
		Object.setPrototypeOf(bytes, Object.create(Uint8Array.prototype));
		const options = {
			get actorName() {
				getters++;
				return "store";
			},
			semanticDigest: TEST_DIGEST,
			authorize: () => true,
			verifyIngress: () => true,
		};
		const transport = {
			actorName: "store",
			get actorId() {
				getters++;
				return "actor-1";
			},
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			fetch: async () => new Response(),
			verifyTransport: () => true,
		};
		const ownKeys = Reflect.ownKeys;
		const isArray = Array.isArray;
		const getPrototype = Object.getPrototypeOf;
		const descriptor = Object.getOwnPropertyDescriptor;
		const results: unknown[] = [];
		try {
			Reflect.ownKeys = (value) =>
				value === extra ? ["0", "1", "length"] : ownKeys(value);
			Reflect.set(
				Array,
				"isArray",
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: this fixture replaces a built-in predicate that accepts arbitrary values.
				(value: unknown) => value === fake || isArray(value),
			);
			Object.getPrototypeOf = (value) =>
				value === wrongPrototype
					? Array.prototype
					: value === bytes
						? Uint8Array.prototype
						: getPrototype(value);
			Object.getOwnPropertyDescriptor = (value, key) => {
				if (
					(value === accessor && key === "0") ||
					(value === options && key === "actorName") ||
					(value === transport && key === "actorId")
				)
					return {
						configurable: true,
						enumerable: true,
						writable: true,
						value:
							value === transport
								? "actor-1"
								: value === options
									? "store"
									: "tenant",
					};
				return descriptor(value, key);
			};
			results.push(
				kvActorKey(extra),
				kvActorKey(fake),
				kvActorKey(wrongPrototype),
				kvActorKey(accessor),
				kvBytes(bytes, 8),
			);
			try {
				createRivetAsyncKvActor(options);
				results.push("accepted actor");
			} catch {
				results.push("rejected actor");
			}
			try {
				createRivetAsyncKvClient(transport);
				results.push("accepted client");
			} catch {
				results.push("rejected client");
			}
		} finally {
			Reflect.ownKeys = ownKeys;
			Reflect.set(Array, "isArray", isArray);
			Object.getPrototypeOf = getPrototype;
			Object.getOwnPropertyDescriptor = descriptor;
		}
		expect(results).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"rejected actor",
			"rejected client",
		]);
		expect(getters).toBe(0);
	});

	it("freezes dispatch claims with captured intrinsics after global replacement", async () => {
		const freeze = Object.freeze;
		const isFrozen = Object.isFrozen;
		let protectedClaim = false;
		try {
			Object.freeze = <T>(value: T): Readonly<T> => value;
			const client = createRivetAsyncKvClient({
				actorName: "store",
				actorId: "actor-1",
				actorKey: ["tenant", "app"],
				semanticDigest: TEST_DIGEST,
				fetch: async () => new Response(),
				verifyTransport: (claim) => {
					protectedClaim =
						isFrozen(claim) &&
						isFrozen(claim.actorKey) &&
						isFrozen(claim.request) &&
						isFrozen(claim.receiver);
					return false;
				},
			});
			await client.set("k", Uint8Array.of(1));
		} finally {
			Object.freeze = freeze;
		}
		expect(protectedClaim).toBe(true);
	});

	it("does not start background work when deadline timer setup fails", async () => {
		let approvals = 0;
		let dispatched = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => {
				approvals++;
				return true;
			},
			fetch: async () => {
				dispatched++;
				return new Response();
			},
		});
		const original = globalThis.setTimeout;
		let first = true;
		const setup = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((handler, timeout, ...args) => {
				if (first) {
					first = false;
					throw new Error("timer unavailable");
				}
				return original(handler, timeout, ...args);
			});
		try {
			expect(await client.set("k", Uint8Array.of(1))).toEqual({
				status: "denied",
				code: "unavailable",
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(approvals).toBe(0);
			expect(dispatched).toBe(0);
		} finally {
			setup.mockRestore();
		}
	});

	it("does not start actor work when its deadline timer cannot be armed", async () => {
		const f = await fixture();
		const requestId = randomUUID();
		const fingerprint = kvFingerprint(
			TEST_DIGEST,
			"set",
			requestId,
			"k",
			"AQ==",
		);
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				authorization: "test",
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": fingerprint,
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k", value: "AQ==" }),
		});
		const original = globalThis.setTimeout;
		let first = true;
		const setup = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((handler, timeout, ...args) => {
				if (first) {
					first = false;
					throw new Error("timer unavailable");
				}
				return original(handler, timeout, ...args);
			});
		try {
			expect(
				(
					await f.binding.handle(
						{ name: "store", key: ["tenant", "app"], db: f.database },
						request,
					)
				).status,
			).toBe(503);
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			setup.mockRestore();
		}
		expect(await f.client.exists("k")).toEqual({ status: "ok", value: false });
	});

	it.each([
		"throw",
		"immediate",
	] as const)("does not start client authority work when its inner timer is %s", async (mode) => {
		let approvals = 0;
		let dispatched = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => {
				approvals++;
				return false;
			},
			fetch: async () => {
				dispatched++;
				return new Response();
			},
		});
		const original = globalThis.setTimeout;
		let timers = 0;
		const setup = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((handler, timeout, ...args) => {
				timers++;
				if (timers === 2) {
					if (mode === "throw") throw new Error("inner timer unavailable");
					handler(...args);
					return original(() => {}, 60_000);
				}
				return original(handler, timeout, ...args);
			});
		try {
			for (let i = 0; i < 70; i++) {
				timers = 0;
				expect(await client.set(`k${i}`, Uint8Array.of(1))).toEqual({
					status: "denied",
					code: "unavailable",
				});
			}
			await Promise.resolve();
			await Promise.resolve();
			expect(approvals).toBe(0);
			expect(dispatched).toBe(0);
		} finally {
			setup.mockRestore();
		}
		await client.get("healthy");
		expect(approvals).toBe(1);
	});

	it.each([
		"throw",
		"immediate",
	] as const)("does not start actor authority work when its inner timer is %s", async (mode) => {
		const f = await fixture();
		let ingress = 0;
		let approvals = 0;
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				ingress++;
				return true;
			},
			authorize: () => {
				approvals++;
				return false;
			},
		});
		const makeRequest = () => {
			const requestId = randomUUID();
			return new Request("https://actor.test/set", {
				method: "POST",
				headers: {
					"x-hobo-kv-request-id": requestId,
					"x-hobo-kv-fingerprint": kvFingerprint(
						TEST_DIGEST,
						"set",
						requestId,
						"k",
						"AQ==",
					),
					"x-hobo-kv-semantic-digest": TEST_DIGEST,
				},
				body: JSON.stringify({ requestId, key: "k", value: "AQ==" }),
			});
		};
		const original = globalThis.setTimeout;
		let timers = 0;
		const setup = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((handler, timeout, ...args) => {
				timers++;
				if (timers === 2) {
					if (mode === "throw") throw new Error("inner timer unavailable");
					handler(...args);
					return original(() => {}, 60_000);
				}
				return original(handler, timeout, ...args);
			});
		try {
			for (let i = 0; i < 70; i++) {
				const request = makeRequest();
				timers = 0;
				expect(
					(
						await binding.handle(
							{ name: "store", key: ["tenant", "app"], db: f.database },
							request,
						)
					).status,
				).toBe(503);
			}
			await Promise.resolve();
			await Promise.resolve();
			expect(ingress).toBe(0);
			expect(approvals).toBe(0);
		} finally {
			setup.mockRestore();
		}
		expect(
			(
				await binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					makeRequest(),
				)
			).status,
		).toBe(403);
		expect(ingress).toBe(1);
		expect(approvals).toBe(1);
		expect(await f.client.exists("k")).toEqual({ status: "ok", value: false });
	});

	it.each([
		"throw",
		"immediate",
	] as const)("retires a client response without a pull when stream timer setup is %s", async (mode) => {
		let pulls = 0;
		let cancellations = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					pulls++;
				},
				cancel() {
					cancellations++;
				},
			},
			{ highWaterMark: 0 },
		);
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async () => new Response(body),
		});
		const original = globalThis.setTimeout;
		let timers = 0;
		const setup = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((handler, timeout, ...args) => {
				timers++;
				if (timers === 3) {
					if (mode === "throw") throw new Error("stream timer unavailable");
					handler(...args);
					return original(() => {}, 60_000);
				}
				return original(handler, timeout, ...args);
			});
		try {
			expect((await client.get("k")).status).toBe("unknown");
			expect(timers).toBe(3);
			expect(pulls).toBe(0);
			expect(cancellations).toBe(1);
		} finally {
			setup.mockRestore();
		}
	});

	it.each([
		"throw",
		"immediate",
	] as const)("retires an actor request before a database effect when stream timer setup is %s", async (mode) => {
		const f = await fixture();
		let pulls = 0;
		let cancellations = 0;
		let transactions = 0;
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: () => true,
		});
		const database = {
			...f.database,
			transaction: () => {
				transactions++;
				throw new Error("must not execute");
			},
		};
		const requestId = randomUUID();
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node accepts duplex for an explicitly streaming request.
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": kvFingerprint(
					TEST_DIGEST,
					"set",
					requestId,
					"k",
					"AQ==",
				),
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: new ReadableStream<Uint8Array>(
				{
					pull() {
						pulls++;
					},
					cancel() {
						cancellations++;
					},
				},
				{ highWaterMark: 0 },
			),
			duplex: "half",
		} as RequestInit);
		const original = globalThis.setTimeout;
		let timers = 0;
		const setup = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((handler, timeout, ...args) => {
				timers++;
				if (timers === 4) {
					if (mode === "throw") throw new Error("stream timer unavailable");
					handler(...args);
					return original(() => {}, 60_000);
				}
				return original(handler, timeout, ...args);
			});
		try {
			expect(
				(
					await binding.handle(
						{ name: "store", key: ["tenant", "app"], db: database },
						request,
					)
				).status,
			).toBe(503);
			expect(timers).toBe(4);
			expect(transactions).toBe(0);
			expect(cancellations).toBe(1);

			expect(pulls).toBeLessThanOrEqual(1);
		} finally {
			setup.mockRestore();
		}
	});

	it.each([
		"aborted",
		"addEventListener",
		"removeEventListener",
	] as const)("rejects a request signal with an own %s accessor without touching it", async (field) => {
		const f = await fixture();
		let traps = 0;
		const request = new Request("https://actor.test/get", {
			method: "POST",
			body: "{}",
		});
		Object.defineProperty(request.signal, field, {
			configurable: true,
			get() {
				traps++;
				throw new Error("signal accessor");
			},
		});
		expect(
			(
				await f.binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					request,
				)
			).status,
		).toBe(503);
		expect(request.bodyUsed).toBe(false);
		expect(traps).toBe(0);
	});

	it.each([
		"method",
		"url",
		"headers",
		"body",
		"signal",
	] as const)("rejects a request with an own %s accessor without touching it", async (field) => {
		const f = await fixture();
		let traps = 0;
		const request = new Request("https://actor.test/get", {
			method: "POST",
			body: "{}",
		});
		Object.defineProperty(request, field, {
			configurable: true,
			get() {
				traps++;
				throw new Error("request accessor");
			},
		});
		expect(
			(
				await f.binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					request,
				)
			).status,
		).toBe(503);
		expect(request.bodyUsed).toBe(false);
		expect(traps).toBe(0);
	});

	it("relays real aborts through a private actor signal after owner mutation", async () => {
		const f = await fixture();
		let entered = () => {};
		let approve = (_value: boolean) => {};
		let traps = 0;
		let transactions = 0;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const decision = new Promise<boolean>((resolve) => {
			approve = resolve;
		});
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				entered();
				return decision;
			},
			authorize: () => true,
		});
		const database = {
			...f.database,
			transaction: () => {
				transactions++;
				throw new Error("must not start");
			},
		};
		const source = new AbortController();
		const requestId = randomUUID();
		const request = new Request("https://actor.test/set", {
			method: "POST",
			signal: source.signal,
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": kvFingerprint(
					TEST_DIGEST,
					"set",
					requestId,
					"k",
					"AQ==",
				),
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k", value: "AQ==" }),
		});
		const originalSignal = request.signal;
		const pending = binding.handle(
			{ name: "store", key: ["tenant", "app"], db: database },
			request,
		);
		await started;
		for (const field of ["aborted", "addEventListener", "removeEventListener"])
			Object.defineProperty(originalSignal, field, {
				configurable: true,
				get() {
					traps++;
					throw new Error("mutated signal");
				},
			});
		source.abort();
		approve(true);
		expect((await pending).status).toBe(503);
		expect(transactions).toBe(0);
		expect(traps).toBe(0);
	});

	it("uses the captured controller abort after its prototype method is replaced", async () => {
		const f = await fixture();
		let entered = () => {};
		let approve = (_value: boolean) => {};
		let transactions = 0;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const decision = new Promise<boolean>((resolve) => {
			approve = resolve;
		});
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				entered();
				return decision;
			},
			authorize: () => true,
		});
		const database = {
			...f.database,
			transaction: () => {
				transactions++;
				throw new Error("must not start");
			},
		};
		const requestId = randomUUID();
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": kvFingerprint(
					TEST_DIGEST,
					"set",
					requestId,
					"k",
					"AQ==",
				),
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k", value: "AQ==" }),
		});
		const pending = binding.handle(
			{ name: "store", key: ["tenant", "app"], db: database },
			request,
		);
		await started;
		const abort = vi
			.spyOn(AbortController.prototype, "abort")
			.mockImplementation(() => {});
		try {
			request.signal.dispatchEvent(new Event("abort"));
			approve(true);
			expect((await pending).status).toBe(503);
			expect(transactions).toBe(0);
		} finally {
			abort.mockRestore();
		}
	});

	it.each([
		"throw",
		"no-op",
	] as const)("latches a %s abort failure and quarantines every affected actor slot", async (failure) => {
		const f = await fixture();
		let entered = () => {};
		let approve = (_value: boolean) => {};
		let transactions = 0;
		const database = {
			...f.database,
			transaction: () => {
				transactions++;
				throw new Error("must not start");
			},
		};
		const abort = vi
			.spyOn(AbortController.prototype, "abort")
			.mockImplementation(() => {
				if (failure === "throw") throw new Error("abort unavailable");
			});
		vi.resetModules();
		try {
			const { createRivetAsyncKvActor: createActor } = await import(
				"../src/rivet-kv-runtime.js"
			);
			const binding = createActor({
				actorName: "store",
				semanticDigest: TEST_DIGEST,
				verifyIngress: () => {
					entered();
					return new Promise<boolean>((resolve) => {
						approve = resolve;
					});
				},
				authorize: () => true,
			});
			for (let index = 0; index < 128; index++) {
				const started = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const requestId = randomUUID();
				const request = new Request("https://actor.test/set", {
					method: "POST",
					headers: {
						"x-hobo-kv-request-id": requestId,
						"x-hobo-kv-fingerprint": kvFingerprint(
							TEST_DIGEST,
							"set",
							requestId,
							"k",
							"AQ==",
						),
						"x-hobo-kv-semantic-digest": TEST_DIGEST,
					},
					body: JSON.stringify({ requestId, key: "k", value: "AQ==" }),
				});
				const result = binding.handle(
					{ name: "store", key: ["tenant", "app"], db: database },
					request,
				);
				await started;
				request.signal.dispatchEvent(new Event("abort"));
				approve(true);
				expect((await result).status).toBe(503);
			}
			let traps = 0;
			const overflow = new Proxy(new Request("https://actor.test"), {
				get() {
					traps++;
					throw new Error("must not inspect");
				},
			});
			expect(
				(
					await binding.handle(
						{ name: "store", key: ["tenant", "app"], db: database },
						overflow,
					)
				).status,
			).toBe(503);
			expect(transactions).toBe(0);
			expect(traps).toBe(0);
		} finally {
			abort.mockRestore();
			vi.resetModules();
		}
	});

	it("does not start a transaction when signal prototype methods conceal an abort", async () => {
		const f = await fixture();
		let entered = () => {};
		let approve = (_value: boolean) => {};
		let transactions = 0;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const decision = new Promise<boolean>((resolve) => {
			approve = resolve;
		});
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				entered();
				return decision;
			},
			authorize: () => true,
		});
		const database = {
			...f.database,
			transaction: () => {
				transactions++;
				throw new Error("must not start");
			},
		};
		const requestId = randomUUID();
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": kvFingerprint(
					TEST_DIGEST,
					"set",
					requestId,
					"k",
					"AQ==",
				),
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k", value: "AQ==" }),
		});
		const aborted = Object.getOwnPropertyDescriptor(
			AbortSignal.prototype,
			"aborted",
		);
		const listener = Object.getOwnPropertyDescriptor(
			AbortSignal.prototype,
			"addEventListener",
		);
		if (aborted === undefined) throw new Error("missing native abort getter");
		try {
			Object.defineProperty(AbortSignal.prototype, "aborted", {
				configurable: true,
				get: () => false,
			});
			Object.defineProperty(AbortSignal.prototype, "addEventListener", {
				configurable: true,
				value: () => {},
			});
			const result = binding.handle(
				{ name: "store", key: ["tenant", "app"], db: database },
				request,
			);
			await started;
			request.signal.dispatchEvent(new Event("abort"));
			approve(true);
			expect((await result).status).toBe(503);
		} finally {
			Object.defineProperty(AbortSignal.prototype, "aborted", aborted);
			if (listener === undefined)
				Reflect.deleteProperty(AbortSignal.prototype, "addEventListener");
			else
				Object.defineProperty(
					AbortSignal.prototype,
					"addEventListener",
					listener,
				);
		}
		expect(transactions).toBe(0);
	});

	it("uses the captured controller signal getter after prototype replacement", async () => {
		const original = Object.getOwnPropertyDescriptor(
			AbortController.prototype,
			"signal",
		);
		if (original === undefined)
			throw new Error("missing native controller signal getter");
		let traps = 0;
		let decisions = 0;
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => {
				decisions++;
				return false;
			},
			fetch: async () => new Response(),
		});
		try {
			Object.defineProperty(AbortController.prototype, "signal", {
				configurable: true,
				get() {
					traps++;
					throw new Error("signal getter replaced");
				},
			});
			expect(await client.get("k")).toEqual({
				status: "denied",
				code: "unavailable",
			});
		} finally {
			Object.defineProperty(AbortController.prototype, "signal", original);
		}
		expect(traps).toBe(0);
		expect(decisions).toBe(1);
	});

	it("does not expose its private deadline signal to the transport", async () => {
		let traps = 0;
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => true,
			fetch: async (_path, init) => {
				if (!init.signal) throw new Error("missing transport signal");
				for (const field of [
					"aborted",
					"addEventListener",
					"removeEventListener",
				])
					Object.defineProperty(init.signal, field, {
						configurable: true,
						get() {
							traps++;
							throw new Error("transport signal accessor");
						},
					});
				const headers = new Headers(init.headers);
				return Response.json({
					requestId: headers.get("x-hobo-kv-request-id"),
					fingerprint: headers.get("x-hobo-kv-fingerprint"),
					operation: "get",
					semanticDigest: TEST_DIGEST,
					value: null,
				});
			},
		});
		expect(await client.get("k")).toEqual({ status: "ok", value: undefined });
		expect(traps).toBe(0);
	});

	it.each([
		"pending",
		"rejected",
	] as const)("returns promptly and retains capacity when timer setup fails and cancellation is %s", async (mode) => {
		const f = await fixture();
		let cancellations = 0;
		let ingress = 0;
		let allCanceled = () => {};
		const canceled = new Promise<void>((resolve) => {
			allCanceled = resolve;
		});
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				ingress++;
				return true;
			},
			authorize: () => true,
		});
		const setup = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
			throw new Error("timer unavailable");
		});
		try {
			for (let i = 0; i < 128; i++) {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node accepts duplex for an explicitly streaming request.
				const request = new Request("https://actor.test/set", {
					method: "POST",
					duplex: "half",
					body: new ReadableStream<Uint8Array>(
						{
							cancel() {
								if (++cancellations === 128) allCanceled();
								if (mode === "rejected") throw new Error("cancellation failed");
								return new Promise<void>(() => {});
							},
						},
						{ highWaterMark: 0 },
					),
				} as RequestInit);
				expect(
					(
						await binding.handle(
							{ name: "store", key: ["tenant", "app"], db: f.database },
							request,
						)
					).status,
				).toBe(503);
			}
			await canceled;
		} finally {
			setup.mockRestore();
		}
		let traps = 0;
		const overflow = new Proxy(
			new Request("https://actor.test/get", { method: "POST" }),
			{
				get() {
					traps++;
					throw new Error("must not inspect overflow");
				},
			},
		);
		expect(
			(
				await binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					overflow,
				)
			).status,
		).toBe(503);
		expect(traps).toBe(0);
		expect(cancellations).toBe(128);
		expect(ingress).toBe(0);
	});

	it("rejects uninspectable actor contexts and database capabilities before request transfer", async () => {
		const f = await fixture();
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted actor input");
		};
		const proxiedContext = new Proxy(
			{ name: "store", key: ["tenant", "app"], db: f.database },
			{ get: fail, getOwnPropertyDescriptor: fail },
		);
		const revoked = Proxy.revocable(
			{ name: "store", key: ["tenant", "app"], db: f.database },
			{},
		);
		revoked.revoke();
		const proxiedKey = new Proxy(["tenant", "app"], {
			get: fail,
			ownKeys: fail,
		});
		const proxiedDb = new Proxy(f.database, {
			get: fail,
			getOwnPropertyDescriptor: fail,
		});
		const accessorDb = Object.defineProperty({}, "transaction", { get: fail });
		const proxyTransaction = new Proxy(() => {}, { apply: fail, get: fail });
		const inherited = Object.create({
			name: "store",
			key: ["tenant", "app"],
			db: f.database,
		});
		const contexts = [
			proxiedContext,
			revoked.proxy,
			{ name: "store", key: proxiedKey, db: f.database },
			{ name: "store", key: ["tenant", "app"], db: proxiedDb },
			{ name: "store", key: ["tenant", "app"], db: accessorDb },
			{
				name: "store",
				key: ["tenant", "app"],
				db: { transaction: proxyTransaction },
			},
			inherited,
		];
		for (const context of contexts) {
			const request = new Request("https://actor.test/get", {
				method: "POST",
				body: "{}",
			});
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed runtime inputs intentionally exercise the public boundary.
			expect(
				(
					await f.binding.handle(
						context as Parameters<typeof f.binding.handle>[0],
						request,
					)
				).status,
			).toBe(503);
			expect(request.bodyUsed).toBe(false);
		}
		expect(traps).toBe(0);
	});

	it.each([
		"proxy",
		"accessor",
	] as const)("does not invoke an uninspectable transaction execute %s", async (kind) => {
		const f = await fixture();
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted execute");
		};
		const transaction = async (
			callback: (tx: RawAccess) => Promise<object>,
		) => {
			const tx =
				kind === "proxy"
					? new Proxy(
							{},
							{
								get: fail,
								getOwnPropertyDescriptor: fail,
							},
						)
					: Object.defineProperty({}, "execute", { get: fail });
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the deliberately invalid transaction exercises refusal before use.
			return callback(tx as RawAccess);
		};
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: () => true,
		});
		const requestId = randomUUID();
		const request = new Request("https://actor.test/get", {
			method: "POST",
			headers: {
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": kvFingerprint(
					TEST_DIGEST,
					"get",
					requestId,
					"k",
				),
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k" }),
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the intentionally malformed transaction exercises the adapter boundary.
		const database = { transaction } as RawAccess;
		const result = await binding.handle(
			{ name: "store", key: ["tenant", "app"], db: database },
			request,
		);
		expect(result.status).toBe(503);
		expect(traps).toBe(0);
		expect(await f.client.exists("k")).toEqual({ status: "ok", value: false });
	});

	it("uses a separate authenticated native context wrapper", async () => {
		const f = await fixture();
		const onRequest = f.binding.actor.config.onRequest;
		if (!onRequest) throw new Error("missing native wrapper");
		let traps = 0;
		const malicious = Object.defineProperty({}, "name", {
			get() {
				traps++;
				throw new Error("untrusted own getter");
			},
		});
		const badRequest = new Request("https://actor.test/get", {
			method: "POST",
			body: "{}",
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: adversarial input exercises the separately hosted native entrypoint.
		expect((await onRequest(malicious as never, badRequest)).status).toBe(503);
		expect(badRequest.bodyUsed).toBe(false);
		expect(traps).toBe(0);
		const nativeContext = Object.create({
			get name() {
				return "store";
			},
			get key() {
				return ["tenant", "app"];
			},
			get db() {
				return f.database;
			},
		});
		const requestId = randomUUID();
		const request = new Request("https://actor.test/get", {
			method: "POST",
			headers: {
				authorization: "test",
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": kvFingerprint(
					TEST_DIGEST,
					"get",
					requestId,
					"k",
				),
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: JSON.stringify({ requestId, key: "k" }),
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this local fixture stands in for the host-authenticated native context.
		expect((await onRequest(nativeContext as never, request)).status).toBe(200);
	});

	it.each([
		{ controller: 1, failure: "throw" },
		{ controller: 1, failure: "no-op" },
		{ controller: 2, failure: "throw" },
		{ controller: 2, failure: "no-op" },
	] as const)("keeps an unjournaled timeout uncertain and quarantines capacity when controller $controller has a $failure", async ({
		controller,
		failure,
	}) => {
		vi.useFakeTimers();
		let verifierEntries = 0;
		let dispatched = 0;
		let approve = (_result: boolean) => {};
		let abortCalls = 0;
		const nativeAbort = AbortController.prototype.abort;
		const abort = vi
			.spyOn(AbortController.prototype, "abort")
			.mockImplementation(function (this: AbortController) {
				abortCalls++;
				if ((abortCalls - 1) % 2 === controller - 1) {
					if (failure === "throw") throw new Error("abort unavailable");
					return;
				}
				nativeAbort.call(this);
			});
		vi.resetModules();
		try {
			const { createRivetAsyncKvClient: createClient } = await import(
				"../src/rivet-kv.js"
			);
			const client = createClient({
				actorId: "actor-1",
				semanticDigest: TEST_DIGEST,
				actorName: "store",
				actorKey: ["tenant", "app"],
				verifyTransport: () => {
					verifierEntries++;
					return new Promise<boolean>((resolve) => {
						approve = resolve;
					});
				},
				fetch: async () => {
					dispatched++;
					return new Response();
				},
			});
			for (let index = 0; index < 128; index++) {
				const pending = client.set("k", Uint8Array.of(1));
				await vi.advanceTimersByTimeAsync(10_001);
				expect(await pending).toMatchObject({
					status: "unknown",
					code: "outcome-unknown",
					operation: {
						requestId: expect.any(String),
						fingerprint: expect.any(String),
					},
				});
				approve(true);
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(await client.set("k", Uint8Array.of(1))).toEqual({
				status: "denied",
				code: "unavailable",
			});
			expect(verifierEntries).toBe(128);
			expect(abortCalls).toBe(256);
			expect(dispatched).toBe(0);
		} finally {
			abort.mockRestore();
			vi.resetModules();
		}
	});

	it("quarantines a timed-out dispatch when the transport abort is a no-op", async () => {
		vi.useFakeTimers();
		let abortCalls = 0;
		let dispatches = 0;
		let cancellations = 0;
		let complete = (_response: Response) => {};
		const nativeAbort = AbortController.prototype.abort;
		const abort = vi
			.spyOn(AbortController.prototype, "abort")
			.mockImplementation(function (this: AbortController) {
				if (abortCalls++ % 2 === 0) nativeAbort.call(this);
			});
		vi.resetModules();
		try {
			const { createRivetAsyncKvClient: createClient } = await import(
				"../src/rivet-kv.js"
			);
			const client = createClient({
				actorId: "actor-1",
				semanticDigest: TEST_DIGEST,
				actorName: "store",
				actorKey: ["tenant", "app"],
				verifyTransport: () => true,
				fetch: () => {
					dispatches++;
					return new Promise<Response>((resolve) => {
						complete = resolve;
					});
				},
			});
			for (let index = 0; index < 128; index++) {
				const pending = client.set("k", Uint8Array.of(1));
				await vi.advanceTimersByTimeAsync(10_001);
				expect(await pending).toMatchObject({
					status: "unknown",
					code: "outcome-unknown",
					operation: {
						requestId: expect.any(String),
						fingerprint: expect.any(String),
					},
				});
				complete(
					new Response(
						new ReadableStream({
							cancel() {
								cancellations++;
							},
						}),
					),
				);
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(await client.set("k", Uint8Array.of(1))).toEqual({
				status: "denied",
				code: "unavailable",
			});
			expect(abortCalls).toBe(256);
			expect(dispatches).toBe(128);
			expect(cancellations).toBe(128);
		} finally {
			abort.mockRestore();
			vi.resetModules();
		}
	});

	it("reports no dispatch on authority timeout and cannot dispatch if it resolves late", async () => {
		vi.useFakeTimers();
		let allow = (_result: boolean) => {};
		let started = 0;
		let enrolled = false;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () =>
				new Promise<boolean>((resolve) => {
					allow = (value) => {
						enrolled = true;
						resolve(value);
					};
				}),
			fetch: async () => {
				started++;
				return new Response();
			},
		});
		const result = client.set("k", Uint8Array.of(1));
		await vi.advanceTimersByTimeAsync(10_001);
		expect(await result).toEqual({ status: "denied", code: "unavailable" });
		expect(enrolled).toBe(false);
		allow(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(enrolled).toBe(true);
		expect(started).toBe(0);
	});

	it("does not redispatch a dropped write over an intervening writer", async () => {
		const f = await fixture();
		let dispatches = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: (claim) =>
				claim.actorId === "actor-1" && claim.singleDispatch === true,
			fetch: async (path, init) => {
				dispatches++;
				const response = await f.fetch(path, init);
				await response.arrayBuffer();
				expect((await f.client.set("race", Uint8Array.of(2))).status).toBe(
					"ok",
				);
				throw new Error("actor.dropped_reply");
			},
		});
		expect((await client.set("race", Uint8Array.of(1))).status).toBe("unknown");
		expect(dispatches).toBe(1);
		expect(await f.client.get("race")).toEqual({
			status: "ok",
			value: Uint8Array.of(2),
		});
	});

	it("refuses a redirect without sending a second POST", async () => {
		let original = 0;
		let redirected = 0;
		const server = createServer((request, response) => {
			if (request.url === "/set") {
				original++;
				response.writeHead(307, { location: "/again" });
			} else {
				redirected++;
				response.writeHead(200);
			}
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the server above listens on a TCP address, not a Unix socket.
			const address = server.address() as AddressInfo | null;
			if (address === null) throw new Error("missing test address");
			const client = createRivetAsyncKvClient({
				actorId: "actor-1",
				semanticDigest: TEST_DIGEST,
				actorName: "store",
				actorKey: ["tenant", "app"],
				verifyTransport: () => true,
				fetch: (path, init) =>
					fetch(`http://127.0.0.1:${address.port}${path}`, init),
			});
			expect((await client.set("redirect", Uint8Array.of(1))).status).toBe(
				"unknown",
			);
			expect(original).toBe(1);
			expect(redirected).toBe(0);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("does not dispatch or disclose after a synchronous authority blocks beyond the monotonic deadline", async () => {
		const f = await fixture();
		const blockPastDeadline = () => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_050);
			return true;
		};
		let dispatched = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: blockPastDeadline,
			fetch: async () => {
				dispatched++;
				return new Response();
			},
		});
		expect(await client.set("late-client", Uint8Array.of(1))).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(dispatched).toBe(0);
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => true,
			authorize: ({ phase }) =>
				phase === "operation" ? blockPastDeadline() : true,
		});
		const requestId = randomUUID();
		const fingerprint = kvFingerprint(
			TEST_DIGEST,
			"set",
			requestId,
			"late-actor",
			"AQ==",
		);
		const response = await binding.handle(
			{ name: "store", key: ["tenant", "app"], db: f.database },
			new Request("https://actor.test/set", {
				method: "POST",
				headers: {
					"x-hobo-kv-request-id": requestId,
					"x-hobo-kv-fingerprint": fingerprint,
					"x-hobo-kv-semantic-digest": TEST_DIGEST,
				},
				body: JSON.stringify({ requestId, key: "late-actor", value: "AQ==" }),
			}),
		);
		expect(response.status).toBe(503);
		expect(await f.client.exists("late-actor")).toEqual({
			status: "ok",
			value: false,
		});
	}, 30_000);

	it("uses native stream and reader intrinsics without invoking accessor overrides", async () => {
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted accessor");
		};
		const make = (chunk: Uint8Array) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunk);
					controller.close();
				},
			});
			Object.defineProperty(body, "getReader", {
				configurable: true,
				get: fail,
			});
			return body;
		};
		const stream = make(Uint8Array.of(3));
		const malformed = make(
			new Proxy(Uint8Array.of(1), { getPrototypeOf: fail, get: fail }),
		);
		const prototype = ReadableStreamDefaultReader.prototype;
		const descriptors = new Map(
			["read", "cancel", "releaseLock"].map((key) => [
				key,
				Object.getOwnPropertyDescriptor(prototype, key),
			]),
		);
		for (const key of descriptors.keys())
			Object.defineProperty(prototype, key, { configurable: true, get: fail });
		try {
			const controller = new AbortController();
			expect(
				await readRivetKvStream(
					stream,
					8,
					controller.signal,
					rivetKvDeadline(controller.signal),
				),
			).toEqual(Uint8Array.of(3));
			await expect(
				readRivetKvStream(
					malformed,
					8,
					controller.signal,
					rivetKvDeadline(controller.signal),
				),
			).rejects.toThrow();
			expect(traps).toBe(0);
		} finally {
			for (const [key, descriptor] of descriptors)
				if (descriptor !== undefined)
					Object.defineProperty(prototype, key, descriptor);
		}
	});

	it("cancels a valid stream already expired before reader acquisition", async () => {
		let canceled = 0;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				canceled++;
			},
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			readRivetKvStream(
				body,
				8,
				controller.signal,
				rivetKvDeadline(controller.signal),
			),
		).rejects.toThrow();
		expect(canceled).toBe(1);
	});

	it.each([
		"throw",
		"immediate",
	] as const)("does not acquire a stream reader when timer setup is %s", async (mode) => {
		const descriptor = Object.getOwnPropertyDescriptor(
			ReadableStream.prototype,
			"getReader",
		);
		if (descriptor === undefined) throw new Error("missing native getReader");
		const native = descriptor.value;
		let acquisitions = 0;
		Object.defineProperty(ReadableStream.prototype, "getReader", {
			...descriptor,
			value(this: ReadableStream, ...args: unknown[]) {
				acquisitions++;
				// oxlint-disable-next-line anti-slop/no-reflect-apply -- The test instruments the captured intrinsic with its original receiver.
				return Reflect.apply(native, this, args);
			},
		});
		vi.resetModules();
		const original = globalThis.setTimeout;
		let armed = false;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the injected scheduler forwards all arguments until this test arms its fault.
		const injected = ((
			handler: (...args: unknown[]) => void,
			timeout?: number,
			...args: unknown[]
		) => {
			if (!armed) return original(handler, timeout, ...args);
			if (mode === "throw") throw new Error("timer unavailable");
			handler(...args);
			return original(() => {}, 60_000);
		}) as typeof setTimeout;
		try {
			globalThis.setTimeout = injected;
			const boundary = await import("../src/rivet-kv-boundary.js");
			globalThis.setTimeout = original;
			let pulls = 0;
			let cancellations = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					pull() {
						pulls++;
					},
					cancel() {
						cancellations++;
					},
				},
				{ highWaterMark: 0 },
			);
			const controller = new AbortController();
			const deadline = boundary.rivetKvDeadline(controller.signal);
			armed = true;
			await expect(
				boundary.readRivetKvStream(body, 8, controller.signal, deadline),
			).rejects.toThrow();
			expect(acquisitions).toBe(0);
			expect(pulls).toBe(0);
			expect(cancellations).toBe(1);
		} finally {
			globalThis.setTimeout = original;
			Object.defineProperty(ReadableStream.prototype, "getReader", descriptor);
			vi.resetModules();
		}
	});

	it("quarantines uninspectable bodies before reader acquisition without running traps", async () => {
		let traps = 0;
		let settled = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted body");
		};
		const bodies = [
			new Proxy(new ReadableStream<Uint8Array>(), {
				get: fail,
				getPrototypeOf: fail,
				ownKeys: fail,
			}),
			Object.create(ReadableStream.prototype),
		];
		for (const body of bodies) {
			const controller = new AbortController();
			void readRivetKvStream(
				body,
				8,
				controller.signal,
				rivetKvDeadline(controller.signal),
			).then(
				() => {
					settled++;
				},
				() => {
					settled++;
				},
			);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(0);
		expect(traps).toBe(0);
	});

	it("uses captured BYOB reader methods and preserves bounded bytes", async () => {
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted accessor");
		};
		const body = new ReadableStream<Uint8Array>({
			type: "bytes",
			start(controller) {
				controller.enqueue(Uint8Array.of(1, 2, 3));
				controller.close();
			},
		});
		Object.defineProperty(body, "getReader", { configurable: true, get: fail });
		const prototype = ReadableStreamBYOBReader.prototype;
		const descriptors = new Map(
			["read", "cancel", "releaseLock"].map((key) => [
				key,
				Object.getOwnPropertyDescriptor(prototype, key),
			]),
		);
		for (const key of descriptors.keys())
			Object.defineProperty(prototype, key, { configurable: true, get: fail });
		try {
			const controller = new AbortController();
			expect(
				await readRivetKvStream(
					body,
					8,
					controller.signal,
					rivetKvDeadline(controller.signal),
				),
			).toEqual(Uint8Array.of(1, 2, 3));
			expect(traps).toBe(0);
		} finally {
			for (const [key, descriptor] of descriptors)
				if (descriptor !== undefined)
					Object.defineProperty(prototype, key, descriptor);
		}
	});

	it("rejects proxy-backed stream chunks without invoking traps at either boundary", async () => {
		const f = await fixture();
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted proxy chunk");
		};
		const stream = () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new Proxy(Uint8Array.of(1), { get: fail, getPrototypeOf: fail }),
					);
					controller.close();
				},
			});
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async () => new Response(stream()),
		});
		expect((await client.get("k")).status).toBe("unknown");
		const requestId = randomUUID();
		const fingerprint = kvFingerprint(
			TEST_DIGEST,
			"set",
			requestId,
			"k",
			"AQ==",
		);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node accepts the duplex field for a streaming request body.
		const request = new Request("https://actor.test/set", {
			method: "POST",
			headers: {
				authorization: "test",
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": fingerprint,
				"x-hobo-kv-semantic-digest": TEST_DIGEST,
			},
			body: stream(),
			duplex: "half",
		} as RequestInit);
		expect(
			(
				await f.binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					request,
				)
			).status,
		).toBe(400);
		expect(traps).toBe(0);
		expect(await f.client.exists("k")).toEqual({ status: "ok", value: false });
	});

	it("does not treat a timed-out in-flight transaction as cancelled", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		let release = () => {};
		let entered = () => {};
		let completed = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const committed = new Promise<void>((resolve) => {
			completed = resolve;
		});
		const database: RawAccess = {
			...f.database,
			transaction: async (run) => {
				const result = await f.database.transaction(async (tx) => {
					const value = await run(tx);
					entered();
					await gate;
					return value;
				});
				completed();
				return result;
			},
		};
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: (path, init) => {
				const headers = new Headers(init.headers);
				headers.set("authorization", "test");
				return f.binding.handle(
					{ name: "store", key: ["tenant", "app"], db: database },
					new Request(`https://actor.test${path}`, { ...init, headers }),
				);
			},
		});
		const writing = client.set("late", Uint8Array.of(6));
		await started;
		await vi.advanceTimersByTimeAsync(10_001);
		expect(await writing).toMatchObject({
			status: "unknown",
			code: "outcome-unknown",
		});
		release();
		await committed;
		vi.useRealTimers();
		expect(await f.client.get("late")).toEqual({
			status: "ok",
			value: Uint8Array.of(6),
		});
	});

	it("does not accept mismatched receipts or an unverified transport", async () => {
		const f = await fixture();
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async (path, init) => {
				const response = await f.fetch(path, init);
				const body = await response.json();
				return Response.json(
					{ ...body, fingerprint: `sha256:${"f".repeat(64)}` },
					{ status: response.status },
				);
			},
		});
		expect(await client.set("k", Uint8Array.of(9))).toMatchObject({
			status: "unknown",
			code: "outcome-unknown",
		});
		expect(await f.client.get("k")).toEqual({
			status: "ok",
			value: Uint8Array.of(9),
		});
		const before = f.calls();
		f.unverify();
		expect(await f.client.get("k")).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(f.calls()).toBe(before);
	});

	it.each([
		"body",
		"status",
		"unchanged",
	] as const)("revalidates the authenticated response %s before disclosure", async (kind) => {
		const f = await fixture();
		expect((await f.client.set("secret", Uint8Array.of(1))).status).toBe("ok");
		let expected:
			| { status: number; byteLength: number; sha256: string }
			| undefined;
		const phases: string[] = [];
		const transportFetch = async (path: string, init: RequestInit) => {
			const real = await f.fetch(path, init);
			const bytes = new Uint8Array(await real.arrayBuffer());
			expected = {
				status: real.status,
				byteLength: bytes.byteLength,
				sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			};
			if (kind === "status") return new Response(bytes, { status: 201 });
			if (kind === "unchanged")
				return new Response(bytes, { status: real.status });
			const tampered = JSON.parse(new TextDecoder().decode(bytes));
			tampered.value = "Ag==";
			return Response.json(tampered, { status: real.status });
		};
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			fetch: transportFetch,
			verifyTransport: (claim) => {
				phases.push(claim.phase);
				if (claim.fetch !== transportFetch) return false;
				if (claim.phase === "dispatch") return true;
				expect(Object.isFrozen(claim.response)).toBe(true);
				return (
					expected !== undefined &&
					claim.response.status === expected.status &&
					claim.response.byteLength === expected.byteLength &&
					claim.response.sha256 === expected.sha256
				);
			},
		});
		expect(await client.get("secret")).toMatchObject(
			kind === "unchanged"
				? { status: "ok", value: Uint8Array.of(1) }
				: { status: "unknown", code: "outcome-unknown" },
		);
		expect(phases).toEqual(["dispatch", "receipt"]);
	});

	it("binds the semantic digest into the request, authority claim and receipt", async () => {
		const f = await fixture();
		let seen = "";
		const wrong = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: `sha256:${"f".repeat(64)}`,
			actorName: "store",
			actorKey: ["tenant", "app"],
			fetch: f.fetch,
			verifyTransport: (claim) => {
				seen = claim.semanticDigest;
				return true;
			},
		});
		expect((await wrong.set("k", Uint8Array.of(1))).status).toBe("unknown");
		expect(seen).toBe(`sha256:${"f".repeat(64)}`);
		expect(await f.client.exists("k")).toEqual({ status: "ok", value: false });
	});

	it("returns unknown when transport authority changes after a committed effect", async () => {
		const f = await fixture();
		let validations = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			fetch: f.fetch,
			verifyTransport: () => ++validations === 1,
		});
		expect(await client.set("k", Uint8Array.of(4))).toMatchObject({
			status: "unknown",
			code: "outcome-unknown",
		});
		expect(await f.client.get("k")).toEqual({
			status: "ok",
			value: Uint8Array.of(4),
		});
	});

	it("does not disclose data or report a definite write when actor authority is revoked after the transaction", async () => {
		const f = await fixture();
		const phases: string[] = [];
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: `sha256:${"a".repeat(64)}`,
			verifyIngress: () => true,
			authorize: ({ phase }) => {
				phases.push(phase);
				return phase !== "delivery";
			},
		});
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: (path, init) =>
				binding.handle(
					{ name: "store", key: ["tenant", "app"], db: f.database },
					new Request(`https://actor.test${path}`, init),
				),
		});
		const write = await client.set("revoked", Uint8Array.of(8));
		const read = await client.get("revoked");
		expect(phases).toEqual([
			"access",
			"operation",
			"delivery",
			"access",
			"operation",
			"delivery",
		]);
		for (const result of [write, read]) {
			if (result.status !== "unknown")
				throw new Error("expected uncertainty after revocation");
			expect(Reflect.ownKeys(result).sort()).toEqual([
				"code",
				"operation",
				"status",
			]);
			expect(Reflect.ownKeys(result.operation).sort()).toEqual([
				"fingerprint",
				"requestId",
			]);
		}
		expect(await f.client.get("revoked")).toEqual({
			status: "ok",
			value: Uint8Array.of(8),
		});
	});

	it("does not release hung transport slots when a client deadline expires", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: () => {
				calls++;
				return new Promise<Response>(() => {});
			},
		});
		const pending = Array.from({ length: 64 }, (_, index) =>
			client.set(`key-${index}`, Uint8Array.of(index)),
		);
		await vi.advanceTimersByTimeAsync(0);
		pending.push(
			...Array.from({ length: 64 }, (_, index) =>
				client.set(`key-${index + 64}`, Uint8Array.of(index)),
			),
		);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(
			(await Promise.all(pending)).every(
				(result) => result.status === "unknown",
			),
		).toBe(true);
		expect(calls).toBe(128);
		expect(await client.get("extra")).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(calls).toBe(128);
	});

	it.each([
		"pending",
		"rejected",
	] as const)("retains capacity when late body cancellation is %s", async (mode) => {
		vi.useFakeTimers();
		let calls = 0;
		let cancels = 0;
		let releaseFetch: (response: Response) => void = () => {};
		let releaseCancel = () => {};
		const cancellation = new Promise<void>((resolve) => {
			releaseCancel = resolve;
		});
		const late = new Promise<Response>((resolve) => {
			releaseFetch = resolve;
		});
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: () => {
				calls++;
				return calls === 1 ? late : new Promise<Response>(() => {});
			},
		});
		const first = client.set("first", Uint8Array.of(1));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_001);
		expect((await first).status).toBe("unknown");
		releaseFetch(
			new Response(
				new ReadableStream({
					cancel: () => {
						cancels++;
						if (mode === "rejected") throw new Error("cancellation failed");
						return cancellation;
					},
				}),
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(cancels).toBe(1);
		const pending = Array.from({ length: 64 }, (_, index) =>
			client.get(`pending-${index}`),
		);
		await vi.advanceTimersByTimeAsync(0);
		pending.push(
			...Array.from({ length: 63 }, (_, index) =>
				client.get(`pending-${index + 64}`),
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(128);
		expect(await client.get("overflow")).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(calls).toBe(128);
		releaseCancel();
		await vi.advanceTimersByTimeAsync(0);
		if (mode === "pending") {
			pending.push(client.get("after-cancel"));
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toBe(129);
		} else {
			expect(await client.get("after-rejection")).toEqual({
				status: "denied",
				code: "unavailable",
			});
			expect(calls).toBe(128);
		}
		await vi.advanceTimersByTimeAsync(10_001);
		expect(
			(await Promise.all(pending)).every(
				(result) => result.status === "unknown",
			),
		).toBe(true);
	});

	it("quarantines a genuine response whose prototype breaks native inspection", async () => {
		let traps = 0;
		let calls = 0;
		let cancellations = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted prototype");
		};
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async () => {
				calls++;
				const response = new Response(
					new ReadableStream({
						cancel: () => {
							cancellations++;
						},
					}),
				);
				/* oxlint-disable unicorn/no-thenable -- This fixture prevents promise assimilation from touching the hostile prototype. */
				Object.defineProperty(response, "then", { value: undefined });
				/* oxlint-enable unicorn/no-thenable */
				Object.setPrototypeOf(
					response,
					new Proxy(Response.prototype, {
						get: fail,
						getPrototypeOf: fail,
						ownKeys: fail,
					}),
				);
				return response;
			},
		});
		for (let batch = 0; batch < 2; batch++) {
			const results = await Promise.all(
				Array.from({ length: 64 }, (_, index) =>
					client.get(`prototype-${batch}-${index}`),
				),
			);
			expect(results.every((result) => result.status === "unknown")).toBe(true);
		}
		expect(calls).toBe(128);
		expect(await client.get("overflow")).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(calls).toBe(128);

		expect(traps).toBe(128);
		expect(cancellations).toBe(0);
	});

	it.each([
		"accessor",
		"callable",
		"non-extensible",
	] as const)("quarantines a %s Response without invoking its then property", async (kind) => {
		let traps = 0;
		let dispatches = 0;
		const replies = Array.from({ length: 128 }, () => {
			const response = new Response("unverified");

			const pending = Promise.resolve(response);
			if (kind === "accessor") {
				// oxlint-disable-next-line unicorn/no-thenable -- SAFETY: this getter must never run.
				Object.defineProperty(response, "then", {
					configurable: true,
					get() {
						traps++;
						throw new Error("then getter");
					},
				});
			} else if (kind === "callable") {
				// oxlint-disable-next-line unicorn/no-thenable -- SAFETY: this method must never run.
				Object.defineProperty(response, "then", {
					configurable: true,
					value() {
						traps++;
						throw new Error("then callback");
					},
				});
			} else Object.preventExtensions(response);
			return pending;
		});
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => true,
			fetch: () => {
				const reply = replies[dispatches++];
				if (reply === undefined) throw new Error("unexpected dispatch");
				return reply;
			},
		});
		for (let index = 0; index < 128; index++)
			expect((await client.get("key")).status).toBe("unknown");
		expect(await client.get("key")).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(dispatches).toBe(128);
		expect(traps).toBe(0);
	});

	it("shadows a replaced Response prototype then before receipt processing", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(
			Response.prototype,
			"then",
		);
		let traps = 0;
		let prepared: Promise<Response> | undefined;
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: (claim) => {
				if (claim.phase === "dispatch") {
					prepared = Promise.resolve(
						Response.json({
							requestId: claim.requestId,
							fingerprint: claim.fingerprint,
							operation: "get",
							semanticDigest: TEST_DIGEST,
							value: null,
						}),
					);
					// oxlint-disable-next-line unicorn/no-thenable -- SAFETY: the accessor must not run.
					Object.defineProperty(Response.prototype, "then", {
						configurable: true,
						get() {
							traps++;
							throw new Error("inherited then");
						},
					});
				}
				return true;
			},
			fetch: () => {
				if (prepared === undefined) throw new Error("missing response");
				return prepared;
			},
		});
		let result: Awaited<ReturnType<typeof client.get>> | undefined;
		try {
			result = await client.get("key");
		} finally {
			if (descriptor === undefined)
				Reflect.deleteProperty(Response.prototype, "then");
			else {
				// oxlint-disable-next-line unicorn/no-thenable -- SAFETY: restore the original descriptor after the adversarial check.
				Object.defineProperty(Response.prototype, "then", descriptor);
			}
		}
		expect(result).toEqual({ status: "ok", value: undefined });
		expect(traps).toBe(0);
	});

	it.each([
		"proxy",
		"forged",
	] as const)("retains capacity for an uninspectable %s response", async (kind) => {
		let traps = 0;
		let thenReads = 0;
		let calls = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted response");
		};
		const client = createRivetAsyncKvClient({
			actorId: "actor-1",
			semanticDigest: TEST_DIGEST,
			actorName: "store",
			actorKey: ["tenant", "app"],
			verifyTransport: () => true,
			fetch: async () => {
				calls++;
				if (kind === "forged") return Object.create(Response.prototype);
				return new Proxy(new Response("secret"), {
					get: (_target, key) => {
						if (key === "then") {
							thenReads++;
							return undefined;
						}
						return fail();
					},
					getPrototypeOf: fail,
					ownKeys: fail,
					getOwnPropertyDescriptor: fail,
				});
			},
		});
		for (let batch = 0; batch < 2; batch++) {
			const results = await Promise.all(
				Array.from({ length: 64 }, (_, index) =>
					client.get(`key-${batch}-${index}`),
				),
			);
			expect(results.every((result) => result.status === "unknown")).toBe(true);
		}
		expect(calls).toBe(128);
		expect(await client.get("extra")).toEqual({
			status: "denied",
			code: "unavailable",
		});
		expect(calls).toBe(128);
		expect(traps).toBe(0);

		if (kind === "proxy") expect(thenReads).toBeGreaterThanOrEqual(128);
		else expect(thenReads).toBe(0);
	});

	it("bounds outstanding host decisions even after their deadlines", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		let decisions = 0;
		const binding = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: `sha256:${"a".repeat(64)}`,
			authorize: () => true,
			verifyIngress: () => {
				decisions++;
				return new Promise<boolean>(() => {});
			},
		});
		const call = () => {
			const requestId = randomUUID();
			const fingerprint = kvFingerprint(TEST_DIGEST, "get", requestId, "key");
			return binding.handle(
				{ name: "store", key: ["tenant", "app"], db: f.database },
				new Request("https://actor.test/get", {
					method: "POST",
					headers: {
						"x-hobo-kv-request-id": requestId,
						"x-hobo-kv-fingerprint": fingerprint,
						"x-hobo-kv-semantic-digest": TEST_DIGEST,
					},
					body: JSON.stringify({ requestId, key: "key" }),
				}),
			);
		};
		const pending = Array.from({ length: 64 }, call);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(
			(await Promise.all(pending)).every((result) => result.status === 503),
		).toBe(true);
		expect(decisions).toBe(64);
		expect((await call()).status).toBe(503);
		expect(decisions).toBe(64);
		expect(
			f.sqlite.prepare("SELECT COUNT(*) AS n FROM hobo_kv_entries").get()?.n,
		).toBe(0);
	});

	it.each([
		"frozen",
		"proxy",
	] as const)("quarantines actor and client authority slots for an unobservable %s promise", async (kind) => {
		const f = await fixture();
		let traps = 0;
		let actorChecks = 0;
		let clientChecks = 0;
		let operations = 0;
		let dispatches = 0;
		const source = new Promise<boolean>(() => {});
		const unobservable =
			kind === "frozen"
				? Object.freeze(source)
				: new Proxy(source, {
						get() {
							traps++;
							throw new Error("promise trap");
						},
						getPrototypeOf() {
							traps++;
							throw new Error("promise prototype trap");
						},
					});
		const actor = createRivetAsyncKvActor({
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			verifyIngress: () => {
				actorChecks++;
				return unobservable;
			},
			authorize: () => {
				operations++;
				return true;
			},
		});
		const client = createRivetAsyncKvClient({
			actorName: "store",
			actorId: "actor-1",
			actorKey: ["tenant", "app"],
			semanticDigest: TEST_DIGEST,
			verifyTransport: () => {
				clientChecks++;
				return unobservable;
			},
			fetch: async () => {
				dispatches++;
				return new Response();
			},
		});
		for (let index = 0; index < 65; index++) {
			const requestId = randomUUID();
			const request = new Request("https://actor.test/get", {
				method: "POST",
				headers: {
					"x-hobo-kv-request-id": requestId,
					"x-hobo-kv-fingerprint": kvFingerprint(
						TEST_DIGEST,
						"get",
						requestId,
						"key",
					),
					"x-hobo-kv-semantic-digest": TEST_DIGEST,
				},
				body: JSON.stringify({ requestId, key: "key" }),
			});
			expect(
				(
					await actor.handle(
						{ name: "store", key: ["tenant", "app"], db: f.database },
						request,
					)
				).status,
			).toBe(503);
			expect(await client.get("key")).toEqual({
				status: "denied",
				code: "unavailable",
			});
		}
		expect(actorChecks).toBe(64);
		expect(clientChecks).toBe(64);
		expect(operations).toBe(0);
		expect(dispatches).toBe(0);
		expect(traps).toBe(0);
	});

	it("rejects proxy-backed bytes and actor keys without executing traps", async () => {
		const f = await fixture();
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted proxy");
		};
		const bytes = new Proxy(Uint8Array.of(1), {
			get: fail,
			getPrototypeOf: fail,
		});
		expect(await f.client.set("key", bytes)).toEqual({
			status: "denied",
			code: "invalid-argument",
		});
		const actorKey = new Proxy(["tenant", "app"], {
			get: fail,
			ownKeys: fail,
			getPrototypeOf: fail,
		});
		expect(() =>
			createRivetAsyncKvClient({
				actorId: "actor-1",
				semanticDigest: TEST_DIGEST,
				actorName: "store",
				actorKey,
				fetch: f.fetch,
				verifyTransport: () => true,
			}),
		).toThrow();
		expect(traps).toBe(0);
		expect(f.calls()).toBe(0);
	});

	it("rejects accessor or proxied actor authorities before invoking them", () => {
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted configuration");
		};
		const options = {
			actorName: "store",
			semanticDigest: TEST_DIGEST,
			authorize: () => true,
			verifyIngress: () => true,
		};
		Object.defineProperty(options, "verifyIngress", { get: fail });
		expect(() => createRivetAsyncKvActor(options)).toThrow();
		const proxy = new Proxy(() => true, { apply: fail });
		expect(() =>
			createRivetAsyncKvActor({
				actorName: "store",
				semanticDigest: TEST_DIGEST,
				authorize: proxy,
				verifyIngress: () => true,
			}),
		).toThrow();
		expect(traps).toBe(0);
	});

	it("fails closed on lost metadata or corrupt persisted values", async () => {
		const f = await fixture();
		expect((await f.client.set("k", Uint8Array.of(1))).status).toBe("ok");
		f.sqlite.exec(
			"UPDATE hobo_kv_entries SET value='not-base64' WHERE key='k'",
		);
		expect((await f.client.get("k")).status).toBe("unknown");
		expect((await f.client.set("k", Uint8Array.of(2))).status).toBe("unknown");
		f.sqlite.exec("DELETE FROM hobo_kv_meta");
		await migrateRivetAsyncKv(f.database);
		expect(
			f.sqlite.prepare("SELECT COUNT(*) AS n FROM hobo_kv_meta").get()?.n,
		).toBe(0);
		expect((await f.client.get("k")).status).toBe("unknown");
	});

	it("rejects in-range accounting corruption before reading or changing data", async () => {
		const f = await fixture();
		expect((await f.client.set("first", Uint8Array.of(1, 2, 3))).status).toBe(
			"ok",
		);
		f.sqlite.exec("UPDATE hobo_kv_meta SET entries=0,total_bytes=0 WHERE id=1");
		expect((await f.client.set("second", Uint8Array.of(4))).status).toBe(
			"unknown",
		);
		expect(
			f.sqlite
				.prepare("SELECT COUNT(*) AS n FROM hobo_kv_entries WHERE key='second'")
				.get()?.n,
		).toBe(0);
		expect((await f.client.get("first")).status).toBe("unknown");
		f.sqlite.exec(
			"UPDATE hobo_kv_meta SET entries=1,total_bytes=1 WHERE id=1; UPDATE hobo_kv_entries SET size=1 WHERE key='first'",
		);
		expect((await f.client.set("second", Uint8Array.of(4))).status).toBe(
			"unknown",
		);
		expect(
			f.sqlite
				.prepare("SELECT COUNT(*) AS n FROM hobo_kv_entries WHERE key='second'")
				.get()?.n,
		).toBe(0);
	});

	it("detects malformed contents when their key is read without claiming a full integrity scan", async () => {
		const f = await fixture();
		expect((await f.client.set("bad", Uint8Array.of(1, 2, 3))).status).toBe(
			"ok",
		);
		expect((await f.client.set("good", Uint8Array.of(8))).status).toBe("ok");
		f.sqlite.exec("UPDATE hobo_kv_entries SET value='!!!!' WHERE key='bad'");
		expect(await f.client.get("good")).toEqual({
			status: "ok",
			value: Uint8Array.of(8),
		});
		expect((await f.client.get("bad")).status).toBe("unknown");
	});

	it("releases the local transaction queue when BEGIN is locked by another connection", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-kv-lock-"));
		directories.push(directory);
		const path = join(directory, "actor.sqlite");
		const f = await fixture(path);
		const other = new DatabaseSync(path);
		databases.push(other);
		other.exec("BEGIN IMMEDIATE");
		expect((await f.client.set("first", Uint8Array.of(1))).status).toBe(
			"unknown",
		);
		other.exec("ROLLBACK");
		expect((await f.client.set("second", Uint8Array.of(2))).status).toBe("ok");
		expect(await f.client.get("second")).toEqual({
			status: "ok",
			value: Uint8Array.of(2),
		});
	});
});
