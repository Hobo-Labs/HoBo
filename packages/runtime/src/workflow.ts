// `workflow` / `step` — durable, replayable orchestration (sdk-api.md §Layer 4,
// lowering onto `hobo:runtime/workflow`). Each `ctx.step` result is journaled as
// `run.StepCompleted`, so after a host restart the engine replays the journal:
// completed steps are read back (never re-run) and execution resumes from the
// tip. The journal it writes is the same `run.*` shape the existing replay
// engine (`./replay`) verifies, so a completed run is replay-equivalent.

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
	/** Fresh run: journals `run.Started`, then executes to completion/failure. */
	start<A, R>(
		def: WorkflowDefinition<A, R>,
		args: A,
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

	let runCounter = 0;

	async function execute<A, R>(
		def: WorkflowDefinition<A, R>,
		runId: string,
		args: A,
	): Promise<WorkflowRunHandle<R>> {
		const streamId = `run/${runId}`;
		const journal = await store.readStream(streamId);
		let seq = journal.at(-1)?.seq ?? 0;

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

		if (!journal.some((event) => event.type === "run.Started")) {
			await appendEvent("run.Started", { seed, args });
		}

		let stepIndex = 0;
		let sleepIndex = 0;
		const deterministic = createDeterministicContext({
			seed,
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
				const index = stepIndex;
				stepIndex += 1;
				const completed = findCompletedStep(name, index);
				if (completed && isRecord(completed.data)) {
					// Journaled on a prior attempt — short-circuit, do NOT re-run.
					// SAFETY: assertion to `ed.data.result as T; }` is required at this boundary.
					return completed.data.result as T;
				}
				await appendEvent("run.StepScheduled", { name, index });
				try {
					const result = await runWithRetries(name, fn, opts ?? {});
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
						throw new WorkflowFailure("sleep schedule diverged on replay", {
							step: `sleep:${index}`,
						});
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
		const ctx: WorkflowContext = Object.freeze({ ...base, runId, seed });

		try {
			const result = await def.run(ctx, args);
			await appendEvent("run.Completed", { result });
			return { runId, status: "completed", result, error: undefined };
		} catch (error) {
			if (error instanceof WorkflowFailure) {
				await appendEvent("run.Failed", { message: error.message });
				return {
					runId,
					status: "failed",
					result: undefined,
					error: {
						code: error.code,
						message: error.message,
						...(error.step !== undefined ? { step: error.step } : undefined),
					},
				};
			}
			// Any other throw models an infrastructure crash: the journal keeps the
			// steps completed so far, and a later `resume` picks up from the tip.
			throw error;
		}
	}

	return {
		store,
		async start(def, args) {
			runCounter += 1;
			const runId = `run-${runCounter}`;
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
