/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- SAFETY: model transitions construct varied raw method envelopes at the reducer boundary. */
import { describe, expect, it } from "vitest";
import { reduceDurableTopic } from "../src/durable-topic-reducer.js";

type Lease = { sequence: number; token: string };
type Pending = {
	sequence: number;
	status: "pending" | "leased" | "settled";
	attempt: number;
	lease: number;
	deadline: number;
};
type Model = {
	now: number;
	tail: number;
	floor: number;
	subscribed: boolean;
	subscriptionFloor: number;
	subscriptionTruncated: boolean;
	message?: Pending;
	leaseCounter: number;
	dlq: number;
	oldest?: Lease;
	latest?: Lease;
};
type Node = { model: Model; state: string; history: string[] };
const subscription = {
	topic: "source",
	consumerGroup: "group",
	deadLetterTopic: "dead",
	maxDeliveryAttempts: 2,
	startAt: "earliest",
};
const message = {
	id: "id",
	subject: "subject",
	payload: "AA==",
	attributes: [],
};
const actions = [
	"publish",
	"subscribe",
	"consume",
	"ack",
	"stale-ack",
	"nack",
	"advance",
	"compact",
] as const;
type Action = (typeof actions)[number];

function update(
	state: string | undefined,
	method: string,
	fields: Record<string, unknown>,
	now: number,
) {
	return reduceDurableTopic(state, method, { operation: {}, ...fields }, now);
}
function expectedTopicReceipt(model: Model) {
	return {
		subscription,
		firstAvailableSequence: model.subscriptionFloor,
		historyTruncated: model.subscriptionTruncated,
	};
}
function settlement(token: Lease | undefined) {
	return {
		topic: "source",
		consumerGroup: "group",
		messageId: "id",
		sequence: token?.sequence ?? 1,
		leaseId: token?.token ?? "missing",
	};
}
function stillOwns(model: Model, token: Lease | undefined): boolean {
	return (
		token !== undefined &&
		model.message !== undefined &&
		model.message.sequence === token.sequence &&
		model.message.status === "leased" &&
		model.message.deadline > model.now &&
		token.token === `l${model.message.lease}`
	);
}
function advance(node: Node, action: Action): Node | undefined {
	const model = structuredClone(node.model);
	if (action === "advance") {
		if (model.now >= 6) return undefined;
		model.now += 2;
		return { model, state: node.state, history: [...node.history, action] };
	}
	let method: string = action;
	let fields: Record<string, unknown> = {};
	let expected:
		| { status: "committed"; value: unknown }
		| { status: "rejected"; code: string };
	if (action === "publish") {
		fields = { topic: "source", message };
		if (model.message !== undefined)
			expected = { status: "rejected", code: "message-conflict" };
		else {
			model.tail++;
			model.message = {
				sequence: model.tail,
				status: "pending",
				attempt: 0,
				lease: 0,
				deadline: 0,
			};
			expected = {
				status: "committed",
				value: { messageId: "id", sequence: model.tail },
			};
		}
	} else if (action === "subscribe") {
		method = "ensure-subscription";
		fields = { subscription };
		if (!model.subscribed) {
			model.subscribed = true;
			model.subscriptionFloor = model.floor;
			model.subscriptionTruncated = model.floor > 1;
		}
		expected = { status: "committed", value: expectedTopicReceipt(model) };
	} else if (action === "consume") {
		fields = {
			topic: "source",
			consumerGroup: "group",
			maxMessages: 1,
			visibilityTimeoutMs: 2,
		};
		if (!model.subscribed) expected = { status: "rejected", code: "not-found" };
		else {
			let delivery: unknown[] = [];
			const current = model.message;
			if (
				current !== undefined &&
				current.status === "leased" &&
				current.deadline <= model.now &&
				current.attempt === 2
			) {
				current.status = "settled";
				current.lease = 0;
				current.deadline = 0;
				model.dlq++;
			} else if (
				current !== undefined &&
				(current.status === "pending" ||
					(current.status === "leased" && current.deadline <= model.now))
			) {
				current.status = "leased";
				current.attempt++;
				current.lease = ++model.leaseCounter;
				current.deadline = model.now + 2;
				const token = {
					sequence: current.sequence,
					token: `l${current.lease}`,
				};
				model.oldest ??= token;
				model.latest = token;
				delivery = [
					{
						message,
						sequence: current.sequence,
						topic: "source",
						consumerGroup: "group",
						leaseId: token.token,
						leaseExpiresAtMs: current.deadline,
						deliveryAttempt: current.attempt,
					},
				];
			}
			expected = { status: "committed", value: delivery };
		}
	} else if (action === "ack" || action === "stale-ack" || action === "nack") {
		const token = action === "stale-ack" ? model.oldest : model.latest;
		if (token === undefined) return undefined;
		method = action === "nack" ? "nack" : "ack";
		fields = settlement(token);
		if (action === "nack") fields.reason = "reason";
		if (!stillOwns(model, token))
			expected = { status: "rejected", code: "lease-lost" };
		else {
			const current = model.message;
			if (current === undefined) throw new Error("model lost its message");
			if (action !== "nack") {
				current.status = "settled";
				expected = {
					status: "committed",
					value: { messageId: "id", sequence: current.sequence },
				};
			} else if (current.attempt < 2) {
				current.status = "pending";
				expected = {
					status: "committed",
					value: {
						messageId: "id",
						sequence: current.sequence,
						disposition: "released",
					},
				};
			} else {
				current.status = "settled";
				model.dlq++;
				expected = {
					status: "committed",
					value: {
						messageId: "id",
						sequence: current.sequence,
						disposition: "dead-lettered",
						deadLetterMessageId: `dlq-${model.dlq}`,
						deadLetterSequence: model.dlq,
					},
				};
			}
			current.lease = 0;
			current.deadline = 0;
		}
	} else {
		method = "compact";
		fields = { topic: "source", throughSequence: model.tail };
		if (
			model.message !== undefined &&
			model.subscribed &&
			model.message.status !== "settled"
		)
			expected = { status: "rejected", code: "retention-blocked" };
		else {
			const removed = model.message === undefined ? 0 : 1;
			if (removed) {
				delete model.message;
				model.floor = model.tail + 1;
			}
			expected = {
				status: "committed",
				value: {
					topic: "source",
					firstAvailableSequence: model.floor,
					removedMessages: removed,
				},
			};
		}
	}
	const result = update(node.state, method, fields, node.model.now);
	if (expected.status === "rejected") {
		expect(
			result,
			`history: ${[...node.history, action].join(" -> ")}`,
		).toEqual(expected);
		return { model, state: node.state, history: [...node.history, action] };
	}
	if (result.status !== "committed")
		throw new Error(
			`unexpected ${result.status} after ${[...node.history, action].join(" -> ")}`,
		);
	expect(
		JSON.parse(result.value),
		`history: ${[...node.history, action].join(" -> ")}`,
	).toEqual(expected.value);
	const persisted = JSON.parse(result.state);
	expect(
		persisted.messages.length +
			persisted.deliveries.filter(
				(item: { reserved: boolean }) => item.reserved,
			).length,
	).toBeLessThanOrEqual(64);
	for (const item of persisted.deliveries) {
		if (item.status === "leased") expect(item.reserved).toBe(true);
		if (item.status === "settled") expect(item.reserved).toBe(false);
	}
	const source = persisted.messages.filter(
		(item: { topic: string }) => item.topic === "source",
	);
	expect(source.length).toBe(model.message === undefined ? 0 : 1);
	expect(
		persisted.messages.filter(
			(item: { topic: string }) => item.topic === "dead",
		),
	).toHaveLength(model.dlq);
	if (model.message !== undefined && model.subscribed) {
		const actual = persisted.deliveries.find(
			(item: { subscription: number; sequence: number }) =>
				item.subscription === 0 && item.sequence === model.message?.sequence,
		);
		expect(actual).toMatchObject({
			sequence: model.message.sequence,
			status: model.message.status,
			attempt: model.message.attempt,
			lease: model.message.lease,
			deadline: model.message.deadline,
		});
	}
	return { model, state: result.state, history: [...node.history, action] };
}

describe("bounded Rivet topic state exploration", () => {
	it("matches an independent one-message model through lease, expiry, DLQ, compaction and ID reuse", () => {
		let state: string | undefined;
		for (const topic of ["source", "dead"]) {
			const result = update(state, "ensure-topic", { topic }, 0);
			if (result.status !== "committed") throw new Error("model setup failed");
			state = result.state;
		}
		if (state === undefined) throw new Error("model state missing");
		const root: Node = {
			state,
			model: {
				now: 0,
				tail: 0,
				floor: 1,
				subscribed: false,
				subscriptionFloor: 1,
				subscriptionTruncated: false,
				leaseCounter: 0,
				dlq: 0,
			},
			history: [],
		};
		let frontier = [root];
		const seen = new Set<string>([JSON.stringify(root.model)]);
		let checked = 0;
		let sawExpiryDlq = false;
		let sawOldLeaseAfterReuse = false;
		for (let depth = 0; depth < 8; depth++) {
			const next: Node[] = [];
			for (const node of frontier)
				for (const action of actions) {
					const candidate = advance(node, action);
					if (candidate === undefined) continue;
					checked++;
					if (action === "consume" && candidate.model.dlq > node.model.dlq)
						sawExpiryDlq = true;
					if (
						action === "stale-ack" &&
						node.model.message !== undefined &&
						node.model.message.sequence > 1 &&
						node.model.oldest !== undefined &&
						node.model.oldest.sequence < node.model.message.sequence
					)
						sawOldLeaseAfterReuse = true;
					const key = JSON.stringify(candidate.model);
					if (!seen.has(key)) {
						seen.add(key);
						next.push(candidate);
					}
				}
			frontier = next;
		}
		expect(checked).toBeGreaterThan(500);
		expect(sawExpiryDlq).toBe(true);
		expect(sawOldLeaseAfterReuse).toBe(true);
	});
});
