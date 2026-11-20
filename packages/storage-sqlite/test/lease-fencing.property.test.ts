import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
	SqliteJournal,
} from "../src/index.js";

const actor = { kind: "system" as const, id: "test" };

describe("delivery attempt fencing", () => {
	it("does not let a stale queue receipt complete a reused lease", () => {
		let time = Date.parse("2026-07-27T12:00:00.000Z");
		const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
			clock: { now: () => new Date(time).toISOString() },
			nativePragmas: false,
		});
		try {
			journal.enqueueMessage({ queueName: "q", idempotencyKey: "k", body: {} });
			const input = {
				queueName: "q",
				maxMessages: 1,
				visibilityTimeoutMs: 1_000,
				leaseId: "same",
				leaseFence: 1n,
			};
			const [first] = journal.leaseMessages(input);
			for (const invalid of [
				0,
				-1,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
			]) {
				expect(
					journal.completeMessage(first?.messageId ?? "", "same", 1n, invalid),
				).toBe(false);
			}
			// @ts-expect-error An old three-argument caller must fail closed.
			const legacyCompletion = journal.completeMessage(
				first?.messageId ?? "",
				"same",
				1n,
			);
			expect(legacyCompletion).toBe(false);
			time += 1_001;
			const [second] = journal.leaseMessages(input);
			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(
				journal.completeMessage(
					first?.messageId ?? "",
					"same",
					1n,
					first?.deliveryAttempt ?? 0,
				),
			).toBe(false);
			expect(
				journal.completeMessage(
					second?.messageId ?? "",
					"same",
					1n,
					second?.deliveryAttempt ?? 0,
				),
			).toBe(true);
		} finally {
			journal.close();
		}
	});

	it("allows the current receipt after expiry but before reclaim", async () => {
		let time = Date.parse("2026-07-27T12:00:00.000Z");
		const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
			clock: { now: () => new Date(time).toISOString() },
			nativePragmas: false,
		});
		try {
			journal.enqueueMessage({ queueName: "q", idempotencyKey: "k", body: {} });
			await journal.commit({
				streamId: "s",
				events: [{ type: "a.A", data: {} }],
				append: { expectedSeq: 0, actor, tenant: "t" },
				effects: [
					{
						kind: "outbox",
						destination: "webhook:test",
						idempotencyKey: "k",
						payload: {},
					},
				],
			});
			const [queue] = journal.leaseMessages({
				queueName: "q",
				maxMessages: 1,
				visibilityTimeoutMs: 1_000,
				leaseId: "worker",
				leaseFence: 1n,
			});
			const [outbox] = journal.claimOutbox({
				limit: 1,
				visibilityTimeoutMs: 1_000,
				leaseId: "worker",
				leaseFence: 1n,
			});
			if (!queue || !outbox) throw new Error("missing receipt");
			time += 1_001;
			expect(
				journal.completeMessage(
					queue.messageId,
					queue.leaseId,
					queue.leaseFence,
					queue.deliveryAttempt,
				),
			).toBe(true);
			expect(
				journal.ackOutbox(
					outbox.outboxId,
					outbox.leaseId,
					outbox.leaseFence,
					outbox.deliveryAttempt,
				),
			).toBe(true);
		} finally {
			journal.close();
		}
	});

	it("preserves fencing generations when the database is reopened", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-delivery-fence-"));
		const path = join(directory, "journal.sqlite");
		let time = Date.parse("2026-07-27T12:00:00.000Z");
		const clock = { now: () => new Date(time).toISOString() };
		const queueInput = {
			queueName: "q",
			maxMessages: 1,
			visibilityTimeoutMs: 1_000,
			leaseId: "same",
			leaseFence: 1n,
		};
		const outboxInput = {
			limit: 1,
			visibilityTimeoutMs: 1_000,
			leaseId: "same",
			leaseFence: 1n,
		};
		try {
			const first = new SqliteJournal(createNodeSqliteDriver({ path }), {
				clock,
			});
			first.enqueueMessage({ queueName: "q", idempotencyKey: "k", body: {} });
			await first.commit({
				streamId: "s",
				events: [{ type: "a.A", data: {} }],
				append: { expectedSeq: 0, actor, tenant: "t" },
				effects: [
					{
						kind: "outbox",
						destination: "webhook:test",
						idempotencyKey: "k",
						payload: {},
					},
				],
			});
			const [oldQueue] = first.leaseMessages(queueInput);
			const [oldOutbox] = first.claimOutbox(outboxInput);
			first.close();
			time += 1_001;
			const second = new SqliteJournal(createNodeSqliteDriver({ path }), {
				clock,
			});
			try {
				const [queue] = second.leaseMessages(queueInput);
				const [outbox] = second.claimOutbox(outboxInput);
				if (!oldQueue || !oldOutbox || !queue || !outbox)
					throw new Error("missing receipt");
				expect(queue.deliveryAttempt).toBe(2);
				expect(outbox.deliveryAttempt).toBe(2);
				expect(
					second.completeMessage(
						oldQueue.messageId,
						oldQueue.leaseId,
						oldQueue.leaseFence,
						oldQueue.deliveryAttempt,
					),
				).toBe(false);
				expect(
					second.ackOutbox(
						oldOutbox.outboxId,
						oldOutbox.leaseId,
						oldOutbox.leaseFence,
						oldOutbox.deliveryAttempt,
					),
				).toBe(false);
				// @ts-expect-error An old three-argument caller must fail closed.
				const legacyAck = second.ackOutbox(
					outbox.outboxId,
					outbox.leaseId,
					outbox.leaseFence,
				);
				expect(legacyAck).toBe(false);
				expect(
					second.completeMessage(
						queue.messageId,
						queue.leaseId,
						queue.leaseFence,
						queue.deliveryAttempt,
					),
				).toBe(true);
				expect(
					second.ackOutbox(
						outbox.outboxId,
						outbox.leaseId,
						outbox.leaseFence,
						outbox.deliveryAttempt,
					),
				).toBe(true);
			} finally {
				second.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses to increment a generation beyond safe integer precision", async () => {
		const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
			clock: { now: () => "2026-07-27T12:00:00.000Z" },
			nativePragmas: false,
		});
		try {
			const queue = journal.enqueueMessage({
				queueName: "q",
				idempotencyKey: "k",
				body: {},
			});
			const result = await journal.commit({
				streamId: "s",
				events: [{ type: "a.A", data: {} }],
				append: { expectedSeq: 0, actor, tenant: "t" },
				effects: [
					{
						kind: "outbox",
						destination: "webhook:test",
						idempotencyKey: "k",
						payload: {},
					},
				],
			});
			journal
				.getDriver()
				.prepare(
					"UPDATE queue_messages SET delivery_attempt = ? WHERE message_id = ?",
				)
				.run(Number.MAX_SAFE_INTEGER, queue.messageId);
			journal
				.getDriver()
				.prepare("UPDATE outbox SET attempt_count = ? WHERE outbox_id = ?")
				.run(Number.MAX_SAFE_INTEGER, result.effects[0]?.id ?? "");
			expect(() =>
				journal.leaseMessages({
					queueName: "q",
					maxMessages: 1,
					visibilityTimeoutMs: 1_000,
					leaseId: "same",
					leaseFence: 1n,
				}),
			).toThrow(/incremented safely/);
			expect(() =>
				journal.claimOutbox({
					limit: 1,
					visibilityTimeoutMs: 1_000,
					leaseId: "same",
					leaseFence: 1n,
				}),
			).toThrow(/incremented safely/);
		} finally {
			journal.close();
		}
	});

	it("rejects every superseded queue and outbox receipt even when credentials repeat", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						leaseId: fc.constantFrom("worker-a", "worker-b"),
						leaseFence: fc.constantFrom(1n, 2n),
					}),
					{ minLength: 2, maxLength: 7 },
				),
				async (workers) => {
					let time = Date.parse("2026-07-27T12:00:00.000Z");
					const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
						clock: { now: () => new Date(time).toISOString() },
						nativePragmas: false,
					});
					try {
						journal.enqueueMessage({
							queueName: "q",
							idempotencyKey: "queue-key",
							body: {},
						});
						await journal.commit({
							streamId: "delivery",
							events: [{ type: "delivery.Started", data: {} }],
							append: { expectedSeq: 0, actor, tenant: "t" },
							effects: [
								{
									kind: "outbox",
									destination: "webhook:test",
									idempotencyKey: "outbox-key",
									payload: {},
								},
							],
						});
						const queueReceipts: ReturnType<typeof journal.leaseMessages> = [];
						const outboxReceipts: ReturnType<typeof journal.claimOutbox> = [];
						for (const [index, worker] of workers.entries()) {
							if (index > 0) time += 1_001;
							const [queue] = journal.leaseMessages({
								queueName: "q",
								maxMessages: 1,
								visibilityTimeoutMs: 1_000,
								...worker,
							});
							const [outbox] = journal.claimOutbox({
								limit: 1,
								visibilityTimeoutMs: 1_000,
								...worker,
							});
							expect(queue?.deliveryAttempt).toBe(index + 1);
							expect(outbox?.deliveryAttempt).toBe(index + 1);
							if (!queue || !outbox) throw new Error("claim failed");
							for (const old of queueReceipts) {
								expect(
									journal.completeMessage(
										old.messageId,
										old.leaseId,
										old.leaseFence,
										old.deliveryAttempt,
									),
								).toBe(false);
							}
							for (const old of outboxReceipts) {
								expect(
									journal.ackOutbox(
										old.outboxId,
										old.leaseId,
										old.leaseFence,
										old.deliveryAttempt,
									),
								).toBe(false);
							}
							queueReceipts.push(queue);
							outboxReceipts.push(outbox);
						}
						const queue = queueReceipts.at(-1);
						const outbox = outboxReceipts.at(-1);
						if (!queue || !outbox) throw new Error("no receipt");
						expect(
							journal.completeMessage(
								queue.messageId,
								queue.leaseId,
								queue.leaseFence,
								queue.deliveryAttempt,
							),
						).toBe(true);
						expect(
							journal.ackOutbox(
								outbox.outboxId,
								outbox.leaseId,
								outbox.leaseFence,
								outbox.deliveryAttempt,
							),
						).toBe(true);
					} finally {
						journal.close();
					}
				},
			),
			{ seed: 614446, numRuns: 150 },
		);
	});
});
