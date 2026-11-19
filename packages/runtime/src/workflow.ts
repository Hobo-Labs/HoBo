// `workflow` / `step` — durable, replayable orchestration (sdk-api.md §Layer 4,
// lowering onto `hobo:runtime/workflow`). Each `ctx.step` result is journaled as
// `run.StepCompleted`, so after a host restart the engine replays the journal:
// completed steps are read back (never re-run) and execution resumes from the
// tip. The journal it writes is the same `run.*` shape the existing replay
// engine (`./replay`) verifies, so a completed run is replay-equivalent.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type Capability,
	type CtxEffects,
	createRuntimeContext,
	type RuntimeContext,
	type StepOptions,
	type TokenBroker,
} from "./ctx.js";
import { WorkflowFailure } from "./errors.js";
import {
	cloneAsJson,
	isJsonObject,
	type JsonBag,
	type JsonValue,
} from "./json.js";
import type { ActorHost, RuntimeClock } from "./ports.js";
import { createDeterministicContext } from "./replay/context.js";
import { nextEnvelope, recordEffect } from "./replay/recorder.js";
import type { WorkflowDefinition as ReplayWorkflowDefinition } from "./replay/replayer.js";
import {
	createInMemoryEventStore,
	type EventStoreWriter,
} from "./replay/store.js";
import { runWithRetries } from "./step.js";
import type { WitTokenHandle, WitTokenRequest } from "./wit.js";
import {
	captureWorkflowInput,
	captureWorkflowResult,
	type ParsedRunStepCompleted,
	type ParsedRunStepFailed,
	parseRunCompletedFact,
	parseRunFailedFact,
	parseRunStartedFact,
	parseRunStepCompletedFact,
	parseRunStepFailedFact,
	parseRunStepScheduledFact,
	readJournaledWorkflowResult,
	replayStepCompletedResult,
	requireWorkflowRunId,
	terminalCompletedHandleResult,
} from "./workflow-value.js";

/** Durability primitives are always granted; effect capabilities are declared. */
const DURABILITY_CAPABILITIES: readonly Capability[] = [
	"step",
	"sleep",
	"emit",
];

export interface WorkflowContext extends RuntimeContext {
	readonly runId: string;
	readonly seed: string;
}

export interface WorkflowDefinition<A, R> {
	readonly name: string;
	readonly capabilities: ReadonlySet<Capability>;
	readonly tools: Readonly<
		Record<string, (input: JsonValue) => Promise<JsonValue> | JsonValue>
	>;
	run(ctx: WorkflowContext, args: A): Promise<R> | R;
}

export interface DefineWorkflowInput<A, R> {
	name: string;
	capabilities?: Iterable<Capability>;
	tools?: Record<string, (input: JsonValue) => Promise<JsonValue> | JsonValue>;
	run(ctx: WorkflowContext, args: A): Promise<R> | R;
}

/** Define a durable workflow. */
export function defineWorkflow<A, R>(
	input: DefineWorkflowInput<A, R>,
): WorkflowDefinition<A, R> {
	if (!input.name) {
		throw new TypeError("workflow name must be a non-empty string");
	}
	return Object.freeze({
		name: input.name,
		// SAFETY: assertion to ` Set([ ...DURABILITY_CAPABILITIES, ...(input.capabilities ?? []), ]) as ReadonlySet<Capability>, ` is required at this boundary.
		capabilities: new Set([
			...DURABILITY_CAPABILITIES,
			...(input.capabilities ?? []),
		]) as ReadonlySet<Capability>,
		tools: Object.freeze({ ...input.tools }),
		run: input.run,
	});
}

/** Sugar spelling: `workflow(name, (ctx, args) => …)`. */
export function workflow<A, R>(
	name: string,
	run: (ctx: WorkflowContext, args: A) => Promise<R> | R,
	options: Omit<DefineWorkflowInput<A, R>, "name" | "run"> = {},
): WorkflowDefinition<A, R> {
	return defineWorkflow({ name, run, ...options });
}

export type RunStatus = "completed" | "failed";

export interface WorkflowRunHandle<R> {
	runId: string;
	status: RunStatus;
	result: R | undefined;
	error: { code: string; message: string; step?: string } | undefined;
}

export interface WorkflowEngineOptions {
	store?: EventStoreWriter;
	seed?: string;
	clock?: RuntimeClock;
	actorHost?: ActorHost;
	tokenBroker?: TokenBroker;
}

export interface WorkflowEngine {
	readonly store: EventStoreWriter;
	start<A, R>(
		def: WorkflowDefinition<A, R>,
		args: A,
		options?: { runId?: string },
	): Promise<WorkflowRunHandle<R>>;
	/** Resume after a host restart: replays the journal, continues from the tip. */
	resume<A, R>(
		def: WorkflowDefinition<A, R>,
		runId: string,
		args: A,
	): Promise<WorkflowRunHandle<R>>;
	/** Read the journaled `run.*` events for a run. */
	journal(runId: string): Promise<{ type: string; data: JsonValue }[]>;
	/** Adapt to the existing replay engine (`replayRun`) for replay verification. */
	toReplayDefinition<A, R>(
		def: WorkflowDefinition<A, R>,
	): ReplayWorkflowDefinition<R | null, A>;
}

const DEFAULT_TOKEN_BROKER: TokenBroker = (request: WitTokenRequest) =>
	({
		ref: `stub://${request.provider}/${request.scope}`,
	}) satisfies WitTokenHandle;

function listStepOutcomeIndices(
	journal: ReadonlyArray<{ type: string; data: JsonValue }>,
): number[] {
	const indices: number[] = [];
	for (const event of journal) {
		if (event.type === "run.StepCompleted" && isRecord(event.data)) {
			const fact = parseRunStepCompletedFact(cloneAsJson(event.data));
			indices.push(fact.index);
		} else if (event.type === "run.StepFailed" && isRecord(event.data)) {
			const fact = parseRunStepFailedFact(cloneAsJson(event.data));
			indices.push(fact.index);
		}
	}
	return indices;
}

function maxStepOutcomeIndex(indices: number[]): number {
	let max = -1;
	for (const index of indices) {
		if (index > max) max = index;
	}
	return max;
}

export function createWorkflowEngine(
	options: WorkflowEngineOptions = {},
): WorkflowEngine {
	const store = options.store ?? createInMemoryEventStore();
	const seed = options.seed ?? "hobo-runtime-authoring-seed";
	const tokenBroker = options.tokenBroker ?? DEFAULT_TOKEN_BROKER;
	const actorHost = options.actorHost;

	async function execute<A, R>(
		def: WorkflowDefinition<A, R>,
		runId: string,
		args: A,
	): Promise<WorkflowRunHandle<R>> {
		const streamId = `run/${runId}`;
		const journal = await store.readStream(streamId);
		let seq = journal.at(-1)?.seq ?? 0;
		const startedEvents = journal.filter(
			(event) => event.type === "run.Started",
		);
		if (startedEvents.length !== 1) {
			throw new Error(
				startedEvents.length > 1
					? `duplicate run.Started for ${runId}`
					: `missing run.Started for ${runId}`,
			);
		}
		const started = startedEvents[0];
		if (!started || !isRecord(started.data)) {
			throw new Error(`missing run.Started for ${runId}`);
		}
		const startedFact = parseRunStartedFact(started.data, seed);
		const input = captureWorkflowInput(args);
		if (!isDeepStrictEqual(startedFact.args, cloneAsJson(input))) {
			throw new Error(`workflow input differs from run.Started for ${runId}`);
		}
		const runArgs = input;
		if (
			startedFact.workflowName !== undefined &&
			startedFact.workflowName !== def.name
		) {
			throw new Error(`workflow name differs from run.Started for ${runId}`);
		}
		const scheduledSteps = new Map<number, string>();
		for (const event of journal) {
			if (event.type !== "run.StepScheduled") continue;
			const fact = parseRunStepScheduledFact(cloneAsJson(event.data));
			const previous = scheduledSteps.get(fact.index);
			if (previous !== undefined && previous !== fact.name) {
				throw new Error(`step name differs from journal for ${runId}`);
			}
			scheduledSteps.set(fact.index, fact.name);
		}
		const stepOutcomeCounts = new Map<
			string,
			{ completed: number; failed: number }
		>();
		for (const event of journal) {
			if (event.type === "run.StepCompleted") {
				if (!isRecord(event.data)) {
					throw new Error(`invalid run.StepCompleted for ${runId}`);
				}
				const fact = parseRunStepCompletedFact(cloneAsJson(event.data));
				const scheduled = scheduledSteps.get(fact.index);
				if (scheduled !== undefined && scheduled !== fact.name) {
					throw new Error(`step name differs from journal for ${runId}`);
				}
				const key = String(fact.index);
				const counts = stepOutcomeCounts.get(key) ?? {
					completed: 0,
					failed: 0,
				};
				counts.completed += 1;
				stepOutcomeCounts.set(key, counts);
			} else if (event.type === "run.StepFailed") {
				if (!isRecord(event.data)) {
					throw new Error(`invalid run.StepFailed for ${runId}`);
				}
				const fact = parseRunStepFailedFact(cloneAsJson(event.data));
				const scheduled = scheduledSteps.get(fact.index);
				if (scheduled !== undefined && scheduled !== fact.name) {
					throw new Error(`step name differs from journal for ${runId}`);
				}
				const key = String(fact.index);
				const counts = stepOutcomeCounts.get(key) ?? {
					completed: 0,
					failed: 0,
				};
				counts.failed += 1;
				stepOutcomeCounts.set(key, counts);
			}
		}
		for (const counts of stepOutcomeCounts.values()) {
			if (counts.completed > 1) {
				throw new Error(`duplicate run.StepCompleted for ${runId}`);
			}
			if (counts.failed > 1) {
				throw new Error(`duplicate run.StepFailed for ${runId}`);
			}
			if (counts.completed > 0 && counts.failed > 0) {
				throw new Error(`conflicting step outcomes for ${runId}`);
			}
		}
		const journaledOutcomeIndices = listStepOutcomeIndices(journal);
		const unconsumedOutcomes = new Set(journaledOutcomeIndices);
		if (journaledOutcomeIndices.length > 0) {
			const outcomeIndexSet = new Set(journaledOutcomeIndices);
			const maxOutcomeIndex = maxStepOutcomeIndex(journaledOutcomeIndices);
			if (
				!Number.isSafeInteger(maxOutcomeIndex) ||
				maxOutcomeIndex > 1_000_000
			) {
				throw new Error(`invalid step journal for ${runId}`);
			}
			for (let index = 0; index < maxOutcomeIndex; index += 1) {
				if (!outcomeIndexSet.has(index) && !scheduledSteps.has(index)) {
					throw new Error(`gapped step journal for ${runId}`);
				}
			}
		}
		const terminals = journal.filter(
			(event) => event.type === "run.Completed" || event.type === "run.Failed",
		);
		if (terminals.length > 1) {
			throw new Error(`duplicate terminal facts for ${runId}`);
		}
		const terminal = terminals[0];
		if (terminal) {
			const terminalIndex = journal.indexOf(terminal);
			if (terminalIndex >= 0) {
				for (const event of journal.slice(terminalIndex + 1)) {
					if (event.type.startsWith("run.")) {
						throw new Error(`events after terminal for ${runId}`);
					}
				}
			}
			const data = cloneAsJson(terminal.data);
			if (!isRecord(data)) {
				throw new Error(`invalid ${terminal.type} for ${runId}`);
			}
			if (terminal.type === "run.Completed") {
				const stored = parseRunCompletedFact(cloneAsJson(data));
				const journaled = readJournaledWorkflowResult(stored);
				const result = terminalCompletedHandleResult<R>(journaled);
				return { runId, status: "completed", result, error: undefined };
			}
			const failedFact = parseRunFailedFact(cloneAsJson(data));
			const failure: NonNullable<WorkflowRunHandle<R>["error"]> = {
				code: "workflow.failed",
				message: failedFact.message,
			};
			if (failedFact.step !== undefined) failure.step = failedFact.step;
			return {
				runId,
				status: "failed",
				result: undefined,
				error: failure,
			};
		}
		const runSeed = startedFact.seed;

		async function appendEvent<T>(type: string, data: T): Promise<number> {
			const payload = cloneAsJson(data);
			seq += 1;
			const envelope = nextEnvelope(streamId, seq, type, payload, {
				meta: { idempotencyKey: `${runId}:${type}:${seq}` },
			});
			await recordEffect(store, envelope, seq - 1);
			journal.push(envelope);
			return seq;
		}

		let stepIndex = 0;
		let sleepIndex = 0;
		let replayError: Error | undefined;
		function assertReplayConsistent(): void {
			if (replayError) throw replayError;
		}
		function rejectReplay(message: string): never {
			replayError = new Error(message);
			throw replayError;
		}
		function rejectStepName(): never {
			return rejectReplay(`step name differs from journal for ${runId}`);
		}
		function assertConsumedOutcomes(): void {
			assertReplayConsistent();
			if (unconsumedOutcomes.size > 0) {
				throw new Error(`unconsumed step outcome for ${runId}`);
			}
		}
		const deterministic = createDeterministicContext({
			seed: runSeed,
			mode: "live",
			eventKey: `${streamId}:orchestration`,
		});

		const stepRecordedAtIndex = (index: number) => {
			let completed: ParsedRunStepCompleted | undefined;
			let failed: ParsedRunStepFailed | undefined;
			for (const event of journal) {
				if (event.type === "run.StepCompleted" && isRecord(event.data)) {
					const fact = parseRunStepCompletedFact(cloneAsJson(event.data));
					if (fact.index === index) completed = fact;
				} else if (event.type === "run.StepFailed" && isRecord(event.data)) {
					const fact = parseRunStepFailedFact(cloneAsJson(event.data));
					if (fact.index === index) failed = fact;
				}
			}
			return { completed, failed };
		};

		const stepOutcomesFor = (name: string, index: number) => {
			const completed: typeof journal = [];
			const failed: typeof journal = [];
			for (const event of journal) {
				if (event.type === "run.StepCompleted" && isRecord(event.data)) {
					const fact = parseRunStepCompletedFact(cloneAsJson(event.data));
					if (fact.name === name && fact.index === index) completed.push(event);
				} else if (event.type === "run.StepFailed" && isRecord(event.data)) {
					const fact = parseRunStepFailedFact(cloneAsJson(event.data));
					if (fact.name === name && fact.index === index) failed.push(event);
				}
			}
			return { completed, failed };
		};

		const effects: CtxEffects = {
			async step<T>(
				name: string,
				fn: () => Promise<T> | T,
				opts?: StepOptions,
			): Promise<T> {
				assertReplayConsistent();
				const index = stepIndex;
				stepIndex += 1;
				const scheduled = scheduledSteps.get(index);
				if (scheduled !== undefined && scheduled !== name) {
					rejectStepName();
				}
				const recorded = stepRecordedAtIndex(index);
				if (recorded.completed && recorded.completed.name !== name) {
					rejectStepName();
				}
				if (recorded.failed && recorded.failed.name !== name) {
					rejectStepName();
				}
				const { completed, failed } = stepOutcomesFor(name, index);
				const completedEvent = completed[0];
				if (completedEvent && isRecord(completedEvent.data)) {
					const result = replayStepCompletedResult<T>(
						cloneAsJson(completedEvent.data),
					);
					unconsumedOutcomes.delete(index);
					return result;
				}
				const failedEvent = failed[0];
				if (failedEvent && isRecord(failedEvent.data)) {
					const stepFailed = parseRunStepFailedFact(
						cloneAsJson(failedEvent.data),
					);
					unconsumedOutcomes.delete(index);
					throw new WorkflowFailure(stepFailed.message, {
						step: stepFailed.name,
					});
				}
				await appendEvent("run.StepScheduled", { name, index });
				assertReplayConsistent();
				try {
					const value = await runWithRetries(name, fn, opts ?? {});
					const result = captureWorkflowResult(value, name);
					await appendEvent("run.StepCompleted", { name, index, result });
					return result;
				} catch (error) {
					if (error instanceof WorkflowFailure) {
						await appendEvent("run.StepFailed", {
							name,
							index,
							message: error.message,
						});
					}
					throw error;
				}
			},
			async sleep(durationMs, sleepOptions) {
				assertReplayConsistent();
				const index = sleepIndex;
				sleepIndex += 1;
				const scheduled = journal.find(
					(event) =>
						event.type === "run.SleepScheduled" &&
						isRecord(event.data) &&
						event.data.index === index,
				);
				if (scheduled && isRecord(scheduled.data)) {
					if (scheduled.data.delayMs !== durationMs) {
						rejectReplay(`sleep schedule diverged on replay for ${runId}`);
					}
					return;
				}
				const data: JsonBag = { delayMs: durationMs, index };
				if (sleepOptions?.label !== undefined) {
					data.label = sleepOptions.label;
				}
				await appendEvent("run.SleepScheduled", data);
			},
			async emit(type, data) {
				assertReplayConsistent();
				return appendEvent(type, data ?? null);
			},
			now: () => deterministic.now(),
			random: (label) => deterministic.random(label),
			token(request) {
				assertReplayConsistent();
				return tokenBroker(request);
			},
			...(actorHost
				? {
						actor(ref: { typeName: string; key: string }) {
							const host = actorHost;
							const actorKey = `${ref.typeName}/${ref.key}`;
							return {
								key: ref.key,
								async signal(message: {
									type: string;
									[key: string]: JsonValue;
								}) {
									assertReplayConsistent();
									const lease = host.acquire(actorKey, {
										holderId: `${runId}:signal`,
									});
									const state = host.state(actorKey, {
										initialState: {},
										fold: (current) => current,
									});
									const appended = state.append(lease, message);
									lease.release();
									return appended.seq;
								},
								async state<S = JsonValue>() {
									assertReplayConsistent();
									return host
										.state<S>(actorKey, {
											// SAFETY: assertion to `, ` is required at this boundary.
											initialState: {} as S,
											fold: (current) => current,
										})
										.read().state;
								},
							};
						},
					}
				: undefined),
			async tool(name, input) {
				return effects.step(`tool:${name}`, () => {
					const impl = def.tools[name];
					if (!impl) {
						throw new WorkflowFailure(`tool ${name} is not registered`, {
							step: `tool:${name}`,
						});
					}
					return impl(cloneAsJson(input));
				});
			},
		};

		const base = createRuntimeContext({
			capabilities: def.capabilities,
			effects,
		});
		const ctx: WorkflowContext = Object.freeze({
			...base,
			runId,
			seed: runSeed,
		});

		try {
			const value = await def.run(ctx, runArgs);
			assertConsumedOutcomes();
			const result = captureWorkflowResult(value);
			await appendEvent("run.Completed", { result });
			return { runId, status: "completed", result, error: undefined };
		} catch (error) {
			if (error instanceof WorkflowFailure) {
				assertConsumedOutcomes();
				const failureData: JsonBag = {
					message: error.message,
				};
				const failure: NonNullable<WorkflowRunHandle<R>["error"]> = {
					code: error.code,
					message: error.message,
				};
				if (error.step !== undefined) {
					failureData.step = error.step;
					failure.step = error.step;
				}
				await appendEvent("run.Failed", failureData);
				return {
					runId,
					status: "failed",
					result: undefined,
					error: failure,
				};
			}
			// Any other throw models an infrastructure crash: the journal keeps the
			// steps completed so far, and a later `resume` picks up from the tip.
			throw error;
		}
	}

	return {
		store,
		async start(def, args, startOptions) {
			const requestedRunId = startOptions?.runId;
			const runId = requireWorkflowRunId(
				requestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId,
			);
			const input = captureWorkflowInput(args);
			const streamId = `run/${runId}`;
			const started = nextEnvelope(
				streamId,
				1,
				"run.Started",
				cloneAsJson({ seed, args: input, workflowName: def.name }),
			);
			await recordEffect(store, started, 0);
			return execute(def, runId, input);
		},
		async resume(def, runId, args) {
			const id = requireWorkflowRunId(runId);
			const input = captureWorkflowInput(args);
			return execute(def, id, input);
		},
		async journal(runId) {
			const id = requireWorkflowRunId(runId);
			const events = await store.readStream(`run/${id}`);
			return events.map((event) => ({
				type: event.type,
				data: cloneAsJson(event.data),
			}));
		},
		toReplayDefinition(def) {
			return {
				name: def.name,
				initialState: () => null,
				execute: async (rctx, _state, args) => {
					const replayCtx = createRuntimeContext({
						capabilities: def.capabilities,
						effects: {
							step: <T>(name: string, fn: () => Promise<T> | T) =>
								rctx.step<T>(name, fn),
							sleep: async (durationMs: number) => {
								await rctx.sleep(durationMs);
							},
							emit: async () => 0,
							now: () => rctx.now(),
							random: (label) => rctx.random(label),
							token: tokenBroker,
							async tool(name, input) {
								return rctx.step(`tool:${name}`, () => {
									const impl = def.tools[name];
									if (!impl) {
										throw new Error(`tool ${name} is not registered`);
									}
									return impl(cloneAsJson(input));
								});
							},
						},
					});
					const ctx: WorkflowContext = Object.freeze({
						...replayCtx,
						runId: rctx.runId,
						seed: rctx.seed,
					});
					return def.run(ctx, args);
				},
			};
		},
	};
}

function isRecord<T>(value: T): value is T & JsonBag {
	return isJsonObject(value);
}
