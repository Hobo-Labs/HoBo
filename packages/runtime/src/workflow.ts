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
import { WorkflowExecutionAborted, WorkflowFailure } from "./errors.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonValue,
} from "./json.js";
import type { ActorHost, RuntimeClock } from "./ports.js";
import {
	type ReplayCommand,
	type ReplayEmitCommand,
	type ReplaySleepCommand,
	type ReplayStepCommand,
	readReplayCommandTree,
} from "./replay/command-tree.js";
import { createDeterministicContext } from "./replay/context.js";
import {
	validateCurrentJournalTypes,
	validateJournalHistory,
} from "./replay/journal-history.js";
import { captureJournalStream } from "./replay/journal-stream.js";
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
	isNonEmptyPrimitiveString,
	requireWorkflowRunId,
} from "./workflow-boundary.js";

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
	const name = input.name;
	if (!isNonEmptyPrimitiveString(name)) {
		throw new TypeError("workflow name must be a non-empty string");
	}
	return Object.freeze({
		name,
		// SAFETY: assertion to ` Set([ ...DURABILITY_CAPABILITIES, ...(input.capabilities ?? []), ]) as ReadonlySet<Capability>, ` is required at this boundary.
		capabilities: new Set([
			...DURABILITY_CAPABILITIES,
			...(input.capabilities ?? []),
		]) as ReadonlySet<Capability>,
		tools: Object.freeze({ ...input.tools }),
		run: input.run,
	});
}

function captureWorkflowDefinition<A, R>(
	definition: WorkflowDefinition<A, R>,
): WorkflowDefinition<A, R> {
	const name = definition.name;
	if (!isNonEmptyPrimitiveString(name))
		throw new TypeError("workflow name must be a non-empty string");
	const run = definition.run;
	try {
		Function.prototype.toString.call(run);
	} catch {
		throw new TypeError("workflow run must be callable");
	}
	const capabilities = new Set(definition.capabilities);
	const tools = Object.freeze({ ...definition.tools });
	return Object.freeze({
		name,
		capabilities,
		tools,
		run: (ctx: WorkflowContext, args: A) =>
			Function.prototype.call.call(run, definition, ctx, args),
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
	 * Input must round-trip as JSON. Supply runId for crash recovery. */
	start<A, R>(
		def: WorkflowDefinition<A, R>,
		args: A,
		options?: { runId?: string },
	): Promise<WorkflowRunHandle<R>>;
	/** Resume after a host restart with the same JSON-normalized input. */
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

type WorkflowExecutionLease = {
	pending: number;
	finished: boolean;
	releaseIfDrained(): void;
};

// Local coordination is keyed by the writer object, not by an underlying
// database identity. Separate wrappers, workers and processes need host fencing.
const ACTIVE_WORKFLOW_RUNS = new WeakMap<
	EventStoreWriter,
	Map<string, WorkflowExecutionLease>
>();

function claimWorkflowExecution(
	store: EventStoreWriter,
	runId: string,
): WorkflowExecutionLease {
	let active = ACTIVE_WORKFLOW_RUNS.get(store);
	if (!active) {
		active = new Map();
		ACTIVE_WORKFLOW_RUNS.set(store, active);
	}
	if (active.has(runId))
		throw new Error(`workflow ${runId} is already executing for this store`);
	const runs = active;
	const lease: WorkflowExecutionLease = {
		pending: 0,
		finished: false,
		releaseIfDrained() {
			if (!lease.finished || lease.pending !== 0) return;
			if (runs.get(runId) !== lease) return;
			runs.delete(runId);
			if (runs.size === 0 && ACTIVE_WORKFLOW_RUNS.get(store) === runs)
				ACTIVE_WORKFLOW_RUNS.delete(store);
		},
	};
	runs.set(runId, lease);
	return lease;
}

export function createWorkflowEngine(
	options: WorkflowEngineOptions = {},
): WorkflowEngine {
	const store = options.store ?? createInMemoryEventStore();
	const seed =
		options.seed === undefined ? "hobo-runtime-authoring-seed" : options.seed;
	if (!isNonEmptyPrimitiveString(seed))
		throw new TypeError("workflow seed must be a non-empty string");
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
		lease: WorkflowExecutionLease,
	): Promise<WorkflowRunHandle<R>> {
		const streamId = `run/${runId}`;
		const journal = captureJournalStream(
			await store.readStream(streamId),
			streamId,
		);
		validateJournalHistory(journal);
		let seq = journal.at(-1)?.seq ?? 0;
		if (!Number.isSafeInteger(seq) || seq < 0) {
			throw new Error("invalid workflow journal sequence");
		}
		const started = journal.find((event) => event.type === "run.Started");
		if (!started || !isRecord(started.data)) {
			throw new Error(`missing run.Started for ${runId}`);
		}
		const version = started.data.commandTreeVersion;
		if (
			version !== undefined &&
			version !== 1 &&
			version !== 2 &&
			version !== 3
		) {
			throw new Error("unsupported workflow command tree version");
		}
		if (version === 3) validateCurrentJournalTypes(journal);
		const hasArgs = Object.hasOwn(started.data, "args");
		const recordedArgs = hasArgs ? started.data.args : null;
		if (
			(version === 3 && !hasArgs) ||
			!isDeepStrictEqual(recordedArgs, cloneAsJson(args))
		) {
			throw new Error(`workflow input differs from run.Started for ${runId}`);
		}
		const recordedName = started.data.workflowName;
		if (
			(version === 3 && recordedName === undefined) ||
			(recordedName !== undefined &&
				(!isNonEmptyPrimitiveString(recordedName) || recordedName !== def.name))
		) {
			throw new Error(`workflow name differs from run.Started for ${runId}`);
		}
		const recordedSeed = started.data.seed;
		if (
			(version === 3 && recordedSeed === undefined) ||
			(recordedSeed !== undefined && !isNonEmptyPrimitiveString(recordedSeed))
		) {
			throw new Error(`workflow seed differs from run.Started for ${runId}`);
		}
		const terminal = [...journal]
			.reverse()
			.find(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			);
		if (terminal) {
			if (version === 1 || version === 2 || version === 3) {
				readReplayCommandTree(journal, version >= 2, version === 3);
			}
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
		const runSeed = recordedSeed === undefined ? seed : recordedSeed;
		const rootCommands =
			version === 2 || version === 3
				? readReplayCommandTree(journal, true, version === 3)
				: undefined;
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
				abortHistory(
					`workflow command history diverged at index ${commandIndex}`,
				);
			}
			commandIndex += 1;
		}
		function assertConsumedCommands(): void {
			if (rootCommands) {
				assertScopeConsumed(rootScope);
				return;
			}
			if (commandIndex < commands.length) {
				abortHistory(`unconsumed workflow command at index ${commandIndex}`);
			}
		}

		let appendTail: Promise<void> = Promise.resolve();
		let appendFailed = false;
		// Stores may reject with any thrown value; preserve it for the caller.
		type JournalAppendFailure = unknown;
		let appendFailure: JournalAppendFailure;
		function poison(error: JournalAppendFailure): never {
			if (!appendFailed) {
				appendFailed = true;
				appendFailure = error;
			}
			throw appendFailure;
		}
		function abortHistory(message: string): never {
			return poison(new WorkflowExecutionAborted(message));
		}
		function appendEvent<T>(
			type: string,
			data: T,
			extraMeta?: JsonBag,
		): Promise<number> {
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
						meta: {
							idempotencyKey: `${runId}:${type}:${nextSeq}`,
							...extraMeta,
						},
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

		let stepIndex = rootCommands ? stepNames.size : 0;
		let sleepIndex = rootCommands ? recordedSleeps : 0;
		function countEmits(records: ReplayCommand[]): number {
			return records.reduce(
				(total, record) =>
					total +
					(record.kind === "emit"
						? 1
						: record.kind === "step"
							? countEmits(record.children)
							: 0),
				0,
			);
		}
		let emitIndex = rootCommands ? countEmits(rootCommands) : 0;
		type CommandScope = {
			index: number | null;
			parent: CommandScope | null;
			active: boolean;
			pending: number;
			commands: ReplayCommand[] | undefined;
			cursor: number;
		};
		const rootScope: CommandScope = {
			index: null,
			parent: null,
			active: true,
			pending: 0,
			commands: rootCommands,
			cursor: 0,
		};
		const stepScope = new AsyncLocalStorage<CommandScope>();
		function assertScopeConsumed(scope: CommandScope): void {
			if (scope.commands && scope.cursor < scope.commands.length) {
				abortHistory(`unconsumed workflow command at index ${scope.cursor}`);
			}
		}
		function nextTreeStep(
			scope: CommandScope,
			name: string,
		): ReplayStepCommand | undefined {
			if (!scope.commands) return undefined;
			const previous = scope.commands[scope.cursor];
			if (previous) {
				if (previous.kind !== "step" || previous.name !== name) {
					abortHistory(
						`workflow command history diverged at index ${scope.cursor}`,
					);
				}
				scope.cursor += 1;
				return previous;
			}
			const next: ReplayStepCommand = {
				kind: "step",
				index: stepIndex++,
				name,
				parent: scope.index,
				active: true,
				terminal: undefined,
				children: [],
			};
			scope.commands.push(next);
			scope.cursor += 1;
			return next;
		}
		function nextTreeSleep(
			scope: CommandScope,
			delayMs: number,
		): ReplaySleepCommand | undefined {
			if (!scope.commands) return undefined;
			const previous = scope.commands[scope.cursor];
			if (previous) {
				if (previous.kind !== "sleep" || previous.delayMs !== delayMs) {
					abortHistory(
						`workflow command history diverged at index ${scope.cursor}`,
					);
				}
				scope.cursor += 1;
				return previous;
			}
			const next: ReplaySleepCommand = {
				kind: "sleep",
				index: sleepIndex++,
				delayMs,
				parent: scope.index,
				deadlineMs: undefined,
				completed: false,
			};
			scope.commands.push(next);
			scope.cursor += 1;
			return next;
		}
		function nextTreeEmit(
			scope: CommandScope,
			type: string,
			data: JsonValue,
		): ReplayEmitCommand {
			if (!scope.commands)
				return abortHistory("workflow event command scope is missing");
			const previous = scope.commands[scope.cursor];
			if (previous) {
				if (
					previous.kind !== "emit" ||
					previous.type !== type ||
					!isDeepStrictEqual(previous.data, data)
				) {
					abortHistory(
						`workflow command history diverged at index ${scope.cursor}`,
					);
				}
				scope.cursor += 1;
				return previous;
			}
			const next: ReplayEmitCommand = {
				kind: "emit",
				index: emitIndex++,
				parent: scope.index,
				type,
				data,
				seq: undefined,
			};
			scope.commands.push(next);
			scope.cursor += 1;
			return next;
		}
		function requireOpen(scope: CommandScope): void {
			for (
				let current: CommandScope | null = scope;
				current;
				current = current.parent
			) {
				if (!current.active)
					throw new WorkflowExecutionAborted(
						"workflow command parent is closed",
					);
			}
			if (appendFailed) throw appendFailure;
		}
		async function command<T>(
			fn: (scope: CommandScope) => Promise<T>,
		): Promise<T> {
			const scope = stepScope.getStore() ?? rootScope;
			requireOpen(scope);
			scope.pending += 1;
			lease.pending += 1;
			try {
				return await fn(scope);
			} finally {
				scope.pending -= 1;
				lease.pending -= 1;
				lease.releaseIfDrained();
			}
		}
		async function runInScope<T>(
			scope: CommandScope,
			fn: () => Promise<T> | T,
		): Promise<T> {
			let outcome: { ok: true; value: T } | { ok: false; error: unknown };
			try {
				outcome = { ok: true, value: await stepScope.run(scope, fn) };
			} catch (error) {
				outcome = { ok: false, error };
			}
			scope.active = false;
			if (scope.pending > 0) {
				if (!appendFailed) {
					appendFailed = true;
					appendFailure = new WorkflowExecutionAborted(
						"workflow parent finished with outstanding durable commands",
					);
				}
				throw new WorkflowExecutionAborted(
					"workflow parent finished with outstanding durable commands",
				);
			}
			if (!outcome.ok) {
				// A failed append is an infrastructure failure, even inside a step.
				if (appendFailed)
					throw new WorkflowExecutionAborted("workflow journal append failed");
				throw outcome.error;
			}
			assertScopeConsumed(scope);
			return outcome.value;
		}
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
				return command(async (scope) => {
					const parentStepIndex = scope.index;
					const treeStep = nextTreeStep(scope, name);
					const index = treeStep?.index ?? stepIndex++;
					if (!treeStep) consumeCommand({ kind: "step", index, name });
					const completed = findCompletedStep(name, index);
					if (completed && isRecord(completed.data)) {
						// Journaled on a prior attempt — short-circuit, do NOT re-run.
						// SAFETY: assertion to `ed.data.result as T; }` is required at this boundary.
						return completed.data.result as T;
					}
					if (treeStep?.terminal?.kind === "failed") {
						const failed = [...journal]
							.reverse()
							.find(
								(event) =>
									event.type === "run.StepFailed" &&
									isRecord(event.data) &&
									event.data.name === name &&
									event.data.index === index,
							);
						if (
							!failed ||
							!isRecord(failed.data) ||
							!isJsonString(failed.data.message)
						) {
							abortHistory("invalid recorded workflow step failure");
						}
						throw new WorkflowFailure(failed.data.message, { step: name });
					}
					await appendEvent("run.StepScheduled", {
						name,
						index,
						parentStepIndex,
					});
					requireOpen(scope);
					let attemptScope: CommandScope | undefined;
					try {
						const result = await runWithRetries(
							name,
							() => {
								attemptScope = {
									index,
									parent: scope,
									active: true,
									pending: 0,
									commands: treeStep?.children,
									cursor: 0,
								};
								return runInScope(attemptScope, fn);
							},
							opts ?? {},
						);
						requireOpen(scope);
						await appendEvent("run.StepCompleted", { name, index, result });
						if (treeStep) {
							treeStep.active = false;
							const recorded = findCompletedStep(name, index);
							treeStep.terminal = {
								kind: "completed",
								result:
									recorded && isRecord(recorded.data)
										? recorded.data.result
										: undefined,
							};
						}
						return result;
					} catch (error) {
						if (error instanceof WorkflowFailure) {
							if (attemptScope) assertScopeConsumed(attemptScope);
							await appendEvent("run.StepFailed", {
								name,
								index,
								message: error.message,
							});
							if (treeStep) {
								treeStep.active = false;
								treeStep.terminal = { kind: "failed" };
							}
						}
						throw error;
					}
				});
			},
			async sleep(durationMs, sleepOptions) {
				return command(async (scope) => {
					if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
						throw new TypeError(
							"workflow sleep delay must be a nonnegative safe integer",
						);
					}
					const parentStepIndex = scope.index;
					const treeSleep = nextTreeSleep(scope, durationMs);
					const index = treeSleep?.index ?? sleepIndex++;
					if (!treeSleep)
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
								await appendEvent("run.SleepDeadlineSet", {
									index,
									...deadline,
								});
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
					requireOpen(scope);
					for (;;) {
						const current = nowMs();
						const remaining = deadlineMs - current;
						if (remaining <= 0) {
							completedAtMs = current;
							break;
						}
						await wait(Math.min(remaining, 2_147_483_647));
						requireOpen(scope);
					}
					await appendEvent("run.SleepCompleted", { index, completedAtMs });
				});
			},
			async emit(type, data) {
				return command(async (scope) => {
					if (type.startsWith("run.")) {
						throw new TypeError(
							"workflow event type uses the reserved run. namespace",
						);
					}
					if (version !== 3) return appendEvent(type, data ?? null);
					let snapshot: JsonValue;
					try {
						snapshot = cloneAsJson(data ?? null);
					} catch (error) {
						return poison(error);
					}
					const event = nextTreeEmit(scope, type, snapshot);
					if (event.seq !== undefined) return event.seq;
					const seq = await appendEvent(type, snapshot, {
						workflowEmit: {
							index: event.index,
							parentStepIndex: scope.index,
							nullPayload: snapshot === null,
						},
					});
					event.seq = seq;
					return seq;
				});
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
			const result = await runInScope(rootScope, () => def.run(ctx, args));
			assertConsumedCommands();
			await appendEvent("run.Completed", { result });
			return { runId, status: "completed", result, error: undefined };
		} catch (error) {
			if (error instanceof WorkflowExecutionAborted && appendFailed)
				throw appendFailure;
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
			const requestedRunId = startOptions?.runId;
			const runId = requireWorkflowRunId(
				requestedRunId === undefined ? `run-${randomUUID()}` : requestedRunId,
			);
			const lease = claimWorkflowExecution(store, runId);
			try {
				const definition = captureWorkflowDefinition(def);
				const input = captureWorkflowInput(args);
				const streamId = `run/${runId}`;
				// Claim the new run before any user step. No shared idempotency key is
				// used here: two fresh callers must not deduplicate into one run.
				const started = nextEnvelope(
					streamId,
					1,
					"run.Started",
					cloneAsJson({
						seed,
						args: input,
						workflowName: definition.name,
						commandTreeVersion: 3,
					}),
				);
				await recordEffect(store, started, 0);
				return await execute(definition, runId, input, lease);
			} finally {
				lease.finished = true;
				lease.releaseIfDrained();
			}
		},
		async resume(def, runId, args) {
			const id = requireWorkflowRunId(runId);
			const lease = claimWorkflowExecution(store, id);
			try {
				const definition = captureWorkflowDefinition(def);
				const input = captureWorkflowInput(args);
				return await execute(definition, id, input, lease);
			} finally {
				lease.finished = true;
				lease.releaseIfDrained();
			}
		},
		async journal(runId) {
			const id = requireWorkflowRunId(runId);
			const streamId = `run/${id}`;
			const events = captureJournalStream(
				await store.readStream(streamId),
				streamId,
			);
			return events.map((event) => ({
				type: event.type,
				data: cloneAsJson(event.data),
			}));
		},
		toReplayDefinition(def) {
			const definition = captureWorkflowDefinition(def);
			return {
				name: definition.name,
				initialState: () => null,
				execute: async (rctx, _state, args) => {
					const replayCtx = createRuntimeContext({
						capabilities: definition.capabilities,
						effects: {
							step: <T>(name: string, fn: () => Promise<T> | T) =>
								rctx.step<T>(name, fn),
							sleep: async (durationMs: number) => {
								await rctx.sleep(durationMs);
							},
							emit: (type, data) =>
								rctx.emit?.(type, data) ?? Promise.resolve(0),
							now: () => rctx.now(),
							random: (label) => rctx.random(label),
							token: tokenBroker,
							async tool(name, input) {
								return rctx.step(`tool:${name}`, () => {
									const impl = definition.tools[name];
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
					return definition.run(ctx, args);
				},
			};
		},
	};
}

function isRecord<T>(value: T): value is T & JsonBag {
	return isJsonObject(value);
}
