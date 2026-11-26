import assert from "node:assert/strict";

import {
	type ClockReplayResult,
	type ClockTraceEntry,
	createClockReplayResult,
	type FiredTimer,
	NondeterministicClockError,
	parseRunId,
	parseScheduleId,
} from "@hobo/core";

import { createLocalClock } from "./clock.js";
import { createLocalQueue } from "./queue.js";
import {
	cloneStore,
	formatInstant,
	normalizeStore,
	parseInstantMs,
	type RuntimeLocalQueueClockOptions,
	snapshotStore,
} from "./queue-clock-store.js";

export function createRuntimeLocalQueueClock(
	options: RuntimeLocalQueueClockOptions = {},
) {
	const store = normalizeStore(options);

	return Object.freeze({
		queue: createLocalQueue(store),
		clock: createLocalClock(store),
		snapshot() {
			return snapshotStore(store);
		},
	});
}

export type RuntimeLocalQueueClock = ReturnType<
	typeof createRuntimeLocalQueueClock
>;

export function replayClockTrace(
	trace: readonly ClockTraceEntry[],
	options: { seed?: string } = {},
): ClockReplayResult {
	const entries = cloneRequiredArray(trace, "trace");
	const started = entries.find((entry) => entry.type === "clock.started");

	if (started?.type !== "clock.started") {
		throw new NondeterministicClockError("trace is missing clock.started");
	}
	if (options.seed !== undefined && options.seed !== started.seed) {
		throw new NondeterministicClockError(
			`seed mismatch: expected ${started.seed}, got ${options.seed}`,
		);
	}

	const replay = createRuntimeLocalQueueClock({
		seed: started.seed,
		startInstant: formatInstant(started.atMs),
	});
	const actualFires: NormalizedFireTraceEntry[] = [];

	for (const entry of entries) {
		if (entry.type === "timer.scheduled") {
			replay.clock.sleep(parseRunId(entry.runId), entry.delayMs, {
				idempotencyKey: entry.idempotencyKey,
				...(entry.label !== undefined ? { label: entry.label } : undefined),
			});
		} else if (entry.type === "cron.scheduled") {
			replay.clock.cron(parseScheduleId(entry.scheduleId), {
				everyMs: entry.everyMs,
				startAtMs: entry.startAtMs,
			});
		} else if (entry.type === "clock.advanced") {
			actualFires.push(
				...replay.clock.advance(entry.deltaMs).map(normalizeFiredTraceEntry),
			);
		}
	}

	const expectedFires = entries
		.filter(
			(entry) => entry.type === "timer.fired" || entry.type === "cron.fired",
		)
		.map(normalizeFiredTraceEntry);

	try {
		assert.deepEqual(actualFires, expectedFires);
	} catch {
		throw new NondeterministicClockError(
			"replay fire facts diverged from live trace",
		);
	}

	return createClockReplayResult({
		seed: started.seed,
		fire_order: actualFires.map((fire) => fire.fireId),
		final_now: replay.clock.now(),
	});
}

type NormalizedFireTraceEntry =
	| {
			type: "timer.fired";
			fireId: string;
			timerId: string;
			runId: string;
			atMs: number;
			order: number;
	  }
	| {
			type: "cron.fired";
			fireId: string;
			scheduleId: string;
			occurrence: number;
			atMs: number;
			order: number;
	  };

function normalizeFiredTraceEntry(
	entry: ClockTraceEntry | FiredTimer,
): NormalizedFireTraceEntry {
	if ("type" in entry && entry.type === "timer.fired") {
		return Object.freeze({
			type: "timer.fired",
			fireId: entry.fireId,
			timerId: entry.timerId,
			runId: entry.runId,
			atMs: entry.atMs,
			order: entry.order,
		});
	}
	if ("type" in entry && entry.type === "cron.fired") {
		return Object.freeze({
			type: "cron.fired",
			fireId: entry.fireId,
			scheduleId: entry.scheduleId,
			occurrence: entry.occurrence,
			atMs: entry.atMs,
			order: entry.order,
		});
	}
	if ("kind" in entry && entry.kind === "sleep") {
		return Object.freeze({
			type: "timer.fired",
			fireId: entry.fireId,
			timerId: entry.timerId ?? "",
			runId: entry.runId ?? "",
			atMs: parseInstantMs(entry.at, "fire.at"),
			order: entry.order,
		});
	}
	if ("kind" in entry && entry.kind === "cron") {
		return Object.freeze({
			type: "cron.fired",
			fireId: entry.fireId,
			scheduleId: entry.scheduleId ?? "",
			occurrence: entry.occurrence ?? 0,
			atMs: parseInstantMs(entry.at, "fire.at"),
			order: entry.order,
		});
	}
	throw new NondeterministicClockError("unknown fire trace entry");
}

function cloneRequiredArray<T>(value: readonly T[], fieldName: string): T[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`${fieldName} must be an array`);
	}
	return cloneStore([...value]);
}
