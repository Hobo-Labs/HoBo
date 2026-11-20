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
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
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
	type ParsedRunSleepScheduled,
	type ParsedRunStepCompleted,
	type ParsedRunStepFailed,
	parseRunCompletedFact,
	parseRunFailedFact,
	parseRunSleepScheduledFact,
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
	/** Wait for a duration before rechecking the clock; defaults to a Node timer. */
	wait?: (delayMs: number) => Promise<void>;
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

function snapshotOwnProperty(
	copy: JsonValue[] | JsonBag,
	source: JsonValue[] | JsonBag,
	key: string | symbol,
	seen: Set<object>,
): void {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	if (!descriptor) return;
	if (!("value" in descriptor)) {
		const accessor: PropertyDescriptor = {
			enumerable: descriptor.enumerable === true,
			configurable: true,
		};
		if (descriptor.get) accessor.get = descriptor.get;
		if (descriptor.set) accessor.set = descriptor.set;
		Object.defineProperty(copy, key, accessor);
		return;
	}
	const value =
		descriptor.value === undefined
			? undefined
			: snapshotJournalData(descriptor.value, seen);
	Object.defineProperty(copy, key, {
		value,
		enumerable: descriptor.enumerable === true,
		writable: true,
		configurable: true,
	});
}

function snapshotJournalData(
	value: JsonValue,
	seen = new Set<object>(),
): JsonValue {
	if (!isJsonObject(value) && !isJsonArray(value)) return value;
	if (seen.has(value)) throw new Error("cyclic journal data");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const copy: JsonValue[] = [];
			copy.length = value.length;
			for (const name of Object.getOwnPropertyNames(value)) {
				if (name === "length") continue;
				snapshotOwnProperty(copy, value, name, seen);
			}
			for (const symbol of Object.getOwnPropertySymbols(value)) {
				snapshotOwnProperty(copy, value, symbol, seen);
			}
			return copy;
		}
		const copy: JsonBag = {};
		for (const key of Object.getOwnPropertyNames(value)) {
			snapshotOwnProperty(copy, value, key, seen);
		}
		for (const symbol of Object.getOwnPropertySymbols(value)) {
			snapshotOwnProperty(copy, value, symbol, seen);
		}
		return copy;
	} finally {
		seen.delete(value);
	}
}

function listStepOutcomeIndices(
	journal: ReadonlyArray<{ type: string; data: JsonValue }>,
): number[] {
	const indices: number[] = [];
	for (const event of journal) {
		if (event.type === "run.StepCompleted" && isRecord(event.data)) {
			const fact = parseRunStepCompletedFact(snapshotJournalData(event.data));
			indices.push(fact.index);
		} else if (event.type === "run.StepFailed" && isRecord(event.data)) {
			const fact = parseRunStepFailedFact(snapshotJournalData(event.data));
			indices.push(fact.index);
		}
	}
	return indices;
}

function isBoundedStepIndex(index: number): boolean {
	return (
		Number.isSafeInteger(index) &&
		index >= 0 &&
		index <= 1_000_000 &&
		!Object.is(index, -0)
	);
}

function assertContiguousStepJournal(
	runId: string,
	scheduledSteps: ReadonlyMap<number, string>,
	outcomeIndices: ReadonlySet<number>,
): void {
	let maxOutcome = -1;
	for (const index of outcomeIndices) {
		if (!isBoundedStepIndex(index)) {
			throw new Error(`invalid step journal for ${runId}`);
		}
		if (index > maxOutcome) maxOutcome = index;
	}
	for (const index of scheduledSteps.keys()) {
		if (!isBoundedStepIndex(index)) {
			throw new Error(`invalid step journal for ${runId}`);
		}
	}
	let maxIndex = maxOutcome;
	for (const index of scheduledSteps.keys()) {
		if (index > maxIndex) maxIndex = index;
	}
	for (let index = 0; index <= maxIndex; index += 1) {
		if (!outcomeIndices.has(index) && !scheduledSteps.has(index)) {
			throw new Error(`gapped step journal for ${runId}`);
		}
	}
}

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
		const startedFact = parseRunStartedFact(
			snapshotJournalData(started.data),
			seed,
		);
		const input = captureWorkflowInput(args);
		if (!isDeepStrictEqual(cloneAsJson(startedFact.args), cloneAsJson(input))) {
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
			const fact = parseRunStepScheduledFact(snapshotJournalData(event.data));
			const previous = scheduledSteps.get(fact.index);
			if (previous !== undefined && previous !== fact.name) {
				throw new Error(`step name differs from journal for ${runId}`);
			}
			if (previous === undefined) {
				scheduledSteps.set(fact.index, fact.name);
			}
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
				const fact = parseRunStepCompletedFact(snapshotJournalData(event.data));
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
				const fact = parseRunStepFailedFact(snapshotJournalData(event.data));
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
		const unconsumedScheduledSteps = new Set(scheduledSteps.keys());
		assertContiguousStepJournal(runId, scheduledSteps, unconsumedOutcomes);
		const sleepFacts = new Map<number, ParsedRunSleepScheduled>();
		const sleepData = new Map<number, JsonBag>();
		for (const event of journal) {
			if (event.type !== "run.SleepScheduled") continue;
			const data = snapshotJournalData(event.data);
			let factData: JsonValue = data;
			let recordedData: JsonBag | undefined;
			if (isJsonObject(data)) {
				const objectData: JsonObject = data;
				recordedData = { ...objectData };
				const scheduleData: JsonBag = {};
				for (const [key, value] of Object.entries(objectData)) {
					if (key !== "scheduledAtMs" && key !== "deadlineMs") {
						scheduleData[key] = value;
					}
				}
				factData = scheduleData;
			}
			const fact = parseRunSleepScheduledFact(factData);
			const previous = sleepFacts.get(fact.index);
			if (previous !== undefined) {
				if (
					previous.delayMs !== fact.delayMs ||
					previous.label !== fact.label
				) {
					throw new Error(`invalid run.SleepScheduled for ${runId}`);
				}
				continue;
			}
			sleepFacts.set(fact.index, fact);
			if (recordedData) sleepData.set(fact.index, recordedData);
		}
		const unconsumedScheduledSleeps = new Set(sleepFacts.keys());
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
		type RecordedCommand =
			| { kind: "step"; index: number; name: string }
			| { kind: "sleep"; index: number; delayMs: number };
		const commands: RecordedCommand[] = [];
		const stepNames = new Map<number, string>();
		const recordedSleepIndices = new Set<number>();
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
				stepNames.set(index, name);
				commands.push({ kind: "step", index, name });
			} else if (event.type === "run.SleepScheduled") {
				if (
					!isRecord(event.data) ||
					!isJsonNumber(event.data.delayMs) ||
					!Number.isSafeInteger(event.data.delayMs) ||
					event.data.delayMs < 0 ||
					(event.data.index !== undefined &&
						(!isJsonNumber(event.data.index) ||
							!Number.isSafeInteger(event.data.index) ||
							event.data.index < 0))
				) {
					throw new Error("invalid recorded workflow command");
				}
				const index = event.data.index ?? recordedSleeps;
				if (recordedSleepIndices.has(index)) continue;
				commands.push({
					kind: "sleep",
					index,
					delayMs: event.data.delayMs,
				});
				recordedSleepIndices.add(index);
				recordedSleeps = Math.max(recordedSleeps, index + 1);
			}
		}
		let commandIndex = 0;
		function consumeCommand(command: RecordedCommand): void {
			if (
				command.kind === "step" &&
				!scheduledSteps.has(command.index) &&
				unconsumedOutcomes.has(command.index)
			) {
				return;
			}
			const expected = commands[commandIndex];
			if (expected && !isDeepStrictEqual(expected, command)) {
				let message = `workflow command history diverged at index ${commandIndex}`;
				if (
					expected.kind === "step" &&
					command.kind === "step" &&
					expected.index === command.index &&
					expected.name !== command.name
				) {
					message += `: step name differs from journal for ${runId}`;
				} else if (expected.kind === "sleep" && command.kind === "sleep") {
					message += `: sleep schedule diverged on replay for ${runId}`;
				}
				rejectReplay(message);
			}
			commandIndex += 1;
		}
		function assertConsumedCommands(): void {
			assertReplayConsistent();
			const expected = commands[commandIndex];
			if (expected) {
				let detail = `unconsumed scheduled sleep (orphan SleepScheduled) for ${runId}`;
				if (expected.kind === "step") {
					detail = unconsumedOutcomes.has(expected.index)
						? `unconsumed step outcome for ${runId}`
						: `unconsumed scheduled step (orphan StepScheduled) for ${runId}`;
				}
				throw new Error(
					`unconsumed workflow command at index ${commandIndex}: ${detail}`,
				);
			}
		}

		function assertNoTerminalBeforeRunEvent(type: string): void {
			if (!type.startsWith("run.")) return;
			for (const event of journal) {
				if (event.type === "run.Completed" || event.type === "run.Failed") {
					throw new Error(`events after terminal for ${runId}`);
				}
			}
		}

		async function appendEvent<T>(type: string, data: T): Promise<number> {
			assertNoTerminalBeforeRunEvent(type);
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
			if (unconsumedScheduledSteps.size > 0) {
				throw new Error(
					`unconsumed scheduled step (orphan StepScheduled) for ${runId}`,
				);
			}
			if (unconsumedScheduledSleeps.size > 0) {
				throw new Error(
					`unconsumed scheduled sleep (orphan SleepScheduled) for ${runId}`,
				);
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
					const fact = parseRunStepCompletedFact(
						snapshotJournalData(event.data),
					);
					if (fact.index === index) completed = fact;
				} else if (event.type === "run.StepFailed" && isRecord(event.data)) {
					const fact = parseRunStepFailedFact(snapshotJournalData(event.data));
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
					const fact = parseRunStepCompletedFact(
						snapshotJournalData(event.data),
					);
					if (fact.name === name && fact.index === index) completed.push(event);
				} else if (event.type === "run.StepFailed" && isRecord(event.data)) {
					const fact = parseRunStepFailedFact(snapshotJournalData(event.data));
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
				if (!isBoundedStepIndex(index)) {
					rejectReplay(`invalid step journal for ${runId}`);
				}
				const recorded = stepRecordedAtIndex(index);
				if (recorded.completed && recorded.completed.name !== name) {
					rejectStepName();
				}
				if (recorded.failed && recorded.failed.name !== name) {
					rejectStepName();
				}
				consumeCommand({ kind: "step", index, name });
				const scheduled = scheduledSteps.get(index);
				if (scheduled !== undefined && scheduled !== name) {
					rejectStepName();
				}
				const { completed, failed } = stepOutcomesFor(name, index);
				const completedEvent = completed[0];
				if (completedEvent && isRecord(completedEvent.data)) {
					const result = replayStepCompletedResult<T>(
						snapshotJournalData(completedEvent.data),
					);
					unconsumedOutcomes.delete(index);
					unconsumedScheduledSteps.delete(index);
					return result;
				}
				const failedEvent = failed[0];
				if (failedEvent && isRecord(failedEvent.data)) {
					const stepFailed = parseRunStepFailedFact(
						snapshotJournalData(failedEvent.data),
					);
					unconsumedOutcomes.delete(index);
					unconsumedScheduledSteps.delete(index);
					throw new WorkflowFailure(stepFailed.message, {
						step: stepFailed.name,
					});
				}
				if (scheduled === undefined) {
					await appendEvent("run.StepScheduled", { name, index });
					scheduledSteps.set(index, name);
				}
				unconsumedScheduledSteps.delete(index);
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
				if (!isBoundedStepIndex(index)) {
					rejectReplay(`invalid run.SleepScheduled for ${runId}`);
				}
				const normalizedDurationMs = Object.is(durationMs, -0) ? 0 : durationMs;
				consumeCommand({
					kind: "sleep",
					index,
					delayMs: normalizedDurationMs,
				});
				const scheduled = sleepFacts.get(index);
				if (scheduled) {
					if (
						scheduled.delayMs !== normalizedDurationMs ||
						scheduled.label !== sleepOptions?.label
					) {
						rejectReplay(`sleep schedule diverged on replay for ${runId}`);
					}
					unconsumedScheduledSleeps.delete(index);
				} else {
					if (
						!Number.isSafeInteger(normalizedDurationMs) ||
						normalizedDurationMs < 0
					) {
						rejectReplay(`invalid run.SleepScheduled for ${runId}`);
					}
					for (const unconsumedIndex of unconsumedScheduledSleeps) {
						if (unconsumedIndex < index) {
							rejectReplay(`sleep schedule diverged on replay for ${runId}`);
						}
					}
					if (unconsumedScheduledSleeps.size > 0) {
						const nextUnconsumed = Math.min(...unconsumedScheduledSleeps);
						if (nextUnconsumed > index) {
							rejectReplay(`sleep schedule diverged on replay for ${runId}`);
						}
					}
				}
				const deadlines = journal.filter(
					(event) => event.type === "run.SleepDeadlineSet",
				);
				for (const event of deadlines) {
					if (
						!isRecord(event.data) ||
						!isJsonNumber(event.data.index) ||
						!isBoundedStepIndex(event.data.index) ||
						!sleepFacts.has(event.data.index)
					) {
						throw new Error("invalid workflow sleep deadline record");
					}
				}
				const rebased = deadlines.filter(
					(event) => isRecord(event.data) && event.data.index === index,
				);
				if (rebased.length > 1) {
					throw new Error("duplicate workflow sleep deadline");
				}
				let deadlineMs: number;
				if (scheduled) {
					const scheduledData = sleepData.get(index);
					if (!scheduledData) {
						rejectReplay(`invalid run.SleepScheduled for ${runId}`);
					}
					if (
						scheduledData.deadlineMs !== undefined ||
						scheduledData.scheduledAtMs !== undefined
					) {
						if (rebased.length) {
							throw new Error("duplicate workflow sleep deadline");
						}
						deadlineMs = readDeadline(scheduledData, normalizedDurationMs);
					} else {
						const previous = rebased[0];
						if (previous && isRecord(previous.data)) {
							deadlineMs = readDeadline(previous.data, normalizedDurationMs);
						} else {
							let nextIndex = index + 1;
							const remainingIndices = [...unconsumedScheduledSleeps].sort(
								(left, right) => left - right,
							);
							for (const remainingIndex of remainingIndices) {
								if (remainingIndex !== nextIndex) {
									rejectReplay(
										`sleep schedule diverged on replay for ${runId}`,
									);
								}
								nextIndex += 1;
							}
							const deadline = makeDeadline(normalizedDurationMs);
							await appendEvent("run.SleepDeadlineSet", { index, ...deadline });
							deadlineMs = deadline.deadlineMs;
						}
					}
				} else {
					if (
						sleepOptions?.label !== undefined &&
						!isJsonString(sleepOptions.label)
					) {
						rejectReplay(`invalid run.SleepScheduled for ${runId}`);
					}
					const deadline = makeDeadline(normalizedDurationMs);
					const data: JsonBag = {
						delayMs: normalizedDurationMs,
						index,
						...deadline,
					};
					if (sleepOptions?.label !== undefined)
						data.label = sleepOptions.label;
					await appendEvent("run.SleepScheduled", data);
					const recorded: ParsedRunSleepScheduled = {
						delayMs: normalizedDurationMs,
						index,
					};
					if (sleepOptions?.label !== undefined) {
						recorded.label = sleepOptions.label;
					}
					sleepFacts.set(index, recorded);
					sleepData.set(index, data);
					unconsumedScheduledSleeps.delete(index);
					deadlineMs = deadline.deadlineMs;
				}
				for (;;) {
					const remaining = deadlineMs - nowMs();
					if (remaining <= 0) return;
					await wait(Math.min(remaining, 2_147_483_647));
				}
			},
			async emit(type, data) {
				assertReplayConsistent();
				return appendEvent(type, data ?? null);
			},
			now: () => {
				assertReplayConsistent();
				return deterministic.now();
			},
			random: (label) => {
				assertReplayConsistent();
				return deterministic.random(label);
			},
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
			assertConsumedCommands();
			assertConsumedOutcomes();
			const result = captureWorkflowResult(value);
			await appendEvent("run.Completed", { result });
			return { runId, status: "completed", result, error: undefined };
		} catch (error) {
			if (error instanceof WorkflowFailure) {
				assertConsumedCommands();
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
