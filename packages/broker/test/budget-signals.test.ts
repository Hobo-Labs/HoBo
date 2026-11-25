import assert from "node:assert/strict";
import {
	createMemoryNodeSqliteDriver,
	SqliteJournal,
} from "@hobo/storage-sqlite";
import { test } from "vitest";

import {
	BUDGET_EVENTS,
	budgetSignalEventInputs,
	foldBudgetSignals,
} from "../src/budget-signals.js";
import { METER_USAGE_RECORDED_EVENT } from "../src/metering.js";

function usage(costUsd: number, tenantId = "tenant-a") {
	return {
		type: METER_USAGE_RECORDED_EVENT,
		data: { tenantId, costUsd, resource: "traffic" },
	};
}

function credit(amountUsd: number, tenantId = "tenant-a") {
	return {
		type: BUDGET_EVENTS.CreditApplied,
		data: { tenantId, amountUsd },
	};
}

const POLICY = { budgetUsd: 100, thresholds: [0.8, 1], tenantId: "tenant-a" };

test("crossing a threshold emits budget.ThresholdCrossed exactly once while spend stays above it", () => {
	const { state, signals } = foldBudgetSignals(
		[usage(50), usage(35), usage(5), usage(5)],
		POLICY,
	);

	assert.equal(state.netSpentUsd, 95);
	assert.equal(signals.length, 1);
	assert.equal(signals[0].type, BUDGET_EVENTS.ThresholdCrossed);
	assert.equal(signals[0].data.thresholdFraction, 0.8);
	assert.equal(signals[0].data.cycle, 1);
});

test("credit below the threshold emits budget.Recovered; re-crossing starts a new cycle", () => {
	const { signals } = foldBudgetSignals(
		[usage(90), credit(40), usage(45)],
		POLICY,
	);

	assert.deepEqual(
		signals.map((signal) => [
			signal.type,
			signal.data.thresholdFraction,
			signal.data.cycle,
		]),
		[
			[BUDGET_EVENTS.ThresholdCrossed, 0.8, 1],
			[BUDGET_EVENTS.Recovered, 0.8, 2],
			[BUDGET_EVENTS.ThresholdCrossed, 0.8, 3],
		],
	);
});

test("hard-budget crossing fires both threshold fractions with distinct keys", () => {
	const { signals } = foldBudgetSignals([usage(120)], POLICY);

	assert.deepEqual(
		signals.map((signal) => signal.data.thresholdFraction),
		[0.8, 1],
	);
	assert.equal(new Set(signals.map((signal) => signal.data.signalKey)).size, 2);
});

test("facts for other tenants are not folded into a scoped policy", () => {
	const { state, signals } = foldBudgetSignals(
		[usage(90, "tenant-b"), usage(10, "tenant-a")],
		POLICY,
	);

	assert.equal(state.netSpentUsd, 10);
	assert.equal(signals.length, 0);
});

test("versioned budget identity separates budgets, periods and cap revisions with explicit reset facts", () => {
	const identity = {
		tenantId: "tenant-a",
		budgetId: "hosting",
		periodId: "2026-10",
		policyRevision: "r1",
	};
	const scopedPolicy = { budgetUsd: 100, identity };
	const facts = [
		{
			type: METER_USAGE_RECORDED_EVENT,
			data: {
				tenantId: "tenant-a",
				budgetId: "hosting",
				periodId: "2026-10",
				costUsd: 75,
			},
		},
	];
	const first = foldBudgetSignals(facts, scopedPolicy);
	assert.equal(first.signals[0]?.type, BUDGET_EVENTS.StateReset);
	assert.equal(first.state.netSpentUsd, 75);
	assert.equal(
		foldBudgetSignals([...facts, ...first.signals], scopedPolicy).signals
			.length,
		0,
	);
	const revised = foldBudgetSignals([...facts, ...first.signals], {
		budgetUsd: 50,
		identity: { ...identity, policyRevision: "r2" },
	});
	assert.deepEqual(
		revised.signals.map((signal) => signal.type),
		[BUDGET_EVENTS.StateReset, BUDGET_EVENTS.ThresholdCrossed],
	);
	assert.notEqual(
		revised.signals[0]?.data.signalKey,
		first.signals[0]?.data.signalKey,
	);
	assert.throws(
		() =>
			foldBudgetSignals([...facts, ...first.signals], {
				budgetUsd: 50,
				identity,
			}),
		/without a policy revision/,
	);
	const nextPeriod = foldBudgetSignals([...facts, ...first.signals], {
		budgetUsd: 100,
		identity: { ...identity, periodId: "2026-11" },
	});
	assert.equal(nextPeriod.state.netSpentUsd, 0);
	assert.equal(nextPeriod.signals[0]?.type, BUDGET_EVENTS.StateReset);
	const anotherBudget = foldBudgetSignals(facts, {
		budgetUsd: 100,
		identity: { ...identity, budgetId: "storage" },
	});
	assert.equal(anotherBudget.state.netSpentUsd, 0);
	assert.notEqual(
		anotherBudget.signals[0]?.data.signalKey,
		first.signals[0]?.data.signalKey,
	);
});

test("zero is an explicitly exhausted versioned budget and duplicate thresholds are invalid", () => {
	const identity = {
		tenantId: "tenant-a",
		budgetId: "hosting",
		periodId: "2026-10",
		policyRevision: "r1",
	};
	const zero = foldBudgetSignals([], { budgetUsd: 0, identity });
	assert.equal(zero.state.crossed["1"], true);
	assert.equal(zero.signals[0]?.data.crossed, true);
	assert.throws(
		() => foldBudgetSignals([], { budgetUsd: 100, thresholds: [1, 1] }),
		/thresholds/,
	);
});

test("milestone: replaying the journal twice emits each threshold signal exactly once and matches golden state", async () => {
	const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
		clock: { now: () => "2026-08-03T00:00:00.000Z" },
	});
	const actor = { kind: "service" as const, id: "broker-test" };
	const stream = "budget-tenant-a";

	await journal.append(
		stream,
		[usage(50), usage(45), credit(20), usage(30)].map((fact) => ({
			type: fact.type,
			data: fact.data,
		})),
		{ expectedSeq: 0, actor, tenant: "tenant-a" },
	);

	async function runPipelineOnce() {
		const events: { type: string; data?: unknown }[] = [];
		for await (const positioned of journal.readAll()) {
			events.push({ type: positioned.event.type, data: positioned.event.data });
		}
		const fold = foldBudgetSignals(events, POLICY);
		const inputs = budgetSignalEventInputs(fold.signals);
		let appended = 0;
		if (inputs.length > 0) {
			const revision = journal.getStreamHead(stream)?.revision ?? 0;
			const result = await journal.append(stream, inputs, {
				expectedSeq: revision,
				actor,
				tenant: "tenant-a",
			});
			appended = result.appended.length;
		}
		return { fold, appended };
	}

	// usage 50 -> 95 (cross 0.8) -> credit to 75 (recover 0.8) -> 105
	// (re-cross 0.8, cross 1.0): four distinct signal identities.
	const first = await runPipelineOnce();
	assert.deepEqual(
		first.fold.signals.map((signal) => [
			signal.type,
			signal.data.thresholdFraction,
			signal.data.cycle,
		]),
		[
			[BUDGET_EVENTS.ThresholdCrossed, 0.8, 1],
			[BUDGET_EVENTS.Recovered, 0.8, 2],
			[BUDGET_EVENTS.ThresholdCrossed, 0.8, 3],
			[BUDGET_EVENTS.ThresholdCrossed, 1, 1],
		],
	);
	assert.equal(first.appended, 4);

	// Second replay of the same journal: recorded signals are seen, nothing
	// new is emitted or appended.
	const second = await runPipelineOnce();
	assert.equal(second.fold.signals.length, 0);
	assert.equal(second.appended, 0);

	// Golden materialized budget state after replay.
	assert.deepEqual(second.fold.state, {
		tenantId: "tenant-a",
		budgetUsd: 100,
		spentUsd: 125,
		creditUsd: 20,
		netSpentUsd: 105,
		sampleCount: 3,
		crossed: { "0.8": true, "1": true },
	});

	// Even a blind re-append of the first fold's signals is journal-deduped
	// via meta.idempotencyKey.
	const revision = journal.getStreamHead(stream)?.revision ?? 0;
	const blind = await journal.append(
		stream,
		budgetSignalEventInputs(first.fold.signals),
		{ expectedSeq: revision, actor, tenant: "tenant-a" },
	);
	assert.equal(blind.appended.length, 0);
	assert.equal(blind.deduped.length, 4);

	journal.close();
});
