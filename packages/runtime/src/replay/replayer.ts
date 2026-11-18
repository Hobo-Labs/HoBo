import { isDeepStrictEqual } from "node:util";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";
import {
	captureWorkflowInput,
	requireWorkflowRunId,
} from "../workflow-boundary.js";
import { readReplayCommandTree } from "./command-tree.js";
import { createDeterministicContext } from "./context.js";
import { digest } from "./divergence.js";
import { hashReadSet, seqVector, stableStringify } from "./equivalence.js";
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
	if (
		suppliedSeed !== undefined &&
		(!isJsonString(suppliedSeed) || String(suppliedSeed) !== suppliedSeed)
	)
		throw new TypeError("replay seed must be a string");
	const streamId = `run/${id}`;
	const events = await store.readStream(streamId);
	const recordedVector = seqVector(events);
	const started = events.find((event) => event.type === "run.Started");
	if (!started || !isJsonObject(started.data)) {
		throw new Error(`missing run.Started for ${runId}`);
	}
	if (
		!Object.hasOwn(started.data, "args") ||
		!isDeepStrictEqual(started.data.args, input)
	)
		throw new Error(`workflow input differs from run.Started for ${runId}`);
	const version = started.data.commandTreeVersion;
	if (
		version !== undefined &&
		version !== 1 &&
		version !== 2 &&
		version !== 3
	) {
		throw new Error("unsupported workflow command tree version");
	}
	const recordedName = started.data.workflowName;
	if (
		(recordedName !== undefined && recordedName !== workflowName) ||
		(version === 3 && recordedName === undefined)
	)
		throw new Error(`workflow name differs from run.Started for ${runId}`);
	const recordedSeed = started.data.seed;
	if (
		(recordedSeed !== undefined &&
			(!isJsonString(recordedSeed) || String(recordedSeed) !== recordedSeed)) ||
		(version === 3 && recordedSeed === undefined) ||
		(suppliedSeed !== undefined &&
			recordedSeed !== undefined &&
			suppliedSeed !== recordedSeed)
	)
		throw new Error(`workflow seed differs from run.Started for ${runId}`);
	const seed = isJsonString(recordedSeed)
		? recordedSeed
		: (suppliedSeed ?? `run-${id}`);
	const tree =
		version === 1 || version === 2 || version === 3
			? readReplayCommandTree(events, version >= 2, version === 3)
			: undefined;
	let treeCursor = 0;

	let state = initialState.call(workflow, input);
	const stepResults = new Map<string, JsonValue>();
	const hookResults = new Map<string, JsonValue>();
	const timerResults = new Map<string, { delayMs: number }>();
	const completedSteps = events.filter(
		(event) => event.type === "run.StepCompleted",
	);
	const scheduledSleeps = events.filter(
		(event) => event.type === "run.SleepScheduled",
	);
	let stepCounter = 0;
	let sleepCounter = 0;

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
			if (tree) {
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
				// SAFETY: the recorded JSON result has the workflow step's result type.
				return command.terminal.result as T;
			}
			const stepId = `${name}:${stepCounter}`;
			const completed = events.find(
				(event) =>
					event.type === "run.StepCompleted" &&
					event.data &&
					matchesStep(event.data, name, stepCounter),
			);
			if (completed) {
				stepCounter += 1;
				// SAFETY: assertion to `completed.data as { result: T }` is required at this boundary.
				const result = (completed.data as { result: T }).result as T;
				stepResults.set(stepId, cloneAsJson(result));
				return result;
			}
			throw new Error(`missing memoized step ${name} at index ${stepCounter}`);
		},
		async sleep(delayMs) {
			if (tree) {
				const command = tree[treeCursor];
				if (!command)
					throw new Error(`missing run.SleepScheduled at index ${treeCursor}`);
				if (command.kind !== "sleep" || command.delayMs !== delayMs) {
					throw new Error("sleep schedule diverged");
				}
				if ((version === 2 || version === 3) && !command.completed) {
					throw new Error("workflow sleep lacks completion evidence");
				}
				treeCursor += 1;
				return;
			}
			const scheduled = scheduledSleeps[sleepCounter];
			if (!scheduled) {
				throw new Error(`missing run.SleepScheduled at index ${sleepCounter}`);
			}
			if (
				!isJsonObject(scheduled.data) ||
				scheduled.data.delayMs !== delayMs ||
				(scheduled.data.index !== undefined &&
					scheduled.data.index !== sleepCounter)
			) {
				throw new Error("sleep schedule diverged");
			}
			timerResults.set(`sleep:${sleepCounter}`, { delayMs });
			sleepCounter += 1;
		},
		async emit(type, data) {
			if (version !== 3) return 0;
			const command = tree?.[treeCursor];
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
			const payload = (resumed.data as { payload: T }).payload as T;
			hookResults.set("hook", cloneAsJson(payload));
			return payload;
		},
	};

	state = await execute.call(workflow, ctx, state, input);
	if (tree) {
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
	} else {
		if (stepCounter !== completedSteps.length) {
			throw new Error(`unconsumed run.StepCompleted at index ${stepCounter}`);
		}
		if (sleepCounter !== scheduledSleeps.length) {
			throw new Error(`unconsumed run.SleepScheduled at index ${sleepCounter}`);
		}
	}

	const report: ReplayReport = {
		runId,
		seqVector: Object.entries(recordedVector)
			.map(([streamIdEntry, seq]) => ({ streamId: streamIdEntry, seq }))
			.sort((left, right) => left.streamId.localeCompare(right.streamId)),
		readSetHash: hashReadSet(events),
		stateDigest: digest(cloneAsJson(state)),
		mode: "replay",
		seed,
	};

	return { state, report };
}

function matchesStep(data: JsonValue, name: string, index: number): boolean {
	if (!data || !isJsonObject(data)) {
		return false;
	}
	// SAFETY: assertion to `data as { name?: string; index?: number }` is required at this boundary.
	const record = data as { name?: string; index?: number };
	return record.name === name && record.index === index;
}

export function canonicalStateBytes<S>(state: S): string {
	return stableStringify(cloneAsJson(state));
}
