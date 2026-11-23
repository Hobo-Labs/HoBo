import { isDeepStrictEqual } from "node:util";
import { cloneAsJson, isJsonString, type JsonValue } from "../json.js";
import {
	captureWorkflowInput,
	isNonEmptyPrimitiveString,
	parseRunStartedFact,
	requireWorkflowRunId,
} from "../workflow-value.js";
import { readReplayCommandTree } from "./command-tree.js";
import { createDeterministicContext } from "./context.js";
import { digest } from "./divergence.js";
import {
	hashReadSet,
	seqVector,
	stableStringify,
	toSeqVectorEntries,
} from "./equivalence.js";
import { validateJournalHistory } from "./journal-history.js";
import { captureJournalStream, snapshotJournalData } from "./journal-stream.js";
import type { EventStoreReader } from "./store.js";
import type { ReplayReport } from "./types.js";

export interface WorkflowDefinition<S, A> {
	name: string;
	initialState(args: A): S;
	execute(ctx: WorkflowReplayContext, state: S, args: A): Promise<S> | S;
}

export interface WorkflowReplayContext {
	runId: string;
	seed: string;
	now(): string;
	random(label?: string): number;
	step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
	sleep(delayMs: number): Promise<void>;
	emit?(type: string, data?: JsonValue): Promise<number>;
	resumeHook<T>(payload: T): T;
}

export interface ReplayOptions {
	seed?: string;
}

export interface ReplayResult<S> {
	state: S;
	report: ReplayReport;
}

export async function replayRun<S, A>(
	store: EventStoreReader,
	runId: string,
	workflow: WorkflowDefinition<S, A>,
	args: A,
	options: ReplayOptions = {},
): Promise<ReplayResult<S>> {
	const id = requireWorkflowRunId(runId);
	const input = captureWorkflowInput(args);
	const suppliedSeed = options.seed;
	const workflowName = workflow.name;
	const initialState = workflow.initialState;
	const execute = workflow.execute;
	if (
		!isJsonString(workflowName) ||
		String(workflowName) !== workflowName ||
		!workflowName
	)
		throw new TypeError("workflow name must be a non-empty string");
	if (suppliedSeed !== undefined && !isNonEmptyPrimitiveString(suppliedSeed))
		throw new TypeError("replay seed must be a non-empty string");
	const streamId = `run/${id}`;
	const events = captureJournalStream(
		await store.readStream(streamId),
		streamId,
	);
	validateJournalHistory(events, id);
	const recordedVector = seqVector(events);
	const started = events[0];
	if (started?.type !== "run.Started") {
		throw new Error(`missing run.Started for ${runId}`);
	}
	const startedFact = parseRunStartedFact(snapshotJournalData(started.data));
	if (!isDeepStrictEqual(startedFact.args, input))
		throw new Error(`workflow input differs from run.Started for ${runId}`);
	if (startedFact.workflowName !== workflowName)
		throw new Error(`workflow name differs from run.Started for ${runId}`);
	if (suppliedSeed !== undefined && suppliedSeed !== startedFact.seed)
		throw new Error(`workflow seed differs from run.Started for ${runId}`);
	const seed = startedFact.seed;
	const tree = readReplayCommandTree(events, id).roots;
	let treeCursor = 0;

	let state = Function.prototype.call.call(initialState, workflow, input);

	const ctx: WorkflowReplayContext = {
		runId,
		seed,
		now: () =>
			createDeterministicContext({
				seed,
				mode: "replay",
				eventKey: `${streamId}:orchestration`,
			}).now(),
		random: (label = "workflow") =>
			createDeterministicContext({
				seed,
				mode: "replay",
				eventKey: `${streamId}:orchestration:${label}`,
			}).random(label),
		async step<T>(name: string, _fn: () => Promise<T> | T): Promise<T> {
			const command = tree[treeCursor];
			if (command?.kind !== "step" || command.name !== name) {
				throw new Error(
					`workflow command history diverged at index ${treeCursor}`,
				);
			}
			if (command.terminal?.kind !== "completed") {
				throw new Error(
					`missing memoized step ${name} at index ${command.index}`,
				);
			}
			treeCursor += 1;
			const result = command.terminal.result;
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the recorded JSON result has the workflow step's result type.
			return (result === undefined ? undefined : cloneAsJson(result)) as T;
		},
		async sleep(delayMs) {
			const command = tree[treeCursor];
			if (!command)
				throw new Error(`missing run.SleepScheduled at index ${treeCursor}`);
			if (command.kind !== "sleep" || command.delayMs !== delayMs) {
				throw new Error("sleep schedule diverged");
			}
			if (!command.completed) {
				throw new Error("workflow sleep lacks completion evidence");
			}
			treeCursor += 1;
		},
		async emit(type, data) {
			const command = tree[treeCursor];
			if (
				command?.kind !== "emit" ||
				command.type !== type ||
				!isDeepStrictEqual(command.data, cloneAsJson(data ?? null)) ||
				command.seq === undefined
			) {
				throw new Error(
					`workflow command history diverged at index ${treeCursor}`,
				);
			}
			treeCursor += 1;
			return command.seq;
		},
		resumeHook<T>(_payload: T) {
			const resumed = events.find((event) => event.type === "run.HookResumed");
			if (!resumed) {
				throw new Error("missing run.HookResumed");
			}
			// SAFETY: assertion to `resumed.data as { payload: T }` is required at this boundary.
			return (resumed.data as { payload: T }).payload as T;
		},
	};

	state = await Function.prototype.call.call(
		execute,
		workflow,
		ctx,
		state,
		input,
	);
	const remaining = tree[treeCursor];
	if (remaining) {
		const type =
			remaining.kind === "step"
				? "run.StepCompleted"
				: remaining.kind === "sleep"
					? "run.SleepScheduled"
					: "application event";
		throw new Error(`unconsumed ${type} at index ${treeCursor}`);
	}

	const report: ReplayReport = Object.freeze({
		runId,
		seqVector: toSeqVectorEntries(recordedVector),
		readSetHash: hashReadSet(events),
		stateDigest: digest(cloneAsJson(state)),
		mode: "replay",
		seed,
	});

	return { state, report };
}

export function canonicalStateBytes<S>(state: S): string {
	return stableStringify(cloneAsJson(state));
}
