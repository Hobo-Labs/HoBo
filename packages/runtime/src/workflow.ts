// `workflow` / `step` — durable, replayable orchestration (sdk-api.md §Layer 4,
// lowering onto `hobo:runtime/workflow`). Each `ctx.step` result is journaled as
// `run.StepCompleted`, so after a host restart the engine replays the journal:
// completed steps are read back (never re-run) and execution resumes from the
// tip. The journal it writes is the same `run.*` shape the existing replay
// engine (`./replay`) verifies, so a completed run is replay-equivalent.

import { AsyncLocalStorage } from "node:async_hooks";
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
	isJsonNumber,
	isJsonObject,
	isJsonString,
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
	/** Wait for a duration before rechecking the clock; defaults to a Node timer. */
	wait?: (delayMs: number) => Promise<void>;
	actorHost?: ActorHost;
	tokenBroker?: TokenBroker;
}

export interface WorkflowEngine {
	readonly store: EventStoreWriter;
	/** Fresh run: atomically claims a new journal before running user steps.
	 * Supply runId when the host must know the ID before a possible crash. */
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

export function createWorkflowEngine(
	options: WorkflowEngineOptions = {},
): WorkflowEngine {
	const store = options.store ?? createInMemoryEventStore();
	const seed = options.seed ?? "hobo-runtime-authoring-seed";
	const tokenBroker = options.tokenBroker ?? DEFAULT_TOKEN_BROKER;
	const actorHost = options.actorHost;
	const wait =
		options.wait ??
		((delayMs: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

	function nowMs(): number {
		const value = options.clock?.nowMs() ?? Date.now();
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(
				"workflow sleep clock must return a nonnegative safe integer",
			);
		}
		return value;
	}

	function makeDeadline(delayMs: number) {
		const scheduledAtMs = nowMs();
		const deadlineMs = scheduledAtMs + delayMs;
		if (!Number.isSafeInteger(deadlineMs)) {
			throw new Error("workflow sleep deadline exceeds the safe integer range");
		}
		return { scheduledAtMs, deadlineMs };
	}

	function readDeadline(data: JsonBag, delayMs: number): number {
		const { scheduledAtMs, deadlineMs } = data;
		if (
			!isJsonNumber(scheduledAtMs) ||
			!Number.isSafeInteger(scheduledAtMs) ||
			scheduledAtMs < 0 ||
			!isJsonNumber(deadlineMs) ||
			!Number.isSafeInteger(deadlineMs) ||
			deadlineMs !== scheduledAtMs + delayMs
		) {
			throw new Error("invalid recorded workflow sleep deadline");
		}
		return deadlineMs;
	}

	async function execute<A, R>(
		def: WorkflowDefinition<A, R>,
		runId: string,
		args: A,
	): Promise<WorkflowRunHandle<R>> {
		const streamId = `run/${runId}`;
		const journal = await store.readStream(streamId);
		let seq = journal.at(-1)?.seq ?? 0;
		if (!Number.isSafeInteger(seq) || seq < 0) {
			throw new Error("invalid workflow journal sequence");
		}
		const started = journal.find((event) => event.type === "run.Started");
		if (!started || !isRecord(started.data)) {
			throw new Error(`missing run.Started for ${runId}`);
		}
		if (!isDeepStrictEqual(started.data.args ?? null, cloneAsJson(args))) {
			throw new Error(`workflow input differs from run.Started for ${runId}`);
		}
		if (
			isJsonString(started.data.workflowName) &&
			started.data.workflowName !== def.name
		) {
			throw new Error(`workflow name differs from run.Started for ${runId}`);
		}
		const terminal = [...journal]
			.reverse()
			.find(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			);
		if (terminal) {
			const data = cloneAsJson(terminal.data);
			if (!isRecord(data)) {
				throw new Error(`invalid ${terminal.type} for ${runId}`);
			}
			if (terminal.type === "run.Completed") {
				// SAFETY: the journal stores the JSON-normalized workflow result.
				const result = data.result as R | undefined;
				return { runId, status: "completed", result, error: undefined };
			}
			if (!isJsonString(data.message)) {
				throw new Error(`invalid run.Failed for ${runId}`);
			}
			const failure: NonNullable<WorkflowRunHandle<R>["error"]> = {
				code: "workflow.failed",
				message: data.message,
			};
			if (isJsonString(data.step)) failure.step = data.step;
			return {
				runId,
				status: "failed",
				result: undefined,
				error: failure,
			};
		}
		const runSeed = isJsonString(started.data.seed) ? started.data.seed : seed;
		type RecordedCommand =
			| { kind: "step"; index: number; name: string }
			| { kind: "sleep"; index: number; delayMs: number };
		const commands: RecordedCommand[] = [];
		const stepNames = new Map<number, string>();
		let recordedSleeps = 0;
		for (const event of journal) {
			if (event.type === "run.StepScheduled") {
				if (
					!isRecord(event.data) ||
					!isJsonNumber(event.data.index) ||
					!Number.isSafeInteger(event.data.index) ||
					event.data.index < 0 ||
					!isJsonString(event.data.name)
				)
					throw new Error("invalid recorded workflow command");
				const { index, name } = event.data;
				const previous = stepNames.get(index);
				if (previous !== undefined) {
					if (previous !== name)
						throw new Error("recorded workflow command diverged");
					continue;
				}
				if (index !== stepNames.size)
					throw new Error("invalid recorded workflow command order");
				stepNames.set(index, name);
				commands.push({ kind: "step", index, name });
			} else if (event.type === "run.SleepScheduled") {
				if (
					!isRecord(event.data) ||
					!isJsonNumber(event.data.delayMs) ||
					!Number.isSafeInteger(event.data.delayMs) ||
					event.data.delayMs < 0 ||
					(event.data.index !== undefined &&
						event.data.index !== recordedSleeps)
				) {
					throw new Error("invalid recorded workflow command");
				}
				commands.push({
					kind: "sleep",
					index: recordedSleeps,
					delayMs: event.data.delayMs,
				});
				recordedSleeps += 1;
			}
		}
		let commandIndex = 0;
		function consumeCommand(command: RecordedCommand): void {
			const expected = commands[commandIndex];
			if (expected && !isDeepStrictEqual(expected, command)) {
				throw new Error(
					`workflow command history diverged at index ${commandIndex}`,
				);
			}
			commandIndex += 1;
		}
		function assertConsumedCommands(): void {
			if (commandIndex < commands.length) {
				throw new Error(`unconsumed workflow command at index ${commandIndex}`);
			}
		}

		let appendTail: Promise<void> = Promise.resolve();
		let appendFailed = false;
		let appendFailure: unknown;
		function appendEvent<T>(type: string, data: T): Promise<number> {
			let snapshot:
				| { ok: true; value: JsonValue }
				| { ok: false; error: unknown };
			try {
				snapshot = { ok: true, value: cloneAsJson(data) };
			} catch (error) {
				snapshot = { ok: false, error };
			}
			const pending = appendTail.then(async () => {
				if (appendFailed) throw appendFailure;
				try {
					if (seq >= Number.MAX_SAFE_INTEGER) {
						throw new Error("workflow journal sequence exhausted");
					}
					if (!snapshot.ok) throw snapshot.error;
					const payload = snapshot.value;
					const nextSeq = seq + 1;
					const envelope = nextEnvelope(streamId, nextSeq, type, payload, {
						meta: { idempotencyKey: `${runId}:${type}:${nextSeq}` },
					});
					await recordEffect(store, envelope, seq);
					seq = nextSeq;
					journal.push(envelope);
					return seq;
				} catch (error) {
					appendFailed = true;
					appendFailure = error;
					throw error;
				}
			});
			appendTail = pending.then(
				() => undefined,
				() => undefined,
			);
			return pending;
		}

		let stepIndex = 0;
		let sleepIndex = 0;
		const stepScope = new AsyncLocalStorage<number>();
		const deterministic = createDeterministicContext({
			seed: runSeed,
			mode: "live",
			eventKey: `${streamId}:orchestration`,
		});

		const findCompletedStep = (name: string, index: number) =>
			journal.find(
				(event) =>
					event.type === "run.StepCompleted" &&
					isRecord(event.data) &&
					event.data.name === name &&
					event.data.index === index,
			);

		const effects: CtxEffects = {
			async step<T>(
				name: string,
				fn: () => Promise<T> | T,
				opts?: StepOptions,
			): Promise<T> {
				const parentStepIndex = stepScope.getStore() ?? null;
				const index = stepIndex;
				stepIndex += 1;
				consumeCommand({ kind: "step", index, name });
				const completed = findCompletedStep(name, index);
				if (completed && isRecord(completed.data)) {
					// Journaled on a prior attempt — short-circuit, do NOT re-run.
					// SAFETY: assertion to `ed.data.result as T; }` is required at this boundary.
					return completed.data.result as T;
				}
				await appendEvent("run.StepScheduled", {
					name,
					index,
					parentStepIndex,
				});
				try {
					const result = await runWithRetries(
						name,
						() => stepScope.run(index, fn),
						opts ?? {},
					);
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
				if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
					throw new TypeError(
						"workflow sleep delay must be a nonnegative safe integer",
					);
				}
				const parentStepIndex = stepScope.getStore() ?? null;
				const index = sleepIndex;
				sleepIndex += 1;
				consumeCommand({ kind: "sleep", index, delayMs: durationMs });
				const sleeps = journal.filter(
					(event) => event.type === "run.SleepScheduled",
				);
				const deadlines = journal.filter(
					(event) => event.type === "run.SleepDeadlineSet",
				);
				const completions = journal.filter(
					(event) => event.type === "run.SleepCompleted",
				);
				for (const event of deadlines) {
					if (
						!isRecord(event.data) ||
						!isJsonNumber(event.data.index) ||
						!Number.isSafeInteger(event.data.index) ||
						event.data.index < 0 ||
						event.data.index >= sleeps.length
					)
						throw new Error("invalid workflow sleep deadline record");
				}
				for (const event of completions) {
					if (
						!isRecord(event.data) ||
						!isJsonNumber(event.data.index) ||
						!Number.isSafeInteger(event.data.index) ||
						event.data.index < 0 ||
						event.data.index >= sleeps.length
					)
						throw new Error("invalid workflow sleep completion record");
				}
				const scheduled = sleeps[index];
				const rebased = deadlines.filter(
					(event) => isRecord(event.data) && event.data.index === index,
				);
				if (rebased.length > 1)
					throw new Error("duplicate workflow sleep deadline");
				const completed = completions.filter(
					(event) => isRecord(event.data) && event.data.index === index,
				);
				if (completed.length > 1)
					throw new Error("duplicate workflow sleep completion");
				let deadlineMs: number;
				if (scheduled) {
					if (
						!isRecord(scheduled.data) ||
						scheduled.data.delayMs !== durationMs ||
						(scheduled.data.index !== undefined &&
							scheduled.data.index !== index)
					) {
						throw new WorkflowFailure("sleep schedule diverged on replay", {
							step: `sleep:${index}`,
						});
					}
					if (
						scheduled.data.deadlineMs !== undefined ||
						scheduled.data.scheduledAtMs !== undefined
					) {
						if (rebased.length)
							throw new Error("duplicate workflow sleep deadline");
						deadlineMs = readDeadline(scheduled.data, durationMs);
					} else {
						const previous = rebased[0];
						if (previous && isRecord(previous.data)) {
							deadlineMs = readDeadline(previous.data, durationMs);
						} else {
							const deadline = makeDeadline(durationMs);
							await appendEvent("run.SleepDeadlineSet", { index, ...deadline });
							deadlineMs = deadline.deadlineMs;
						}
					}
				} else {
					const deadline = makeDeadline(durationMs);
					const data: JsonBag = {
						delayMs: durationMs,
						index,
						parentStepIndex,
						...deadline,
					};
					if (sleepOptions?.label !== undefined)
						data.label = sleepOptions.label;
					await appendEvent("run.SleepScheduled", data);
					deadlineMs = deadline.deadlineMs;
				}
				const completion = completed[0];
				if (completion) {
					if (
						!isRecord(completion.data) ||
						!isJsonNumber(completion.data.completedAtMs) ||
						!Number.isSafeInteger(completion.data.completedAtMs) ||
						completion.data.completedAtMs < deadlineMs
					) {
						throw new Error("invalid workflow sleep completion time");
					}
					return;
				}
				let completedAtMs: number;
				for (;;) {
					const current = nowMs();
					const remaining = deadlineMs - current;
					if (remaining <= 0) {
						completedAtMs = current;
						break;
					}
					await wait(Math.min(remaining, 2_147_483_647));
				}
				await appendEvent("run.SleepCompleted", { index, completedAtMs });
			},
			async emit(type, data) {
				return appendEvent(type, data ?? null);
			},
			now: () => deterministic.now(),
			random: (label) => deterministic.random(label),
			token: tokenBroker,
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
			const result = await def.run(ctx, args);
			assertConsumedCommands();
			await appendEvent("run.Completed", { result });
			return { runId, status: "completed", result, error: undefined };
		} catch (error) {
			if (error instanceof WorkflowFailure) {
				assertConsumedCommands();
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
			const runId = startOptions?.runId ?? `run-${randomUUID()}`;
			if (
				!isJsonString(runId) ||
				String(runId) !== runId ||
				runId.length === 0
			) {
				throw new TypeError("workflow runId must be a non-empty string");
			}
			const streamId = `run/${runId}`;
			// Claim the new run before any user step. No shared idempotency key is
			// used here: two fresh callers must not deduplicate into one run.
			const started = nextEnvelope(
				streamId,
				1,
				"run.Started",
				cloneAsJson({
					seed,
					args,
					workflowName: def.name,
					commandTreeVersion: 2,
				}),
			);
			await recordEffect(store, started, 0);
			return execute(def, runId, args);
		},
		async resume(def, runId, args) {
			return execute(def, runId, args);
		},
		async journal(runId) {
			const events = await store.readStream(`run/${runId}`);
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
