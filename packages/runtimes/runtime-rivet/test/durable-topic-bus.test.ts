/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-object-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-unsafe-dictionary-type -- SAFETY: this fixture exercises actor HTTP and SQLite boundaries. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { durableMessagingOperation } from "@hobo/core";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDurableReceiptJournal } from "../src/durable-receipt-journal.js";
import {
	createRivetDurableTopicActor,
	createRivetDurableTopicBusActor,
	isRivetDurableTopicBusBinding,
} from "../src/durable-topic-actor.js";

const opened: DatabaseSync[] = [];
afterEach(() => {
	for (const database of opened.splice(0)) database.close();
});
function sqlite() {
	const sql = new DatabaseSync(":memory:");
	opened.push(sql);
	let tail = Promise.resolve();
	let failReceipt = false;
	let loseCommitAck = false;
	let postCommit: (() => void) | undefined;
	const execute = async (query: string, ...args: SQLInputValue[]) => {
		if (failReceipt && query.startsWith("INSERT INTO hobo_dm_receipts")) {
			failReceipt = false;
			throw new Error("injected receipt insert failure");
		}
		return sql.prepare(query).all(...args);
	};
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
			// SAFETY: this fixture exposes the transaction's execute operation only.
			const value = await run({ execute } as RawAccess);
			sql.exec("COMMIT");
			const after = postCommit;
			postCommit = undefined;
			after?.();
			if (loseCommitAck) {
				loseCommitAck = false;
				throw new Error("injected lost commit acknowledgement");
			}
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
	// SAFETY: these are the only database methods used by the actor and journal.
	return {
		sql,
		db: { execute, transaction } as RawAccess,
		failNextReceipt: () => {
			failReceipt = true;
		},
		loseNextCommitAck: () => {
			loseCommitAck = true;
		},
		afterNextCommit: (action: () => void) => {
			postCommit = action;
		},
	};
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
async function fixture() {
	const storage = sqlite();
	await migrateDurableReceiptJournal(storage.db);
	let clock = 1000;
	let grant = true;
	let serial = 0;
	const options = {
		actorName: "bus",
		semanticDigest: `sha256:${"b".repeat(64)}`,
		now: () => clock,
		resolveScope: () => ({ tenant: "tenant", instance: "instance" }),
		authorize: (claim: { headers: Headers }) =>
			claim.headers.get("authorization") === "test",
		authorizeInstanceScope: (claim: { headers: Headers }) =>
			grant && claim.headers.get("authorization") === "test",
		verifyIngress: () => true,
	};
	let actor = createRivetDurableTopicBusActor(options);
	const next = () =>
		durableMessagingOperation(10_000, String(++serial).padStart(16, "0"));
	const send = (method: string, body: unknown) =>
		actor.handle(
			{ name: "bus", key: ["tenant"], db: storage.db },
			new Request(`https://actor.test/${method}`, {
				method: "POST",
				headers: { authorization: "test" },
				body: canonical(body),
			}),
		);
	const mutate = async (method: string, fields: Record<string, unknown>) =>
		(await send(method, { operation: next(), ...fields })).json();
	return {
		...storage,
		options,
		next,
		send,
		mutate,
		get actor() {
			return actor;
		},
		advance: (milliseconds: number) => {
			clock += milliseconds;
		},
		setClock: (value: number) => {
			clock = value;
		},
		restart: () => {
			actor = createRivetDurableTopicBusActor(options);
		},
		revoke: () => {
			grant = false;
		},
		restore: () => {
			grant = true;
		},
	};
}
const message = (id = "m") => ({
	id,
	subject: "created",
	payload: "AAH/",
	attributes: [{ key: "type", value: "binary" }],
});
const subscription = (
	topic = "orders",
	consumerGroup = "group",
	deadLetterTopic = "dlq",
	maxDeliveryAttempts = 2,
	startAt = "earliest",
) => ({ topic, consumerGroup, deadLetterTopic, maxDeliveryAttempts, startAt });
const consume = (topic = "orders", consumerGroup = "group") => ({
	topic,
	consumerGroup,
	maxMessages: 1,
	visibilityTimeoutMs: 100,
});
function settle(delivery: {
	topic: string;
	consumerGroup: string;
	sequence: number;
	leaseId: string;
	message: { id: string };
}) {
	return {
		topic: delivery.topic,
		consumerGroup: delivery.consumerGroup,
		messageId: delivery.message.id,
		sequence: delivery.sequence,
		leaseId: delivery.leaseId,
	};
}
async function setup(f: Awaited<ReturnType<typeof fixture>>, attempts = 2) {
	for (const topic of ["orders", "dlq", "archive"])
		expect((await f.mutate("ensure-topic", { topic })).status).toBe(
			"committed",
		);
	expect(
		(
			await f.mutate("ensure-subscription", {
				subscription: subscription("orders", "group", "dlq", attempts),
			})
		).status,
	).toBe("committed");
	expect(
		(
			await f.mutate("ensure-subscription", {
				subscription: subscription("dlq", "reader", "archive", 1),
			})
		).status,
	).toBe("committed");
}

describe("Rivet durable topic bus using a SQLite actor fixture", () => {
	it("isolates groups, settles independently and compacts only complete obligations", async () => {
		const f = await fixture();
		await setup(f);
		expect(isRivetDurableTopicBusBinding(f.actor)).toBe(true);
		expect(f.actor.capabilities).toMatchObject({
			consumerGroups: true,
			leases: true,
			acknowledgement: true,
			deadLetter: true,
			legacyWit: false,
		});
		expect(
			(
				await f.mutate("ensure-subscription", {
					subscription: subscription("orders", "other"),
				})
			).status,
		).toBe("committed");
		expect(
			(await f.mutate("publish", { topic: "orders", message: message() }))
				.value,
		).toEqual({ messageId: "m", sequence: 1 });
		const [left, right] = await Promise.all([
			f.mutate("consume", consume()),
			f.mutate("consume", consume("orders", "other")),
		]);
		const a = left.value[0];
		const b = right.value[0];
		expect(a.message).toEqual(message());
		expect(b.message).toEqual(message());
		expect(a.leaseId).not.toBe(b.leaseId);
		expect((await f.mutate("consume", consume())).value).toEqual([]);
		expect((await f.mutate("ack", settle(a))).value).toEqual({
			messageId: "m",
			sequence: 1,
		});
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 1 })).code,
		).toBe("retention-blocked");
		expect(
			(await f.mutate("ack", { ...settle(b), consumerGroup: "group" })).code,
		).toBe("lease-lost");
		expect((await f.mutate("ack", settle(b))).status).toBe("committed");
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 1 }))
				.value,
		).toEqual({
			topic: "orders",
			firstAvailableSequence: 2,
			removedMessages: 1,
		});
		const late = await f.mutate("ensure-subscription", {
			subscription: subscription("orders", "late"),
		});
		expect(late.value).toMatchObject({
			firstAvailableSequence: 2,
			historyTruncated: true,
		});
		expect(
			(await f.mutate("publish", { topic: "orders", message: message() })).value
				.sequence,
		).toBe(2);
		expect((await f.mutate("ack", settle(a))).code).toBe("lease-lost");
	});

	it("replays receipts across restart and expiry and transfers expired final leases once", async () => {
		const f = await fixture();
		await setup(f, 1);
		await f.mutate("publish", { topic: "orders", message: message() });
		const request = { operation: f.next(), ...consume() };
		const first = await (await f.send("consume", request)).json();
		const delivery = first.value[0];
		f.advance(101);
		f.restart();
		expect(await (await f.send("consume", request)).json()).toEqual(first);
		expect((await f.mutate("ack", settle(delivery))).code).toBe("lease-lost");
		expect(
			(await f.mutate("nack", { ...settle(delivery), reason: "stale" })).code,
		).toBe("lease-lost");
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 1 })).code,
		).toBe("retention-blocked");
		expect((await f.mutate("consume", consume())).value).toEqual([]);
		f.restart();
		const dead = (await f.mutate("consume", consume("dlq", "reader"))).value[0];
		expect(dead.message).toMatchObject({
			subject: "created",
			payload: "AAH/",
			attributes: message().attributes,
		});
		expect(dead.deadLetter).toEqual({
			sourceTopic: "orders",
			consumerGroup: "group",
			originalMessageId: "m",
			originalSequence: 1,
			deliveryAttempt: 1,
			cause: { kind: "lease-expired" },
		});
		expect((await f.mutate("ack", settle(dead))).status).toBe("committed");
		expect((await f.mutate("consume", consume("dlq", "reader"))).value).toEqual(
			[],
		);
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 1 }))
				.status,
		).toBe("committed");
	});

	it("atomically nacks to DLQ and replays the receipt without duplicate transfer", async () => {
		const f = await fixture();
		await setup(f);
		await f.mutate("publish", { topic: "orders", message: message() });
		const first = (await f.mutate("consume", consume())).value[0];
		expect(
			(await f.mutate("nack", { ...settle(first), reason: "retry" })).value
				.disposition,
		).toBe("released");
		const second = (await f.mutate("consume", consume())).value[0];
		expect(second.deliveryAttempt).toBe(2);
		expect(second.leaseId).not.toBe(first.leaseId);
		const request = { operation: f.next(), ...settle(second), reason: "fatal" };
		const response = await (await f.send("nack", request)).json();
		f.restart();
		expect(await (await f.send("nack", request)).json()).toEqual(response);
		const dlq = (await f.mutate("consume", consume("dlq", "reader"))).value[0];
		expect(dlq.message.id).toBe(response.value.deadLetterMessageId);
		expect(dlq.sequence).toBe(response.value.deadLetterSequence);
		expect(dlq.deadLetter).toMatchObject({
			originalMessageId: "m",
			originalSequence: 1,
			deliveryAttempt: 2,
			cause: { kind: "nack", reason: "fatal" },
		});
		await f.mutate("ack", settle(dlq));
		expect((await f.mutate("consume", consume("dlq", "reader"))).value).toEqual(
			[],
		);
	});

	it("reserves capacity for multiple expired transfers and makes non-destructive progress", async () => {
		const f = await fixture();
		await setup(f, 1);
		await f.mutate("ensure-topic", { topic: "spare" });
		await f.mutate("publish", { topic: "spare", message: message("spare") });
		for (let index = 0; index < 31; index++)
			expect(
				(
					await f.mutate("publish", {
						topic: "orders",
						message: message(`m${index}`),
					})
				).status,
			).toBe("committed");
		const refused = {
			operation: f.next(),
			topic: "orders",
			message: message("too-many"),
		};
		expect(await (await f.send("publish", refused)).json()).toEqual({
			status: "rejected",
			code: "capacity-exceeded",
		});
		expect(await (await f.send("publish", refused)).json()).toEqual({
			status: "rejected",
			code: "capacity-exceeded",
		});
		const leases = [];
		for (;;) {
			const batch = (
				await f.mutate("consume", { ...consume(), maxMessages: 4 })
			).value;
			if (batch.length === 0) break;
			leases.push(...batch);
		}
		expect(leases).toHaveLength(31);
		expect(
			(
				await f.mutate("publish", {
					topic: "spare",
					message: message("spare-2"),
				})
			).status,
		).toBe("committed");
		f.advance(101);
		f.restart();
		const transfer = { operation: f.next(), ...consume(), maxMessages: 2 };
		const result = await (await f.send("consume", transfer)).json();
		expect(result).toEqual({ status: "committed", value: [] });
		expect(await (await f.send("consume", transfer)).json()).toEqual(result);
		expect((await f.mutate("consume", consume("dlq", "reader"))).code).toBe(
			"capacity-exceeded",
		);
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 31 }))
				.value.removedMessages,
		).toBe(31);
		const first = (await f.mutate("consume", consume("dlq", "reader")))
			.value[0];
		expect(first.deadLetter).toMatchObject({
			originalMessageId: "m0",
			originalSequence: 1,
			cause: { kind: "lease-expired" },
		});
		expect((await f.mutate("ack", settle(first))).status).toBe("committed");
		expect(
			(
				await f.mutate("compact", {
					topic: "dlq",
					throughSequence: first.sequence,
				})
			).status,
		).toBe("committed");
		expect(
			(await f.mutate("consume", consume("dlq", "reader"))).value[0].deadLetter
				.originalMessageId,
		).toBe("m1");
	});

	it("reserves independently for every group before simultaneous dead-letter transfers", async () => {
		const f = await fixture();
		await setup(f, 1);
		await f.mutate("ensure-subscription", {
			subscription: subscription("orders", "other", "dlq", 1),
		});
		await f.mutate("ensure-topic", { topic: "spare" });
		for (let index = 0; index < 21; index++)
			expect(
				(
					await f.mutate("publish", {
						topic: "orders",
						message: message(`m${index}`),
					})
				).status,
			).toBe("committed");
		expect(
			(await f.mutate("publish", { topic: "spare", message: message("fill") }))
				.status,
		).toBe("committed");
		expect(
			(
				await f.mutate("publish", {
					topic: "orders",
					message: message("overflow"),
				})
			).code,
		).toBe("capacity-exceeded");
		for (const group of ["group", "other"]) {
			let claimed = 0;
			for (let batch = 0; batch < 6; batch++)
				claimed += (
					await f.mutate("consume", {
						...consume("orders", group),
						maxMessages: 4,
					})
				).value.length;
			expect(claimed).toBe(21);
		}
		f.advance(101);
		expect(
			(await f.mutate("consume", consume("orders", "group"))).value,
		).toEqual([]);
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 1 })).code,
		).toBe("retention-blocked");
		expect(
			(await f.mutate("consume", consume("orders", "other"))).value,
		).toEqual([]);
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 21 }))
				.value.removedMessages,
		).toBe(21);
		const first = (
			await f.mutate("consume", { ...consume("dlq", "reader"), maxMessages: 4 })
		).value;
		expect(first).toHaveLength(4);
		expect(
			first.map(
				(item: { deadLetter: { consumerGroup: string } }) =>
					item.deadLetter.consumerGroup,
			),
		).toEqual(["group", "group", "group", "group"]);
		const gap = await (
			await f.send("events", { afterSequence: 0, limit: 4 })
		).json();
		expect(gap.status).toBe("gap");
		expect(gap.firstAvailableSequence).toBeGreaterThan(1);
		const page = await (
			await f.send("events", {
				afterSequence: gap.firstAvailableSequence - 1,
				limit: 4,
			})
		).json();
		expect(page.status).toBe("ok");
		expect(
			page.events.map((item: { sequence: number }) => item.sequence),
		).toEqual([
			gap.firstAvailableSequence,
			gap.firstAvailableSequence + 1,
			gap.firstAvailableSequence + 2,
			gap.firstAvailableSequence + 3,
		]);
		expect(page.nextAfterSequence).toBe(gap.firstAvailableSequence + 3);
		expect(page.hasMore).toBe(true);
	});

	it("requires the independently held entire-instance grant before work and receipt disclosure", async () => {
		const f = await fixture();
		const request = { operation: f.next(), topic: "orders" };
		f.revoke();
		expect((await f.send("ensure-topic", request)).status).toBe(503);
		expect(
			f.sql.prepare("SELECT count(*) AS count FROM hobo_dm_receipts").get(),
		).toEqual({ count: 0 });
		f.restore();
		const receipt = await (await f.send("ensure-topic", request)).json();
		expect(receipt).toEqual({
			status: "committed",
			value: { topic: "orders" },
		});
		f.revoke();
		expect((await f.send("ensure-topic", request)).status).toBe(503);
		f.restore();
		expect(await (await f.send("ensure-topic", request)).json()).toEqual(
			receipt,
		);
	});

	it("refuses a differently pinned or older state without resetting it", async () => {
		const f = await fixture();
		const partial = createRivetDurableTopicActor(f.options);
		const context = { name: "bus", key: ["tenant"], db: f.db };
		const request = new Request("https://actor.test/ensure-topic", {
			method: "POST",
			headers: { authorization: "test" },
			body: canonical({ operation: f.next(), topic: "orders" }),
		});
		expect((await (await partial.handle(context, request)).json()).status).toBe(
			"committed",
		);
		const before = f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get();
		expect(
			await (
				await f.send("publish", {
					operation: f.next(),
					topic: "orders",
					message: message(),
				})
			).json(),
		).toMatchObject({ status: "unknown" });
		expect(
			f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get(),
		).toEqual(before);
	});

	it("fences malformed markers for every mutation after checking the original receipt", async () => {
		const f = await fixture();
		await setup(f);
		await f.mutate("publish", { topic: "orders", message: message() });
		const delivery = (await f.mutate("consume", consume())).value[0];
		const cases: Array<[string, Record<string, unknown>]> = [
			["ensure-topic", { topic: "new" }],
			["ensure-subscription", { subscription: subscription("orders", "new") }],
			["publish", { topic: "orders", message: message("new") }],
			["consume", consume()],
			["ack", settle(delivery)],
			["nack", { ...settle(delivery), reason: "bad" }],
			["compact", { topic: "orders", throughSequence: 1 }],
		];
		const before = await (
			await f.send("events", { afterSequence: 0, limit: 100 })
		).json();
		for (const [method, fields] of cases) {
			const operation = f.next();
			const invalid = { operation, ...fields, __hobo_invalid_request: true };
			expect(await (await f.send(method, invalid)).json()).toEqual({
				status: "rejected",
				code: "invalid-argument",
			});
			expect(await (await f.send(method, invalid)).json()).toEqual({
				status: "rejected",
				code: "invalid-argument",
			});
			expect(
				await (await f.send(method, { operation, ...fields })).json(),
			).toEqual({ status: "rejected", code: "operation-conflict" });
		}
		expect(
			await (await f.send("events", { afterSequence: 0, limit: 100 })).json(),
		).toEqual(before);
		expect((await f.mutate("ack", settle(delivery))).status).toBe("committed");
	});

	it("serializes competing claims and same-ID conflicting publications", async () => {
		const f = await fixture();
		await setup(f);
		const operation = f.next();
		const requests = [message("first"), message("second")].map((item) => ({
			operation,
			topic: "orders",
			message: item,
		}));
		const results = await Promise.all(
			requests.map(async (request) =>
				(await f.send("publish", request)).json(),
			),
		);
		const winner = results.findIndex((result) => result.status === "committed");
		expect(winner).toBeGreaterThanOrEqual(0);
		expect(
			results.filter((result) => result.status === "committed"),
		).toHaveLength(1);
		expect(
			results.filter(
				(result) =>
					result.status === "rejected" && result.code === "operation-conflict",
			),
		).toHaveLength(1);
		const winningRequest = requests[winner];
		expect(winningRequest).toBeDefined();
		expect(await (await f.send("publish", winningRequest)).json()).toEqual(
			results[winner],
		);
		const claims = await Promise.all([
			f.mutate("consume", consume()),
			f.mutate("consume", consume()),
		]);
		const deliveries = claims.flatMap((result) => result.value);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].message).toEqual(winningRequest?.message);
		expect(results[winner].value).toEqual({
			messageId: winningRequest?.message.id,
			sequence: deliveries[0].sequence,
		});
		await f.mutate("ack", settle(deliveries[0]));
		f.restart();
		expect((await f.mutate("consume", consume())).value).toEqual([]);
	});

	it("never resets a corrupted group obligation or forged lease counter", async () => {
		for (const corrupt of [
			"missing-obligation",
			"reused-lease",
			"lost-reservation",
		] as const) {
			const f = await fixture();
			await setup(f);
			await f.mutate("publish", { topic: "orders", message: message() });
			await f.mutate("consume", consume());
			const raw = f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get();
			if (raw === undefined || typeof raw.value !== "string")
				throw new Error("missing fixture state");
			const damaged = JSON.parse(raw.value);
			if (corrupt === "missing-obligation") damaged.deliveries = [];
			else if (corrupt === "reused-lease") damaged.leaseCounter = 0;
			else damaged.deliveries[0].reserved = false;
			const encoded = JSON.stringify(damaged);
			f.sql.prepare("UPDATE hobo_dm_topic_state SET value=?").run(encoded);
			const result = await f.mutate("consume", consume());
			expect(result.status).toBe("unknown");
			expect(
				(await f.send("events", { afterSequence: 0, limit: 10 })).status,
			).toBe(503);
			expect(
				f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get()?.value,
			).toBe(encoded);
		}
	});

	it("bounds the combined worst-case retained state and wire pages", async () => {
		const f = await fixture();
		const limits = f.actor.limits;
		const name = 6 * limits.nameBytes + 2;
		const attrs = 6 * limits.attributeBytes + 64 * limits.attributeCount;
		const payload = 4 * Math.ceil(limits.payloadBytes / 3);
		const provenance = 3 * name + 6 * limits.reasonBytes + 512;
		const messageBound = 3 * name + attrs + payload + provenance + 256;
		const eventBound = 3 * name + 256;
		const stateBound =
			limits.retainedMessages * messageBound +
			limits.retainedEvents * eventBound +
			limits.topics * (name + 256) +
			limits.subscriptions * (3 * name + 512) +
			limits.retainedMessages * limits.subscriptions * 256 +
			4096;
		expect(stateBound).toBeLessThanOrEqual(4_194_304);
		expect(limits.eventPageSize * eventBound + 4096).toBeLessThanOrEqual(
			262_144,
		);
		expect(
			limits.batchSize * (messageBound + 2 * name + 512) + 4096,
		).toBeLessThanOrEqual(262_144);
		expect(messageBound + 4096).toBeLessThanOrEqual(131_072);
	});

	it("round-trips maximum-size escaped payloads, provenance and a full DLQ batch", async () => {
		const f = await fixture();
		const source = "\\".repeat(128);
		const target = '"'.repeat(128);
		const archive = "a".repeat(128);
		const group = `g${"\\".repeat(127)}`;
		const reader = `r${"\\".repeat(127)}`;
		for (const topic of [source, target, archive])
			await f.mutate("ensure-topic", { topic });
		await f.mutate("ensure-subscription", {
			subscription: subscription(source, group, target, 1),
		});
		await f.mutate("ensure-subscription", {
			subscription: subscription(target, reader, archive, 1),
		});
		const attributes = Array.from({ length: 31 }, (_, index) => ({
			key: `k${index}`,
			value: "",
		}));
		const used = attributes.reduce(
			(total, item) => total + Buffer.byteLength(item.key),
			0,
		);
		attributes.push({ key: "z", value: "\u0000".repeat(2_047 - used) });
		expect(
			attributes.reduce(
				(total, item) =>
					total + Buffer.byteLength(item.key) + Buffer.byteLength(item.value),
				0,
			),
		).toBe(2_048);
		const payload = Buffer.alloc(8_192, 255).toString("base64");
		const reason = "\u0000".repeat(1_024);
		for (let index = 0; index < 4; index++) {
			const item = {
				id: `m${index}`.padEnd(128, "\\"),
				subject: "\\".repeat(128),
				payload,
				attributes,
			};
			expect(
				(await f.mutate("publish", { topic: source, message: item })).status,
			).toBe("committed");
		}
		const deliveries = (
			await f.mutate("consume", { ...consume(source, group), maxMessages: 4 })
		).value;
		expect(deliveries).toHaveLength(4);
		for (const delivery of deliveries)
			expect(
				(await f.mutate("nack", { ...settle(delivery), reason })).value
					.disposition,
			).toBe("dead-lettered");
		const response = await f.send("consume", {
			operation: f.next(),
			...consume(target, reader),
			maxMessages: 4,
		});
		const text = await response.text();
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262_144);
		const batch = JSON.parse(text);
		expect(batch.value).toHaveLength(4);
		for (const [index, delivery] of batch.value.entries()) {
			expect(delivery.message).toMatchObject({
				payload,
				attributes,
				subject: "\\".repeat(128),
			});
			expect(delivery.deadLetter).toMatchObject({
				sourceTopic: source,
				consumerGroup: group,
				originalMessageId: `m${index}`.padEnd(128, "\\"),
				cause: { kind: "nack", reason },
			});
		}
	});

	it("keeps completed expiry transfers when the lease sequence is exhausted", async () => {
		const f = await fixture();
		await setup(f, 1);
		await f.mutate("publish", { topic: "orders", message: message("first") });
		await f.mutate("publish", { topic: "orders", message: message("next") });
		const first = (await f.mutate("consume", consume())).value[0];
		f.advance(101);
		const raw = f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get();
		if (raw === undefined || typeof raw.value !== "string")
			throw new Error("missing fixture state");
		const state = JSON.parse(raw.value);
		state.leaseCounter = Number.MAX_SAFE_INTEGER;
		f.sql
			.prepare("UPDATE hobo_dm_topic_state SET value=?")
			.run(JSON.stringify(state));
		expect((await f.mutate("consume", consume())).value).toEqual([]);
		expect((await f.mutate("consume", consume())).code).toBe(
			"capacity-exceeded",
		);
		const after = f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get();
		if (after === undefined || typeof after.value !== "string")
			throw new Error("missing fixture state");
		const stored = JSON.parse(after.value);
		expect(
			stored.messages.find((item: { topic: string }) => item.topic === "dlq"),
		).toMatchObject({
			payload: "AAH/",
			deadLetter: {
				originalMessageId: "first",
				originalSequence: first.sequence,
				cause: { kind: "lease-expired" },
			},
		});
		expect(
			(
				await f.mutate("compact", {
					topic: "orders",
					throughSequence: first.sequence,
				})
			).status,
		).toBe("committed");
	});

	it("replays settled receipts after their leases have expired", async () => {
		const f = await fixture();
		await setup(f);
		await f.mutate("ensure-subscription", {
			subscription: subscription("orders", "other"),
		});
		await f.mutate("publish", { topic: "orders", message: message() });
		const a = (await f.mutate("consume", consume())).value[0];
		const b = (await f.mutate("consume", consume("orders", "other"))).value[0];
		const ack = { operation: f.next(), ...settle(a) };
		const nack = { operation: f.next(), ...settle(b), reason: "retry" };
		const ackReceipt = await (await f.send("ack", ack)).json();
		const nackReceipt = await (await f.send("nack", nack)).json();
		f.advance(101);
		f.restart();
		expect(await (await f.send("ack", ack)).json()).toEqual(ackReceipt);
		expect(await (await f.send("nack", nack)).json()).toEqual(nackReceipt);
		const redelivery = (await f.mutate("consume", consume("orders", "other")))
			.value[0];
		expect(redelivery.deliveryAttempt).toBe(2);
		expect(redelivery.leaseId).not.toBe(b.leaseId);
	});

	it("checkpoints latest subscriptions after the existing tail", async () => {
		const f = await fixture();
		await f.mutate("ensure-topic", { topic: "orders" });
		await f.mutate("ensure-topic", { topic: "dlq" });
		await f.mutate("publish", { topic: "orders", message: message("old") });
		const result = await f.mutate("ensure-subscription", {
			subscription: subscription("orders", "late", "dlq", 2, "latest"),
		});
		expect(result.value).toMatchObject({
			firstAvailableSequence: 1,
			historyTruncated: false,
		});
		await f.mutate("publish", { topic: "orders", message: message("new") });
		const delivery = (await f.mutate("consume", consume("orders", "late")))
			.value[0];
		expect(delivery.message.id).toBe("new");
		expect(delivery.sequence).toBe(2);
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 1 })).value
				.removedMessages,
		).toBe(1);
		expect(
			(await f.mutate("compact", { topic: "orders", throughSequence: 2 })).code,
		).toBe("retention-blocked");
	});

	it("linearizes compaction racing an earliest subscription in the local transaction fixture", async () => {
		const f = await fixture();
		await f.mutate("ensure-topic", { topic: "orders" });
		await f.mutate("ensure-topic", { topic: "dlq" });
		await f.mutate("publish", { topic: "orders", message: message() });
		const [compact, subscribe] = await Promise.all([
			f.mutate("compact", { topic: "orders", throughSequence: 1 }),
			f.mutate("ensure-subscription", { subscription: subscription() }),
		]);
		expect(subscribe.status).toBe("committed");
		f.restart();
		if (compact.status === "committed") {
			expect(subscribe.value).toMatchObject({
				firstAvailableSequence: 2,
				historyTruncated: true,
			});
			expect((await f.mutate("consume", consume())).value).toEqual([]);
		} else {
			expect(compact.code).toBe("retention-blocked");
			expect(subscribe.value).toMatchObject({
				firstAvailableSequence: 1,
				historyTruncated: false,
			});
			expect((await f.mutate("consume", consume())).value[0].message).toEqual(
				message(),
			);
		}
	});

	it("independently snapshots credentials for principal and instance-grant checks", async () => {
		const f = await fixture();
		const isolated = createRivetDurableTopicBusActor({
			...f.options,
			authorize: (claim) => {
				claim.headers.set("authorization", "changed");
				return true;
			},
			authorizeInstanceScope: (claim) =>
				claim.headers.get("authorization") === "test",
		});
		const response = await isolated.handle(
			{ name: "bus", key: ["tenant"], db: f.db },
			new Request("https://actor.test/ensure-topic", {
				method: "POST",
				headers: { authorization: "test" },
				body: canonical({ operation: f.next(), topic: "orders" }),
			}),
		);
		expect(await response.json()).toEqual({
			status: "committed",
			value: { topic: "orders" },
		});
	});

	it("returns bounded rejections at lease and sequence limits without effects", async () => {
		const f = await fixture();
		await setup(f);
		await f.mutate("publish", { topic: "orders", message: message() });
		const invalid = {
			operation: f.next(),
			...consume(),
			visibilityTimeoutMs: 0,
		};
		expect(await (await f.send("consume", invalid)).json()).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		expect(await (await f.send("consume", invalid)).json()).toEqual({
			status: "rejected",
			code: "invalid-argument",
		});
		expect(
			(
				await f.mutate("consume", {
					...consume(),
					visibilityTimeoutMs: f.actor.limits.leaseMs + 1,
				})
			).code,
		).toBe("invalid-argument");
		expect(
			(
				await f.mutate("consume", {
					...consume(),
					maxMessages: f.actor.limits.batchSize + 1,
				})
			).code,
		).toBe("invalid-argument");
		const raw = f.sql.prepare("SELECT value FROM hobo_dm_topic_state").get();
		if (raw === undefined || typeof raw.value !== "string")
			throw new Error("missing fixture state");
		const state = JSON.parse(raw.value);
		state.leaseCounter = Number.MAX_SAFE_INTEGER;
		f.sql
			.prepare("UPDATE hobo_dm_topic_state SET value=?")
			.run(JSON.stringify(state));
		const overflow = { operation: f.next(), ...consume() };
		expect(await (await f.send("consume", overflow)).json()).toEqual({
			status: "rejected",
			code: "capacity-exceeded",
		});
		f.restart();
		expect(await (await f.send("consume", overflow)).json()).toEqual({
			status: "rejected",
			code: "capacity-exceeded",
		});
		const retained = f.sql
			.prepare("SELECT value FROM hobo_dm_topic_state")
			.get();
		if (retained === undefined || typeof retained.value !== "string")
			throw new Error("missing fixture state");
		expect(JSON.parse(retained.value).deliveries[0]).toMatchObject({
			status: "pending",
			attempt: 0,
			lease: 0,
		});
	});

	it("keeps DLQ state and receipt atomic under SQLite fixture faults and revoked authority", async () => {
		for (const fault of [
			"receipt-insert",
			"lost-commit-ack",
			"revoke-after-commit",
		] as const) {
			const f = await fixture();
			await setup(f, 1);
			await f.mutate("publish", { topic: "orders", message: message() });
			const leased = (await f.mutate("consume", consume())).value[0];
			const request = {
				operation: f.next(),
				...settle(leased),
				reason: "failed",
			};
			const before = f.sql
				.prepare("SELECT value FROM hobo_dm_topic_state")
				.get();
			if (fault === "receipt-insert") f.failNextReceipt();
			else if (fault === "lost-commit-ack") f.loseNextCommitAck();
			else f.afterNextCommit(f.revoke);
			const failed = await f.send("nack", request);
			if (fault === "revoke-after-commit") expect(failed.status).toBe(503);
			else
				expect(await failed.json()).toEqual({
					status: "unknown",
					operation: request.operation,
				});
			const uncertain = f.sql
				.prepare("SELECT value FROM hobo_dm_topic_state")
				.get();
			if (fault === "receipt-insert") expect(uncertain).toEqual(before);
			else expect(uncertain).not.toEqual(before);
			f.restore();
			f.restart();
			const completed = await (await f.send("nack", request)).json();
			expect(completed).toMatchObject({
				status: "committed",
				value: { messageId: "m", sequence: 1, disposition: "dead-lettered" },
			});
			expect(await (await f.send("nack", request)).json()).toEqual(completed);
			const dead = (await f.mutate("consume", consume("dlq", "reader")))
				.value[0];
			expect(dead.message.id).toBe(completed.value.deadLetterMessageId);
			expect(dead.sequence).toBe(completed.value.deadLetterSequence);
			expect(dead.deadLetter).toMatchObject({
				originalMessageId: "m",
				cause: { kind: "nack", reason: "failed" },
			});
			await f.mutate("ack", settle(dead));
			expect(
				(await f.mutate("consume", consume("dlq", "reader"))).value,
			).toEqual([]);
		}
	});
});
