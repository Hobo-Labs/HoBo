/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-object-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get -- SAFETY: this fixture exercises raw actor HTTP and SQLite boundaries. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { durableMessagingOperation } from "@hobo/core";
import { migrateDurableTopicJournal } from "@hobo/runtime/durable-topic-journal";
import { isStaticActorDefinition } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRivetDurableTopicActor,
	createRivetDurableTopicBusActor,
	isRivetDurableTopicBinding,
	type RivetDurableTopicBusOptions,
} from "../src/durable-topic-actor.js";

const opened: DatabaseSync[] = [];
afterEach(() => {
	for (const sql of opened.splice(0)) sql.close();
});
function sqlite() {
	const sql = new DatabaseSync(":memory:");
	opened.push(sql);
	let tail = Promise.resolve();
	const execute = async (query: string, ...args: SQLInputValue[]) =>
		sql.prepare(query).all(...args);
	const transaction = async <T>(
		run: (tx: RawAccess) => Promise<T>,
	): Promise<T> => {
		const before = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await before;
		sql.exec("BEGIN IMMEDIATE");
		try {
			/* SAFETY: the actor uses only execute on this transaction fixture. */ const value =
				await run({ execute } as RawAccess);
			sql.exec("COMMIT");
			return value;
		} catch (error) {
			try {
				sql.exec("ROLLBACK");
			} catch {}
			throw error;
		} finally {
			release();
		}
	};
	// SAFETY: the actor uses only execute and transaction on this fixture.
	return { sql, db: { execute, transaction } as RawAccess };
}
function canonical(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "number"
	)
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`,
			)
			.join(",")}}`;
	throw new Error("invalid fixture JSON");
}
const op = (nonce: string) =>
	durableMessagingOperation(10_000, nonce.padStart(16, "0"));
async function fixture(options?: {
	resolveScope?: () => { tenant: string; instance: string };
	verifyIngress?: () => boolean;
}) {
	const storage = sqlite();
	await migrateDurableTopicJournal(storage.db);
	let authorized = true;
	let ingress = true;
	let scopeChanged = false;
	const actor = createRivetDurableTopicActor({
		actorName: "orders",
		semanticDigest: `sha256:${"a".repeat(64)}`,
		now: () => 1_000,
		resolveScope: ({ actorKey }) =>
			options?.resolveScope?.() ?? {
				tenant: scopeChanged ? "other" : (actorKey[0] ?? ""),
				instance: "topic",
			},
		authorize: (claim) =>
			authorized &&
			claim.headers.get("authorization") === "test" &&
			claim.actorKey[0] === claim.tenant &&
			claim.instance === "topic" &&
			claim.semanticDigest === `sha256:${"a".repeat(64)}` &&
			claim.requestBase64.length > 0,
		verifyIngress: (claim) =>
			ingress &&
			claim.maxRequestBytes === 131_072 &&
			claim.maxChunkBytes === 65_536 &&
			claim.maxChunks === 4_096 &&
			claim.maxHeaderBytes === 16_384 &&
			(options?.verifyIngress?.() ?? true),
	});
	const send = (
		method: string,
		body: unknown,
		tenant = "tenant",
		authorization = "test",
	) =>
		actor.handle(
			{ name: "orders", key: [tenant], db: storage.db },
			new Request(`https://actor.test/${method}`, {
				method: "POST",
				headers: { authorization, "content-type": "application/json" },
				body: canonical(body),
			}),
		);
	return {
		...storage,
		actor,
		send,
		revoke: () => {
			authorized = false;
		},
		restore: () => {
			authorized = true;
		},
		stopIngress: () => {
			ingress = false;
		},
		changeScope: () => {
			scopeChanged = true;
		},
	};
}
function streamRequest(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	method = "publish",
): Request {
	const init: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: { authorization: "test" },
		body,
		duplex: "half",
	};
	if (signal !== undefined) init.signal = signal;
	return new Request(`https://actor.test/${method}`, init);
}
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		pull(controller) {
			const chunk = chunks.shift();
			if (chunk === undefined) controller.close();
			else controller.enqueue(chunk);
		},
	});
}

describe("Rivet durable topic log actor", () => {
	it("does not accept a forged actor binding through substituted WeakMap methods", async () => {
		const f = await fixture();
		const forged = { ...f.actor };
		const identity = {
			database: Reflect.get(f.actor.actor.config, "db"),
			semanticDigest: f.actor.semanticDigest,
			mode: "log",
		};
		const nativeGet = WeakMap.prototype.get;
		const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
		if (original === undefined) throw new Error("WeakMap.get missing");
		let calls = 0;
		let accepted = false;
		try {
			Object.defineProperty(WeakMap.prototype, "get", {
				...original,
				value<K extends object>(this: WeakMap<K, unknown>, key: K) {
					if (key === forged) {
						calls++;
						return identity;
					}
					return nativeGet.call(this, key);
				},
			});
			accepted = isRivetDurableTopicBinding(forged);
		} finally {
			Object.defineProperty(WeakMap.prototype, "get", original);
		}
		expect(accepted).toBe(false);
		expect(calls).toBe(0);
	});

	it("refuses rejected asynchronous scope and authorization callbacks", async () => {
		const storage = sqlite();
		await migrateDurableTopicJournal(storage.db);
		const reject = () => Promise.reject(new Error("asynchronous callback"));
		const base: RivetDurableTopicBusOptions = {
			actorName: "orders",
			semanticDigest: `sha256:${"a".repeat(64)}`,
			now: () => 1_000,
			resolveScope: () => ({ tenant: "tenant", instance: "topic" }),
			authorize: () => true,
			authorizeInstanceScope: () => true,
			verifyIngress: () => true,
		};
		for (const field of [
			"verifyIngress",
			"resolveScope",
			"authorize",
			"authorizeInstanceScope",
		] as const) {
			const options = { ...base };
			Object.defineProperty(options, field, {
				value: reject,
				enumerable: true,
			});
			const actor = createRivetDurableTopicBusActor(options);
			const response = await actor.handle(
				{ name: "orders", key: ["tenant"], db: storage.db },
				new Request("https://actor.test/events", {
					method: "POST",
					body: JSON.stringify({ afterSequence: 0, limit: 1 }),
				}),
			);
			expect(response.status).toBe(503);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("constructs a real RivetKit actor definition and advertises its limited capability", async () => {
		const f = await fixture();
		expect(isStaticActorDefinition(f.actor.actor)).toBe(true);
		expect(isRivetDurableTopicBinding(f.actor)).toBe(true);
		expect(isRivetDurableTopicBinding({ ...f.actor })).toBe(false);
		expect(f.actor.semanticDigest).toBe(`sha256:${"a".repeat(64)}`);
		expect(Object.isFrozen(f.actor)).toBe(true);
		expect(
			isRivetDurableTopicBinding({
				...f.actor,
				semanticDigest: `sha256:${"b".repeat(64)}`,
			}),
		).toBe(false);
		expect(f.actor.capabilities).toMatchObject({
			publish: true,
			readRetainedLog: true,
			consumerGroups: false,
			leases: false,
			acknowledgement: false,
			deadLetter: false,
			legacyWit: false,
		});
		expect(f.actor.limits).toMatchObject({
			payloadBytes: 8_192,
			attributeBytes: 2_048,
			batchSize: 4,
			retainedMessages: 128,
		});
	});

	it("reads an empty fresh instance but refuses orphaned state without an owner pin", async () => {
		const f = await fixture();
		expect(
			await (await f.send("events", { afterSequence: 0, limit: 4 })).json(),
		).toEqual({
			status: "ok",
			events: [],
			firstAvailableSequence: 1,
			nextAfterSequence: 0,
			hasMore: false,
		});
		expect(
			await (
				await f.send("read-log", {
					topic: "orders",
					afterSequence: 0,
					limit: 4,
				})
			).json(),
		).toEqual({
			status: "rejected",
			code: "not-found",
		});
		expect(
			f.sql.prepare("SELECT count(*) AS count FROM hobo_dm_semantics").get(),
		).toEqual({ count: 0 });
		f.sql
			.prepare(
				"INSERT INTO hobo_dm_topic_state(tenant,instance,value) VALUES(?,?,?)",
			)
			.run(
				"tenant",
				"topic",
				'{"version":1,"topics":[],"messages":[],"events":[],"eventTail":0}',
			);
		expect(
			(await f.send("events", { afterSequence: 0, limit: 4 })).status,
		).toBe(503);
	});

	it("snapshots only exact own-data scopes without invoking accessors or proxies", async () => {
		let calls = 0;
		const volatile = Object.defineProperty(
			{ tenant: "tenant", instance: "topic" },
			"tenant",
			{
				enumerable: true,
				get() {
					calls++;
					return "tenant";
				},
			},
		);
		const f = await fixture({ resolveScope: () => volatile });
		expect(
			(await f.send("events", { afterSequence: 0, limit: 1 })).status,
		).toBe(503);
		expect(calls).toBe(0);
		const proxy = new Proxy(
			{ tenant: "tenant", instance: "topic" },
			{
				getPrototypeOf() {
					calls++;
					throw new Error("proxy invoked");
				},
			},
		);
		const g = await fixture({ resolveScope: () => proxy });
		expect(
			(await g.send("events", { afterSequence: 0, limit: 1 })).status,
		).toBe(503);
		expect(calls).toBe(0);
		const extra = await fixture({
			resolveScope: () => ({
				tenant: "tenant",
				instance: "topic",
				extra: "untrusted",
			}),
		});
		expect(
			(await extra.send("events", { afterSequence: 0, limit: 1 })).status,
		).toBe(503);
	});

	it("bounds ingress chunks and treats a revoked or interrupted stream as unavailable", async () => {
		const f = await fixture();
		const context = { name: "orders", key: ["tenant"], db: f.db };
		let getterCalls = 0;
		const deceptive = new Uint8Array(65_537);
		Object.defineProperty(deceptive, "byteLength", {
			get() {
				getterCalls++;
				return 1;
			},
		});
		expect(
			(await f.actor.handle(context, streamRequest(streamOf([deceptive]))))
				.status,
		).toBe(400);
		expect(getterCalls).toBe(0);
		const proxied = new Proxy(new Uint8Array(1), {
			getPrototypeOf() {
				getterCalls++;
				throw new Error("proxy invoked");
			},
		});
		expect(
			(await f.actor.handle(context, streamRequest(streamOf([proxied]))))
				.status,
		).toBe(400);
		expect(getterCalls).toBe(0);
		expect(
			(
				await f.actor.handle(
					context,
					streamRequest(streamOf([new Uint8Array(new SharedArrayBuffer(1))])),
				)
			).status,
		).toBe(400);
		const goodBody = new TextEncoder().encode(
			canonical({ operation: op("19"), topic: "orders" }),
		);
		class Subclass extends Uint8Array {
			get byteLength(): number {
				getterCalls++;
				throw new Error("shadowed length");
			}
			[Symbol.iterator](): ReturnType<Uint8Array[typeof Symbol.iterator]> {
				getterCalls++;
				throw new Error("shadowed iterator");
			}
		}
		const subclass = new Subclass(goodBody.length);
		Uint8Array.prototype.set.call(subclass, goodBody);
		const validResponse = await f.actor.handle(
			context,
			streamRequest(streamOf([subclass]), undefined, "ensure-topic"),
		);
		expect(await validResponse.json()).toEqual({
			status: "committed",
			value: { topic: "orders" },
		});
		expect(getterCalls).toBe(0);
		expect(
			(
				await f.actor.handle(
					context,
					streamRequest(
						streamOf(Array.from({ length: 4_097 }, () => new Uint8Array())),
					),
				)
			).status,
		).toBe(400);
		let canceled = false;
		const controller = new AbortController();
		const pending = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => {
				canceled = true;
			},
		});
		const response = f.actor.handle(
			context,
			streamRequest(pending, controller.signal),
		);
		await Promise.resolve();
		controller.abort();
		expect((await response).status).toBe(503);
		expect(canceled).toBe(true);
		expect(
			f.sql.prepare("SELECT count(*) AS count FROM hobo_dm_receipts").get(),
		).toEqual({ count: 1 });
		let checks = 0;
		const revoked = await fixture({ verifyIngress: () => ++checks < 3 });
		expect(
			(
				await revoked.actor.handle(
					{ ...context, db: revoked.db },
					streamRequest(streamOf([new TextEncoder().encode("{}")])),
				)
			).status,
		).toBe(503);
		expect(
			revoked.sql
				.prepare("SELECT count(*) AS count FROM hobo_dm_receipts")
				.get(),
		).toEqual({ count: 0 });
	});

	it("preserves all in-profile attribute keys and bounds maximum request, log and audit pages", async () => {
		const f = await fixture();
		const limits = f.actor.limits;
		const encodedName = limits.nameBytes * 6 + 2;
		const encodedAttributes =
			limits.attributeBytes * 6 + limits.attributeCount * 64;
		const encodedPayload = Math.ceil(limits.payloadBytes / 3) * 4;
		const encodedMessage =
			3 * encodedName + encodedAttributes + encodedPayload + 256;
		const encodedEvent = 2 * encodedName + 256;
		const encodedTopic = encodedName + 256;
		expect(
			limits.retainedMessages * encodedMessage +
				limits.retainedEvents * encodedEvent +
				limits.topics * encodedTopic +
				4096,
		).toBeLessThanOrEqual(4_194_304);
		expect(limits.batchSize * encodedMessage + 4096).toBeLessThanOrEqual(
			262_144,
		);
		expect(limits.eventPageSize * encodedEvent + 4096).toBeLessThanOrEqual(
			262_144,
		);
		expect(encodedMessage + 4096).toBeLessThanOrEqual(131_072);
		const topic = "\\".repeat(128);
		const messageId = (index: number) =>
			`m-${String(index).padStart(3, "0")}`.padEnd(128, "\\");
		await f.send("ensure-topic", { operation: op("100"), topic });
		const attributes = [
			{ key: "\u0000key", value: "control" },
			{ key: "x".repeat(129), value: "long" },
			{ key: "k", value: "\u0000".repeat(1_903) },
		];
		const payload = Buffer.alloc(8_192, 0xff).toString("base64");
		const subject = "\\".repeat(128);
		const request = {
			operation: op("101"),
			topic,
			message: { id: messageId(0), subject, payload, attributes },
		};
		expect(Buffer.byteLength(canonical(request))).toBeLessThanOrEqual(131_072);
		const first = await (await f.send("publish", request)).json();
		expect(first).toEqual({
			status: "committed",
			value: { messageId: messageId(0), sequence: 1 },
		});
		expect(await (await f.send("publish", request)).json()).toEqual(first);
		for (let index = 1; index < 4; index++) {
			const result = await f.send("publish", {
				...request,
				operation: op(String(101 + index)),
				message: { ...request.message, id: messageId(index) },
			});
			expect((await result.json()).status).toBe("committed");
		}
		const logText = await (
			await f.send("read-log", { topic, afterSequence: 0, limit: 4 })
		).text();
		expect(Buffer.byteLength(logText)).toBeLessThanOrEqual(262_144);
		const page = JSON.parse(logText);
		expect(page.messages).toHaveLength(4);
		for (const [index, message] of page.messages.entries())
			expect(message).toEqual({
				topic,
				sequence: index + 1,
				id: messageId(index),
				subject,
				payload,
				attributes,
			});
		for (let index = 4; index < 99; index++) {
			const result = await f.send("publish", {
				operation: op(String(200 + index)),
				topic,
				message: { id: messageId(index), subject, payload: "", attributes: [] },
			});
			expect((await result.json()).status).toBe("committed");
		}
		const auditText = await (
			await f.send("events", { afterSequence: 0, limit: 100 })
		).text();
		expect(Buffer.byteLength(auditText)).toBeLessThanOrEqual(262_144);
		const audit = JSON.parse(auditText);
		expect(audit.events).toHaveLength(100);
		expect(audit.nextAfterSequence).toBe(100);
		expect(audit.hasMore).toBe(false);
	});

	it("publishes, reads, compacts and reports retained-history gaps", async () => {
		const f = await fixture();
		expect(
			await (
				await f.send("ensure-topic", { operation: op("1"), topic: "orders" })
			).json(),
		).toEqual({ status: "committed", value: { topic: "orders" } });
		const publication = {
			operation: op("2"),
			topic: "orders",
			message: {
				id: "m",
				subject: "created",
				payload: "AAH/",
				attributes: [{ key: "type", value: "binary" }],
			},
		};
		expect(await (await f.send("publish", publication)).json()).toEqual({
			status: "committed",
			value: { messageId: "m", sequence: 1 },
		});
		expect(await (await f.send("publish", publication)).json()).toEqual({
			status: "committed",
			value: { messageId: "m", sequence: 1 },
		});
		const page = await (
			await f.send("read-log", { topic: "orders", afterSequence: 0, limit: 4 })
		).json();
		expect(page).toMatchObject({
			status: "ok",
			firstAvailableSequence: 1,
			nextAfterSequence: 1,
			hasMore: false,
			messages: [{ topic: "orders", sequence: 1, id: "m", payload: "AAH/" }],
		});
		expect(
			await (
				await f.send("compact", {
					operation: op("3"),
					topic: "orders",
					throughSequence: 1,
				})
			).json(),
		).toEqual({
			status: "committed",
			value: { topic: "orders", firstAvailableSequence: 2, removedMessages: 1 },
		});
		expect(
			await (
				await f.send("read-log", {
					topic: "orders",
					afterSequence: 0,
					limit: 4,
				})
			).json(),
		).toEqual({ status: "gap", firstAvailableSequence: 2, latestSequence: 1 });
		expect(
			await (
				await f.send("publish", { ...publication, operation: op("4") })
			).json(),
		).toEqual({ status: "committed", value: { messageId: "m", sequence: 2 } });
		const audit = await (
			await f.send("events", { afterSequence: 0, limit: 10 })
		).json();
		expect(audit).toMatchObject({
			status: "ok",
			events: [
				{ sequence: 1, kind: "topic-created", topic: "orders" },
				{ sequence: 2, kind: "published", messageId: "m" },
				{ sequence: 3, kind: "compacted" },
				{ sequence: 4, kind: "published", messageId: "m" },
			],
		});
	});

	it("durably rejects unsupported group operations without claiming bus semantics", async () => {
		const f = await fixture();
		const request = {
			operation: op("5"),
			subscription: {
				topic: "orders",
				consumerGroup: "g",
				deadLetterTopic: "dlq",
				maxDeliveryAttempts: 2,
				startAt: "earliest",
			},
		};
		expect(await (await f.send("ensure-subscription", request)).json()).toEqual(
			{ status: "rejected", code: "unsupported" },
		);
		expect(await (await f.send("ensure-subscription", request)).json()).toEqual(
			{ status: "rejected", code: "unsupported" },
		);
		expect(
			await (
				await f.send("ensure-subscription", {
					...request,
					subscription: { ...request.subscription, consumerGroup: "other" },
				})
			).json(),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		for (const [index, method] of ["consume", "ack", "nack"].entries()) {
			const body = {
				operation: op(String(20 + index)),
				topic: "orders",
				consumerGroup: "g",
			};
			const result = { status: "rejected", code: "unsupported" };
			expect(await (await f.send(method, body)).json()).toEqual(result);
			expect(await (await f.send(method, body)).json()).toEqual(result);
		}
	});

	it("fences malformed-wire markers after receipt lookup for every operation", async () => {
		const f = await fixture();
		const create = { operation: op("30"), topic: "orders" };
		const poisonedCreate = { ...create, __hobo_invalid_request: true };
		expect(await (await f.send("ensure-topic", poisonedCreate)).json()).toEqual(
			{ status: "rejected", code: "invalid-argument" },
		);
		expect(await (await f.send("ensure-topic", poisonedCreate)).json()).toEqual(
			{ status: "rejected", code: "invalid-argument" },
		);
		expect(await (await f.send("ensure-topic", create)).json()).toEqual({
			status: "rejected",
			code: "operation-conflict",
		});
		const validCreate = { ...create, operation: op("31") };
		const committed = { status: "committed", value: { topic: "orders" } };
		expect(await (await f.send("ensure-topic", validCreate)).json()).toEqual(
			committed,
		);
		expect(
			await (
				await f.send("ensure-topic", {
					...validCreate,
					__hobo_invalid_request: true,
				})
			).json(),
		).toEqual({ status: "rejected", code: "operation-conflict" });
		expect(await (await f.send("ensure-topic", validCreate)).json()).toEqual(
			committed,
		);
		const publication = {
			operation: op("32"),
			topic: "orders",
			message: { id: "m", subject: "s", payload: "AA==", attributes: [] },
		};
		expect(
			await (
				await f.send("publish", {
					...publication,
					__hobo_invalid_request: true,
				})
			).json(),
		).toEqual({ status: "rejected", code: "invalid-argument" });
		expect(await (await f.send("publish", publication)).json()).toEqual({
			status: "rejected",
			code: "operation-conflict",
		});
		expect(
			await (
				await f.send("compact", {
					operation: op("33"),
					topic: "orders",
					throughSequence: 0,
					__hobo_invalid_request: true,
				})
			).json(),
		).toEqual({ status: "rejected", code: "invalid-argument" });
		for (const [index, method] of [
			"ensure-subscription",
			"consume",
			"ack",
			"nack",
		].entries()) {
			const body = {
				operation: op(String(34 + index)),
				__hobo_invalid_request: true,
			};
			expect(await (await f.send(method, body)).json()).toEqual({
				status: "rejected",
				code: "unsupported",
			});
			expect(await (await f.send(method, body)).json()).toEqual({
				status: "rejected",
				code: "unsupported",
			});
		}
		expect(
			await (
				await f.send("read-log", {
					topic: "orders",
					afterSequence: 0,
					limit: 1,
					__hobo_invalid_request: true,
				})
			).json(),
		).toEqual({ status: "rejected", code: "invalid-argument" });
		expect(
			await (
				await f.send("events", {
					afterSequence: 0,
					limit: 1,
					__hobo_invalid_request: true,
				})
			).json(),
		).toEqual({ status: "rejected", code: "invalid-argument" });
		expect(
			await (
				await f.send("read-log", {
					topic: "orders",
					afterSequence: 0,
					limit: 1,
				})
			).json(),
		).toMatchObject({ status: "ok", messages: [] });
		expect(
			await (await f.send("events", { afterSequence: 0, limit: 10 })).json(),
		).toMatchObject({
			status: "ok",
			events: [{ kind: "topic-created", topic: "orders" }],
		});
	});

	it("isolates authenticated tenant scopes and fails closed on revoked authority", async () => {
		const f = await fixture();
		await f.send(
			"ensure-topic",
			{ operation: op("6"), topic: "orders" },
			"tenant",
		);
		await f.send(
			"ensure-topic",
			{ operation: op("6"), topic: "orders" },
			"other",
		);
		await f.send(
			"publish",
			{
				operation: op("7"),
				topic: "orders",
				message: {
					id: "m",
					subject: "created",
					payload: "AQ==",
					attributes: [],
				},
			},
			"tenant",
		);
		expect(
			await (
				await f.send(
					"read-log",
					{ topic: "orders", afterSequence: 0, limit: 4 },
					"other",
				)
			).json(),
		).toMatchObject({ status: "ok", messages: [] });
		expect(
			(
				await f.send(
					"read-log",
					{ topic: "orders", afterSequence: 0, limit: 4 },
					"tenant",
					"wrong",
				)
			).status,
		).toBe(503);
		f.revoke();
		expect(
			(
				await f.send("read-log", {
					topic: "orders",
					afterSequence: 0,
					limit: 4,
				})
			).status,
		).toBe(503);
		f.restore();
		f.stopIngress();
		expect(
			(
				await f.send("read-log", {
					topic: "orders",
					afterSequence: 0,
					limit: 4,
				})
			).status,
		).toBe(503);
	});

	it("rejects noncanonical input and never resets corrupted stored state", async () => {
		const f = await fixture();
		await f.send("ensure-topic", { operation: op("8"), topic: "orders" });
		const noncanonical = new Request("https://actor.test/publish", {
			method: "POST",
			headers: { authorization: "test" },
			body: '{ "topic": "orders" }',
		});
		expect(
			(
				await f.actor.handle(
					{ name: "orders", key: ["tenant"], db: f.db },
					noncanonical,
				)
			).status,
		).toBe(400);
		f.sql
			.prepare(
				"UPDATE hobo_dm_topic_state SET value=? WHERE tenant=? AND instance=?",
			)
			.run(
				'{"version":1,"topics":[],"messages":[],"events":[],"eventTail":"bad"}',
				"tenant",
				"topic",
			);
		const response = await f.send("publish", {
			operation: op("9"),
			topic: "orders",
			message: { id: "m", subject: "s", payload: "", attributes: [] },
		});
		expect(await response.json()).toEqual({
			status: "unknown",
			operation: op("9"),
		});
		expect(
			(
				await f.send("read-log", {
					topic: "orders",
					afterSequence: 0,
					limit: 4,
				})
			).status,
		).toBe(503);
	});
});
