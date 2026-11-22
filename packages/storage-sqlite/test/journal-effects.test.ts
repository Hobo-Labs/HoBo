import type {
	CronEffectInput,
	DurableEffectInput,
	OutboxEffectInput,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createMemoryNodeSqliteDriver, SqliteJournal } from "../src/index.js";

const actor = { kind: "system" as const, id: "test" };
const NOW = "2026-07-27T12:00:00.000Z";

function movableClock(start = NOW) {
	let iso = start;
	return {
		now: () => iso,
		set(next: string) {
			iso = next;
		},
	};
}

let clock = movableClock();

function journal(): SqliteJournal {
	clock = movableClock();
	return new SqliteJournal(createMemoryNodeSqliteDriver(), {
		clock,
		nativePragmas: false,
	});
}

function claim(j: SqliteJournal, limit = 10, leaseFence = 1n) {
	return j.claimOutbox({
		limit,
		leaseId: "lease-1",
		leaseFence,
		visibilityTimeoutMs: 30_000,
	});
}

function commit(
	j: SqliteJournal,
	effects: DurableEffectInput[],
	expectedSeq = 0,
	type = "a.A",
) {
	return j.commit({
		streamId: "s1",
		events: [{ type, data: {} }],
		append: { expectedSeq, actor, tenant: "t" },
		effects,
	});
}

function outboxEffect(
	overrides: Partial<OutboxEffectInput> = {},
): OutboxEffectInput {
	return {
		kind: "outbox",
		destination: "webhook:acme",
		idempotencyKey: "k1",
		payload: { hello: "world" },
		...overrides,
	};
}

function cronEffect(overrides: Partial<CronEffectInput> = {}): CronEffectInput {
	return {
		kind: "cron",
		scheduleId: "nightly",
		everyMs: 86_400_000,
		startAt: NOW,
		nextFireAt: "2026-07-28T12:00:00.000Z",
		...overrides,
	};
}

describe("outbox effects", () => {
	it("stages an outbox row and reports it as not deduped", async () => {
		const j = journal();
		try {
			const result = await commit(j, [outboxEffect()]);
			expect(result.effects).toHaveLength(1);
			expect(result.effects[0]?.kind).toBe("outbox");
			expect(result.effects[0]?.deduped).toBe(false);
			expect(result.effects[0]?.id).toBe("outbox:webhook:acme:k1");
		} finally {
			j.close();
		}
	});

	it("dedups a repeat on the same destination and key", async () => {
		const j = journal();
		try {
			const first = await commit(j, [outboxEffect()]);
			const second = await commit(j, [outboxEffect()], 1, "a.B");
			expect(second.effects[0]?.deduped).toBe(true);
			expect(second.effects[0]?.id).toBe(first.effects[0]?.id);
		} finally {
			j.close();
		}
	});

	it("treats the same key on a different destination as a distinct effect", async () => {
		const j = journal();
		try {
			await commit(j, [outboxEffect()]);
			const other = await commit(
				j,
				[outboxEffect({ destination: "webhook:other" })],
				1,
				"a.B",
			);
			expect(other.effects[0]?.deduped).toBe(false);
		} finally {
			j.close();
		}
	});

	it("claims a pending outbox row and acks it exactly once", async () => {
		const j = journal();
		try {
			await commit(j, [outboxEffect()]);
			const claimed = claim(j);
			expect(claimed).toHaveLength(1);
			const row = claimed[0];
			expect(row?.destination).toBe("webhook:acme");
			expect(row?.payload).toEqual({ hello: "world" });

			expect(
				j.ackOutbox(
					row?.outboxId ?? "",
					row?.leaseId ?? "",
					row?.leaseFence ?? 0n,
					row?.deliveryAttempt ?? 0,
				),
			).toBe(true);
			expect(claim(j)).toEqual([]);
		} finally {
			j.close();
		}
	});

	it("refuses an ack with the wrong lease", async () => {
		const j = journal();
		try {
			await commit(j, [outboxEffect()]);
			const row = claim(j, 1)[0];
			expect(
				j.ackOutbox(
					row?.outboxId ?? "",
					"not-the-lease",
					row?.leaseFence ?? 0n,
					row?.deliveryAttempt ?? 0,
				),
			).toBe(false);
			expect(
				j.ackOutbox(
					row?.outboxId ?? "",
					row?.leaseId ?? "",
					999n,
					row?.deliveryAttempt ?? 0,
				),
			).toBe(false);
		} finally {
			j.close();
		}
	});

	it("carries headers through the metadata codec", async () => {
		const j = journal();
		try {
			await commit(j, [
				outboxEffect({ headers: { "x-trace": "abc", "x-attempt": "1" } }),
			]);
			const row = claim(j, 1)[0];
			expect(row?.headers).toEqual({ "x-trace": "abc", "x-attempt": "1" });
		} finally {
			j.close();
		}
	});

	it("defaults absent headers to an empty record", async () => {
		const j = journal();
		try {
			await commit(j, [outboxEffect()]);
			const row = claim(j, 1)[0];
			expect(row?.headers).toEqual({});
		} finally {
			j.close();
		}
	});

	it("honours a delayed availableAt", async () => {
		const j = journal();
		try {
			await commit(j, [
				outboxEffect({ availableAt: "2026-07-27T13:00:00.000Z" }),
			]);
			// Not yet available: a worker claiming early would send before the
			expect(claim(j)).toEqual([]);
			clock.set("2026-07-27T13:00:00.000Z");
			expect(claim(j)).toHaveLength(1);
		} finally {
			j.close();
		}
	});

	it("stages nothing when the commit is refused", async () => {
		const j = journal();
		try {
			await commit(j, []);
			await expect(commit(j, [outboxEffect()], 0, "a.B")).rejects.toThrow();
			expect(claim(j)).toEqual([]);
		} finally {
			j.close();
		}
	});
});

describe("cron effects", () => {
	it("creates a schedule and reports it as not deduped", async () => {
		const j = journal();
		try {
			const result = await commit(j, [cronEffect()]);
			expect(result.effects[0]?.kind).toBe("cron");
			expect(result.effects[0]?.id).toBe("nightly");
			expect(result.effects[0]?.deduped).toBe(false);
		} finally {
			j.close();
		}
	});

	it("updates an existing schedule in place rather than duplicating it", async () => {
		const j = journal();
		try {
			await commit(j, [cronEffect()]);
			const updated = await commit(
				j,
				[
					cronEffect({
						everyMs: 3_600_000,
						nextFireAt: "2026-07-27T13:00:00.000Z",
					}),
				],
				1,
				"a.B",
			);
			expect(updated.effects[0]?.id).toBe("nightly");
			const rows = j
				.getDriver()
				.prepare("SELECT COUNT(*) AS n FROM cron_schedules")
				.get();
			expect(Number(rows?.n)).toBe(1);
			const schedule = j
				.getDriver()
				.prepare(
					"SELECT every_ms, next_fire_at FROM cron_schedules WHERE schedule_id = ?",
				)
				.get("nightly");
			expect(Number(schedule?.every_ms)).toBe(3_600_000);
			expect(schedule?.next_fire_at).toBe("2026-07-27T13:00:00.000Z");
		} finally {
			j.close();
		}
	});

	it("defaults the occurrence to zero", async () => {
		const j = journal();
		try {
			await commit(j, [cronEffect()]);
			const row = j
				.getDriver()
				.prepare("SELECT occurrence FROM cron_schedules WHERE schedule_id = ?")
				.get("nightly");
			expect(Number(row?.occurrence)).toBe(0);
		} finally {
			j.close();
		}
	});

	it("honours an explicit occurrence", async () => {
		const j = journal();
		try {
			await commit(j, [cronEffect({ occurrence: 7 })]);
			const row = j
				.getDriver()
				.prepare("SELECT occurrence FROM cron_schedules WHERE schedule_id = ?")
				.get("nightly");
			expect(Number(row?.occurrence)).toBe(7);
		} finally {
			j.close();
		}
	});

	it("keeps schedules with different ids apart", async () => {
		const j = journal();
		try {
			await commit(j, [cronEffect(), cronEffect({ scheduleId: "hourly" })]);
			const rows = j
				.getDriver()
				.prepare("SELECT COUNT(*) AS n FROM cron_schedules")
				.get();
			expect(Number(rows?.n)).toBe(2);
		} finally {
			j.close();
		}
	});
});

describe("mixed effects in one commit", () => {
	it("stages every kind atomically and reports a receipt for each", async () => {
		const j = journal();
		try {
			const result = await commit(j, [
				outboxEffect(),
				cronEffect(),
				{
					kind: "timer",
					timerKind: "reminder",
					subjectId: "subj",
					idempotencyKey: "t1",
					dueAt: NOW,
					payload: {},
				},
				{
					kind: "queue",
					queueName: "work",
					idempotencyKey: "q1",
					body: { job: 1 },
				},
			]);
			expect(result.effects.map((effect) => effect.kind)).toEqual([
				"outbox",
				"cron",
				"timer",
				"queue",
			]);
			expect(result.appended).toHaveLength(1);
		} finally {
			j.close();
		}
	});

	it("commits the events and the effects together or not at all", async () => {
		const j = journal();
		try {
			await commit(j, [outboxEffect(), cronEffect()]);
			expect(j.getStreamHead("s1")?.revision).toBe(1);
			expect(claim(j)).toHaveLength(1);
			const cron = j
				.getDriver()
				.prepare("SELECT COUNT(*) AS n FROM cron_schedules")
				.get();
			expect(Number(cron?.n)).toBe(1);
		} finally {
			j.close();
		}
	});

	it("accepts a commit with no effects at all", async () => {
		const j = journal();
		try {
			const result = await commit(j, []);
			expect(result.effects).toEqual([]);
			expect(result.appended).toHaveLength(1);
		} finally {
			j.close();
		}
	});
});
