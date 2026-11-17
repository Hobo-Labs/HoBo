import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";
import { readReplayCommandTree } from "./command-tree.js";
import { createDeterministicContext } from "./context.js";
import { digest } from "./divergence.js";
import { hashReadSet, seqVector, stableStringify } from "./equivalence.js";
import type { EventStoreReader } from "./store.js";
import type { EventEnvelope, ReplayReport } from "./types.js";

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
	const streamId = `run/${runId}`;
	const events = await store.readStream(streamId);
	const seed = options.seed ?? readSeed(events) ?? `run-${runId}`;
	const started = events.find((event) => event.type === "run.Started");
	if (!started) {
		throw new Error(`missing run.Started for ${runId}`);
	}
	const version = isJsonObject(started.data)
		? started.data.commandTreeVersion
		: undefined;
	if (version !== undefined && version !== 1 && version !== 2) {
		throw new Error("unsupported workflow command tree version");
	}
	const tree =
		version === 1 || version === 2
			? readReplayCommandTree(events, version === 2)
			: undefined;
	let treeCursor = 0;

	let state = workflow.initialState(args);
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
				if (version === 2 && !command.completed) {
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

	state = await workflow.execute(ctx, state, args);
	if (tree) {
		const remaining = tree[treeCursor];
		if (remaining) {
			const type =
				remaining.kind === "step" ? "run.StepCompleted" : "run.SleepScheduled";
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
		seqVector: Object.entries(seqVector(events))
			.map(([streamIdEntry, seq]) => ({ streamId: streamIdEntry, seq }))
			.sort((left, right) => left.streamId.localeCompare(right.streamId)),
		readSetHash: hashReadSet(events),
		stateDigest: digest(cloneAsJson(state)),
		mode: "replay",
		seed,
	};

	return { state, report };
}

function readSeed(events: EventEnvelope[]): string | undefined {
	const started = events.find((event) => event.type === "run.Started");
	if (!started?.data || !isJsonObject(started.data)) {
		return undefined;
	}
	// SAFETY: assertion to `started.data as { seed?: JsonValue }` is required at this boundary.
	const seed = (started.data as { seed?: JsonValue }).seed;
	return isJsonString(seed) ? seed : undefined;
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
