import { must } from "@hobo/core/total-access";
import {
	cloneAsJson,
	isJsonObject,
	type JsonValue,
	parseJsonValue,
} from "../json.js";
import { createDeterministicContext } from "./context.js";
import { digest, ReplayDivergenceError } from "./divergence.js";
import { stableStringify } from "./equivalence.js";
import { nextEnvelope, recordEffect } from "./recorder.js";
import { canonicalStateBytes } from "./replayer.js";
import { createInMemoryEventStore } from "./store.js";

export interface WorkflowHandlers<S, A> {
	name: string;
	initialState(args: A): S;
	onStart?: (ctx: RuntimeContext, state: S, args: A) => S | Promise<S>;
	onHook?: (
		ctx: RuntimeContext,
		state: S,
		payload: JsonValue,
	) => S | Promise<S>;
	onTimer?: (ctx: RuntimeContext, state: S, timer: TimerRef) => S | Promise<S>;
}

export interface RuntimeContext {
	runId: string;
	seed: string;
	now(): string;
	random(label?: string): number;
	step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
	sleep(delayMs: number, options?: { id?: string; label?: string }): TimerRef;
	emit(type: string, data?: JsonValue): { type: string; data: JsonValue };
	waitForHook(name?: string): HookRef;
}

export interface TimerRef {
	timerId: string;
	label?: string;
	fireAt: string;
}

export interface HookRef {
	name: string;
	waitingAt: string;
}

export interface RunRef {
	runId: string;
}

export interface TestRuntime {
	start<S, A>(workflow: WorkflowHandlers<S, A>, args: A): Promise<RunRef>;
	resumeHook(run: RunRef, payload: JsonValue): Promise<RunRef>;
	state<S>(run: RunRef): Promise<S>;
	replay<S>(run: RunRef): Promise<S>;
	clock: { advance(ms: number): Promise<void>; now(): string };
}

interface RunRecord<S, A> {
	runId: string;
	workflow: WorkflowHandlers<S, A>;
	args: A;
	state: S;
	streamId: string;
	nextSeq: number;
	stepIndex: number;
	timers: TimerRecord[];
	trace: TraceEntry[];
}

interface TimerRecord {
	timerId: string;
	label?: string;
	delayMs: number;
	fireAtMs: number;
	fired: boolean;
}

type TraceEntry =
	| { type: "hook.waiting"; hook: HookRef; atMs: number }
	| {
			type: "timer.scheduled";
			timerId: string;
			label?: string;
			delayMs: number;
			fireAtMs: number;
	  }
	| {
			type: "timer.fired";
			timerId: string;
			label?: string;
			atMs: number;
			fireAtMs: number;
	  }
	| { type: "hook.resumed"; payload: JsonValue; atMs: number };

export function defineWorkflow<S, A>(
	name: string,
	handlers: Omit<WorkflowHandlers<S, A>, "name">,
) {
	return Object.freeze({ ...handlers, name });
}

export function testRuntime(
	options: { seed?: string; startInstant?: string } = {},
): TestRuntime {
	const store = createInMemoryEventStore();
	const seed = options.seed ?? "runtime-local-test-seed";
	let nowMs = Date.parse(options.startInstant ?? "2026-06-26T00:00:00.000Z");
	let timerSeq = 1;
	const runs = new Map<string, RunRecord<JsonValue, JsonValue>>();

	async function appendRunEvent<S, A>(
		run: RunRecord<S, A>,
		type: string,
		data: JsonValue,
	) {
		run.nextSeq += 1;
		await recordEffect(
			store,
			nextEnvelope(run.streamId, run.nextSeq, type, data, {
				ts: formatInstant(nowMs),
				meta: { idempotencyKey: `${run.runId}:${type}:${run.nextSeq}` },
			}),
			run.nextSeq - 1,
		);
	}

	function createCtx<S, A>(
		run: RunRecord<S, A>,
		record: boolean,
	): RuntimeContext {
		const orchestrationKey = `${run.streamId}:orchestration`;
		const seeded = createDeterministicContext({
			seed,
			mode: record ? "live" : "replay",
			eventKey: orchestrationKey,
		});
		const replayTimers = record
			? null
			: {
					entries: run.trace.filter(
						(entry) => entry.type === "timer.scheduled",
					),
					index: 0,
				};

		return Object.freeze({
			runId: run.runId,
			seed,
			now: () => seeded.now(),
			random: (label?: string) => seeded.random(label),
			async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
				const index = run.stepIndex;
				if (record) {
					await appendRunEvent(run, "run.StepScheduled", { name, index });
					const result = await fn();
					await appendRunEvent(
						run,
						"run.StepCompleted",
						cloneAsJson({ name, index, result }),
					);
					run.stepIndex += 1;
					return result;
				}
				const events = await store.readStream(run.streamId);
				const completed = events.find(
					(event) =>
						event.type === "run.StepCompleted" &&
						event.data &&
						isJsonObject(event.data) &&
						// SAFETY: assertion to `event.data as { name?: string; index?: number }` is required at this boundary.
						(event.data as { name?: string; index?: number }).name === name &&
						// SAFETY: assertion to `event.data as { name?: string; index?: number }` is required at this boundary.
						(event.data as { name?: string; index?: number }).index === index,
				);
				if (!completed) {
					throw new ReplayDivergenceError({
						runId: run.runId,
						liveState: { missingStep: name, index },
						replayState: {},
						liveOrder: events.map((event) => event.type),
						replayOrder: [],
					});
				}
				run.stepIndex += 1;
				// SAFETY: assertion to `completed.data as { result: T }` is required at this boundary.
				return (completed.data as { result: T }).result;
			},
			sleep(delayMs: number, options: { id?: string; label?: string } = {}) {
				if (!record) {
					return replaySleep(delayMs, options, must(replayTimers), run.runId);
				}
				const timerId = options.id ?? `timer-${timerSeq++}`;
				const timer: TimerRecord = {
					timerId,
					delayMs,
					fireAtMs: nowMs + delayMs,
					fired: false,
				};
				if (options.label !== undefined) {
					timer.label = options.label;
				}
				run.timers.push(timer);
				const scheduled: TraceEntry = {
					type: "timer.scheduled",
					timerId,
					delayMs,
					fireAtMs: timer.fireAtMs,
				};
				if (timer.label !== undefined) {
					scheduled.label = timer.label;
				}
				run.trace.push(scheduled);
				return toTimerRef(timer);
			},
			emit(type: string, data: JsonValue = {}) {
				return { type, data };
			},
			waitForHook(name = "default") {
				const hook = { name, waitingAt: formatInstant(nowMs) };
				if (record) {
					run.trace.push({ type: "hook.waiting", hook, atMs: nowMs });
				}
				return hook;
			},
		});
	}

	async function applyHandler<S, A, I>(
		run: RunRecord<S, A>,
		handler:
			| ((ctx: RuntimeContext, state: S, input: I) => S | Promise<S>)
			| undefined,
		input: I,
		record: boolean,
	) {
		if (!handler) {
			return;
		}
		const ctx = createCtx(run, record);
		const next = await handler(ctx, clone(run.state), input);
		if (next !== undefined) {
			run.state = clone(next);
		}
	}

	async function replayRunRecord<S, A>(run: RunRecord<S, A>) {
		return withReplayAmbientPoisoning(async () => {
			const replay: RunRecord<S, A> = {
				...run,
				state: run.workflow.initialState(clone(run.args)),
				stepIndex: 0,
				timers: [],
				trace: run.trace,
			};

			await applyHandler(replay, run.workflow.onStart, clone(run.args), false);
			for (const entry of run.trace) {
				if (entry.type === "hook.resumed") {
					await applyHandler(replay, run.workflow.onHook, entry.payload, false);
				} else if (entry.type === "timer.fired") {
					await applyHandler(
						replay,
						run.workflow.onTimer,
						toTimerRef({
							timerId: entry.timerId,
							delayMs: 0,
							fireAtMs: entry.fireAtMs,
							fired: true,
							...(entry.label !== undefined
								? { label: entry.label }
								: undefined),
						}),
						false,
					);
				}
			}
			return replay;
		});
	}

	return {
		clock: {
			now() {
				return formatInstant(nowMs);
			},
			advance(ms: number) {
				nowMs += ms;
				const pending: Promise<void>[] = [];
				for (const run of runs.values()) {
					for (const timer of run.timers) {
						if (!timer.fired && timer.fireAtMs <= nowMs) {
							timer.fired = true;
							run.trace.push({
								type: "timer.fired",
								timerId: timer.timerId,
								atMs: nowMs,
								fireAtMs: timer.fireAtMs,
								...(timer.label !== undefined
									? { label: timer.label }
									: undefined),
							});
							pending.push(
								applyHandler(
									run,
									run.workflow.onTimer,
									toTimerRef(timer),
									true,
								).then(() => undefined),
							);
						}
					}
				}
				return Promise.all(pending).then(() => undefined);
			},
		},

		async start<S, A>(
			workflow: WorkflowHandlers<S, A>,
			args: A,
		): Promise<RunRef> {
			const runId = `run-${runs.size + 1}`;
			const run: RunRecord<S, A> = {
				runId,
				workflow,
				args: clone(args),
				state: workflow.initialState(clone(args)),
				streamId: `run/${runId}`,
				nextSeq: 0,
				stepIndex: 0,
				timers: [],
				trace: [],
			};
			// SAFETY: assertion to `run as RunRecord<JsonValue, JsonValue>` is required at this boundary.
			// SAFETY: run records are stored erased across workflow generics.
			runs.set(runId, run as never);
			await appendRunEvent(run, "run.Started", cloneAsJson({ seed, args }));
			await applyHandler(run, workflow.onStart, clone(args), true);
			return { runId };
		},

		async resumeHook(runRef, payload) {
			const run = getRun(runs, runRef);
			run.trace.push({
				type: "hook.resumed",
				payload: clone(payload),
				atMs: nowMs,
			});
			await appendRunEvent(run, "run.HookResumed", { payload });
			await applyHandler(run, run.workflow.onHook, clone(payload), true);
			return { runId: run.runId };
		},

		async state<S>(runRef: RunRef): Promise<S> {
			// SAFETY: assertion to `clone(getRun(runs, runRef).state) as S` is required at this boundary.
			return clone(getRun(runs, runRef).state) as S;
		},

		async replay<S>(runRef: RunRef): Promise<S> {
			const run = getRun(runs, runRef);
			const replayed = await replayRunRecord(run);
			const events = await store.readStream(run.streamId);

			if (
				digest(run.state) !== digest(replayed.state) ||
				canonicalStateBytes(run.state) !== canonicalStateBytes(replayed.state)
			) {
				throw new ReplayDivergenceError({
					runId: run.runId,
					liveState: run.state,
					replayState: replayed.state,
					liveOrder: events.map(
						(event) => `${event.streamId}:${event.seq}:${event.type}`,
					),
					replayOrder: [...events]
						.sort(
							(left, right) =>
								left.streamId.localeCompare(right.streamId) ||
								left.seq - right.seq,
						)
						.map((event) => `${event.streamId}:${event.seq}:${event.type}`),
				});
			}

			// SAFETY: assertion to `clone(replayed.state) as S` is required at this boundary.
			return clone(replayed.state) as S;
		},
	};
}

export { canonicalStateBytes, ReplayDivergenceError, stableStringify };

function replaySleep(
	delayMs: number,
	options: { id?: string; label?: string },
	replayTimers: { entries: TraceEntry[]; index: number },
	runId: string,
): TimerRef {
	const recorded = replayTimers.entries[replayTimers.index++];
	if (recorded?.type !== "timer.scheduled") {
		throw new ReplayDivergenceError({
			runId,
			liveState: {},
			replayState: {},
			liveOrder: [],
			replayOrder: [],
			firstDivergentEventKey: "timer",
		});
	}
	if (
		recorded.delayMs !== delayMs ||
		(options.id !== undefined && recorded.timerId !== options.id) ||
		(options.label !== undefined && recorded.label !== options.label)
	) {
		throw new ReplayDivergenceError({
			runId,
			liveState: { recorded },
			replayState: { delayMs, options },
			liveOrder: [],
			replayOrder: [],
			firstDivergentEventKey: "timer",
		});
	}
	return toTimerRef({
		timerId: recorded.timerId,
		delayMs: recorded.delayMs,
		fireAtMs: recorded.fireAtMs,
		fired: true,
		...(recorded.label !== undefined ? { label: recorded.label } : undefined),
	});
}

function toTimerRef(timer: TimerRecord): TimerRef {
	const ref: TimerRef = {
		timerId: timer.timerId,
		fireAt: formatInstant(timer.fireAtMs),
	};
	if (timer.label !== undefined) {
		ref.label = timer.label;
	}
	return ref;
}

function getRun(
	runs: Map<string, RunRecord<JsonValue, JsonValue>>,
	runRef: RunRef,
) {
	const run = runs.get(runRef.runId);
	if (!run) {
		throw new TypeError(`unknown run ${runRef.runId}`);
	}
	return run;
}

function formatInstant(ms: number): string {
	return new Date(ms).toISOString();
}

function clone<T>(value: T): T {
	if (structuredClone instanceof Function) {
		return structuredClone(value);
	}
	const cloned = parseJsonValue(JSON.stringify(value));
	// SAFETY: JSON round-trip preserves T at this clone fallback.
	return cloned as T;
}

function withReplayAmbientPoisoning<T>(
	callback: () => T | Promise<T>,
): T | Promise<T> {
	const originalDateNow = Date.now;
	const originalMathRandom = Math.random;
	Date.now = () => 2_000_000_000_000;
	Math.random = () => 0.999999999;
	try {
		return callback();
	} finally {
		Date.now = originalDateNow;
		Math.random = originalMathRandom;
	}
}
