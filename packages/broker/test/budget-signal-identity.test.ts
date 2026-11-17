import {
	createMemoryNodeSqliteDriver,
	SqliteJournal,
} from "@hobo/storage-sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BUDGET_EVENTS,
	budgetSignalEventInputs,
	foldBudgetSignals,
} from "../src/budget-signals.js";

const policy = { budgetUsd: 100, thresholds: [0.5, 1], tenantId: "tenant-a" };
const usage = (costUsd: number) => ({
	type: "meter.UsageRecorded",
	data: { tenantId: "tenant-a", costUsd },
});

describe("budget signal replay identity", () => {
	it("does not let a foreign tenant suppress a threshold signal", () => {
		const facts = [usage(120)];
		const expected = foldBudgetSignals(facts, policy).signals;
		const first = expected[0];
		if (!first) throw new Error("fixture signal missing");
		const foreign = { ...first, data: { ...first.data, tenantId: "tenant-b" } };
		// Its copied key could already occupy the journal's idempotency slot.
		expect(() => foldBudgetSignals([...facts, foreign], policy)).toThrow(
			/signal.*conflict/iu,
		);
		const separate = foldBudgetSignals(
			[
				{
					type: "meter.UsageRecorded",
					data: { tenantId: "tenant-b", costUsd: 120 },
				},
			],
			{ ...policy, tenantId: "tenant-b" },
		).signals;
		expect(foldBudgetSignals([...facts, ...separate], policy).signals).toEqual(
			expected,
		);
	});

	it("refuses a same-scope signal whose key conflicts with the reconstructed transition", () => {
		const facts = [usage(120)];
		const first = foldBudgetSignals(facts, policy).signals[0];
		if (!first) throw new Error("fixture signal missing");
		const corrupt = { ...first, data: { ...first.data, netSpentUsd: 0 } };
		expect(() => foldBudgetSignals([...facts, corrupt], policy)).toThrow(
			/signal.*(conflict|reconcil)/iu,
		);
	});

	it("does not let an identical record hide another conflicting record", () => {
		const facts = [usage(120)];
		const first = foldBudgetSignals(facts, policy).signals[0];
		if (!first) throw new Error("fixture signal missing");
		const corrupt = { ...first, data: { ...first.data, netSpentUsd: 0 } };
		for (const entries of [
			[first, corrupt],
			[corrupt, first],
		])
			expect(() => foldBudgetSignals([...facts, ...entries], policy)).toThrow(
				/signal.*conflict/iu,
			);
	});

	it("refuses same-key changes to the signal kind, threshold or cycle", () => {
		const facts = [usage(120)];
		const first = foldBudgetSignals(facts, policy).signals[0];
		if (!first) throw new Error("fixture signal missing");
		const corruptions = [
			{ ...first, type: BUDGET_EVENTS.Recovered },
			{ ...first, data: { ...first.data, thresholdFraction: 1 } },
			{ ...first, data: { ...first.data, cycle: first.data.cycle + 1 } },
		];
		for (const corrupt of corruptions)
			expect(() => foldBudgetSignals([...facts, corrupt], policy)).toThrow(
				/signal.*conflict/iu,
			);
	});

	it("does not let another budget period suppress a versioned reset", () => {
		const identity = {
			tenantId: "tenant-a",
			budgetId: "hosting",
			periodId: "p1",
			policyRevision: "r1",
		};
		const scoped = { budgetUsd: 100, identity };
		const expected = foldBudgetSignals([], scoped).signals;
		const reset = expected[0];
		if (!reset?.data.identity) throw new Error("fixture reset missing");
		const foreign = {
			...reset,
			data: {
				...reset.data,
				identity: { ...reset.data.identity, periodId: "p2" },
			},
		};
		expect(foreign.type).toBe(BUDGET_EVENTS.StateReset);
		expect(() => foldBudgetSignals([foreign], scoped)).toThrow(
			/signal.*conflict/iu,
		);
		const separate = foldBudgetSignals([], {
			...scoped,
			identity: { ...identity, periodId: "p2" },
		}).signals;
		expect(foldBudgetSignals(separate, scoped).signals).toEqual(expected);
	});

	it("refuses a signal key occupied by another event or inconsistent metadata", () => {
		const facts = [usage(120)];
		const first = foldBudgetSignals(facts, policy).signals[0];
		if (!first) throw new Error("fixture signal missing");
		const occupied = {
			type: "other.Event",
			data: {},
			meta: { idempotencyKey: first.data.signalKey },
		};
		expect(() => foldBudgetSignals([...facts, occupied], policy)).toThrow(
			/signal.*conflict/iu,
		);
		const badMeta = { ...first, meta: { idempotencyKey: "different-key" } };
		expect(() => foldBudgetSignals([...facts, badMeta], policy)).toThrow(
			/signal.*conflict/iu,
		);
	});

	it("detects an occupied idempotency key when replaying a real SQLite journal", async () => {
		const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
			clock: { now: () => "2026-08-03T00:00:00.000Z" },
		});
		try {
			const stream = "budget-collision";
			const actor = { kind: "service" as const, id: "broker-test" };
			const facts = [usage(120)];
			const first = foldBudgetSignals(facts, policy).signals[0];
			if (!first) throw new Error("fixture signal missing");
			await journal.append(
				stream,
				[
					...facts,
					{
						type: "other.Event",
						data: {},
						meta: { idempotencyKey: first.data.signalKey },
					},
				],
				{ expectedSeq: 0, actor, tenant: "tenant-a" },
			);
			const events: Array<{ type: string; data?: unknown; meta?: unknown }> =
				[];
			for await (const event of journal.read(stream)) events.push(event);
			expect(() => foldBudgetSignals(events, policy)).toThrow(
				/signal.*conflict/iu,
			);
			const result = await journal.append(
				stream,
				budgetSignalEventInputs([first]),
				{
					expectedSeq: journal.getStreamHead(stream)?.revision ?? 0,
					actor,
					tenant: "tenant-a",
				},
			);
			expect(result.appended).toHaveLength(0);
			expect(result.deduped).toHaveLength(1);
		} finally {
			journal.close();
		}
	});

	it("refuses unknown scoped usage instead of emitting an unsupported recovery", () => {
		const unknown = {
			type: "meter.UsageRecorded",
			data: { tenantId: "tenant-a" },
		};
		const credit = {
			type: BUDGET_EVENTS.CreditApplied,
			data: { tenantId: "tenant-a", amountUsd: 50 },
		};
		expect(() =>
			foldBudgetSignals([usage(120), unknown, credit], policy),
		).toThrow(/usage|charge/iu);
		const foreign = { ...unknown, data: { tenantId: "tenant-b" } };
		expect(
			foldBudgetSignals([usage(120), foreign, credit], policy).signals.map(
				(signal) => signal.type,
			),
		).toContain(BUDGET_EVENTS.Recovered);
	});

	it("refuses financial facts whose scope cannot be attributed", () => {
		const unscoped = { type: "meter.UsageRecorded", data: { costUsd: 1 } };
		expect(() => foldBudgetSignals([unscoped], policy)).toThrow(
			/scope|tenant/iu,
		);
		const identity = {
			tenantId: "tenant-a",
			budgetId: "hosting",
			periodId: "p1",
			policyRevision: "r1",
		};
		expect(() =>
			foldBudgetSignals([usage(1)], { budgetUsd: 100, identity }),
		).toThrow(/scope|budget|period/iu);
	});

	it("refuses invalid scoped credits and overflowing totals", () => {
		const invalidCredit = {
			type: BUDGET_EVENTS.CreditApplied,
			data: { tenantId: "tenant-a", amountUsd: -1 },
		};
		expect(() => foldBudgetSignals([invalidCredit], policy)).toThrow(
			/credit/iu,
		);
		expect(() =>
			foldBudgetSignals(
				[usage(Number.MAX_VALUE), usage(Number.MAX_VALUE)],
				policy,
			),
		).toThrow(/spend|usage/iu);
	});

	it("deduplicates matching replays while ignoring foreign signals in generated histories", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						credit: fc.boolean(),
						amount: fc.integer({ min: 0, max: 120 }),
					}),
					{ maxLength: 8 },
				),
				(entries) => {
					const facts = entries.map(({ credit, amount }) =>
						credit
							? {
									type: BUDGET_EVENTS.CreditApplied,
									data: { tenantId: "tenant-a", amountUsd: amount },
								}
							: usage(amount),
					);
					const expected = foldBudgetSignals(facts, policy).signals;
					expect(
						foldBudgetSignals([...facts, ...expected], policy).signals,
					).toEqual([]);
					const foreignFacts = facts.map((fact) => ({
						...fact,
						data: { ...fact.data, tenantId: "tenant-b" },
					}));
					const foreign = foldBudgetSignals(foreignFacts, {
						...policy,
						tenantId: "tenant-b",
					}).signals;
					expect(
						foldBudgetSignals([...facts, ...foreign], policy).signals,
					).toEqual(expected);
					if (expected.length) {
						const colliding = expected.map((signal) => ({
							...signal,
							data: { ...signal.data, tenantId: "tenant-b" },
						}));
						expect(() =>
							foldBudgetSignals([...facts, ...colliding], policy),
						).toThrow(/signal.*conflict/iu);
					}
				},
			),
			{ seed: 614508, numRuns: 500 },
		);
	});
});
