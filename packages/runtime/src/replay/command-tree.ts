import {
	cloneAsJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	type JsonValue,
} from "../json.js";
import {
	parseRunHookResumedFact,
	parseRunSleepCompletedFact,
	parseRunSleepDeadlineSetFact,
	parseRunSleepScheduledFact,
	parseRunStepCompletedFact,
	parseRunStepFailedFact,
	parseRunStepScheduledFact,
} from "../workflow-value.js";
import { snapshotJournalData } from "./journal-stream.js";
import type { EventEnvelope } from "./types.js";

type ParentIndex = number | null;

export interface ReplayStepCommand {
	kind: "step";
	index: number;
	name: string;
	parent: ParentIndex;
	active: boolean;
	terminal:
		| { kind: "completed"; result: JsonValue | undefined }
		| { kind: "failed"; message: string }
		| undefined;
	children: ReplayCommand[];
}

export interface ReplaySleepCommand {
	kind: "sleep";
	index: number;
	delayMs: number;
	label: string | undefined;
	parent: ParentIndex;
	deadlineMs: number;
	completed: boolean;
}

export interface ReplayEmitCommand {
	kind: "emit";
	index: number;
	parent: ParentIndex;
	type: string;
	data: JsonValue;
	seq: number | undefined;
}

export type ReplayCommand =
	| ReplayStepCommand
	| ReplaySleepCommand
	| ReplayEmitCommand;

export interface ReplayCommandTree {
	roots: ReplayCommand[];
	steps: ReadonlyMap<number, ReplayStepCommand>;
	sleeps: ReadonlyMap<number, ReplaySleepCommand>;
	emits: number;
}

const snapshot = snapshotJournalData;

type SleepDeadline =
	| { kind: "inline"; deadlineMs: number }
	| { kind: "pending" }
	| { kind: "rebased"; deadlineMs: number };

function inlineDeadline(source: SleepDeadline | undefined): number | undefined {
	return source?.kind === "inline" ? source.deadlineMs : undefined;
}

function resolvedDeadline(
	source: SleepDeadline | undefined,
): number | undefined {
	if (!source || source.kind === "pending") return undefined;
	return source.deadlineMs;
}

export function readReplayCommandTree(
	events: readonly EventEnvelope[],
	runId: string,
): ReplayCommandTree {
	const roots: ReplayCommand[] = [];
	const steps = new Map<number, ReplayStepCommand>();
	const sleeps = new Map<number, ReplaySleepCommand>();
	const sleepDeadlines = new Map<number, SleepDeadline>();
	let emitCount = 0;
	let afterTerminal = false;
	let lastSeq = 0;

	function parentFor(value: ParentIndex): ParentIndex {
		if (value === null) return null;
		const parent = steps.get(value);
		if (!parent?.active)
			throw new Error(`workflow command parent is not active for ${runId}`);
		return value;
	}

	function append(command: ReplayCommand): void {
		if (command.parent === null) roots.push(command);
		else {
			const parent = steps.get(command.parent);
			if (!parent?.active)
				throw new Error(`workflow command parent is not active for ${runId}`);
			parent.children.push(command);
		}
	}

	function stepFor(index: number, name: string): ReplayStepCommand {
		const previous = steps.get(index);
		if (previous) {
			if (previous.name !== name)
				throw new Error(`step name differs from journal for ${runId}`);
			return previous;
		}
		if (index !== steps.size)
			throw new Error(`gapped step journal for ${runId}`);
		const command: ReplayStepCommand = {
			kind: "step",
			index,
			name,
			parent: null,
			active: true,
			terminal: undefined,
			children: [],
		};
		steps.set(index, command);
		append(command);
		return command;
	}

	for (const event of events) {
		if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) {
			throw new Error("invalid workflow journal sequence");
		}
		lastSeq = event.seq;
		if (afterTerminal) throw new Error(`events after terminal for ${runId}`);
		if (event.type === "run.Started") continue;
		if (event.type === "run.Completed" || event.type === "run.Failed") {
			for (const root of roots) {
				if (root.kind === "sleep" && !root.completed)
					throw new Error(
						`workflow sleep lacks completion evidence for ${runId}`,
					);
				if (root.kind === "step" && root.active)
					throw new Error(
						`unconsumed scheduled step (orphan StepScheduled) for ${runId}`,
					);
			}
			afterTerminal = true;
			continue;
		}
		if (!event.type.startsWith("run.")) {
			const metadata = isJsonObject(event.meta)
				? event.meta.workflowEmit
				: undefined;
			if (
				!isJsonObject(metadata) ||
				!isJsonNumber(metadata.index) ||
				!Number.isSafeInteger(metadata.index) ||
				metadata.index !== emitCount ||
				!isJsonBoolean(metadata.nullPayload)
			) {
				throw new Error("invalid workflow event command metadata");
			}
			if (
				metadata.nullPayload &&
				event.data !== null &&
				!(isJsonObject(event.data) && Object.keys(event.data).length === 0)
			) {
				throw new Error("invalid workflow event payload metadata");
			}
			if (!metadata.nullPayload && event.data === null)
				throw new Error("invalid workflow event payload metadata");
			const rawParent = metadata.parentStepIndex;
			if (
				rawParent !== null &&
				(!isJsonNumber(rawParent) ||
					!Number.isSafeInteger(rawParent) ||
					rawParent < 0)
			)
				throw new Error("invalid workflow event command metadata");
			append({
				kind: "emit",
				index: emitCount,
				parent: parentFor(rawParent),
				type: event.type,
				data: metadata.nullPayload ? null : cloneAsJson(event.data),
				seq: event.seq,
			});
			emitCount += 1;
			continue;
		}
		if (event.type === "run.SleepScheduled") {
			const fact = parseRunSleepScheduledFact(snapshot(event.data));
			const previous = sleeps.get(fact.index);
			if (previous) {
				if (
					previous.delayMs !== fact.delayMs ||
					previous.label !== fact.label ||
					previous.parent !== fact.parentStepIndex ||
					inlineDeadline(sleepDeadlines.get(fact.index)) !== fact.deadlineMs
				)
					throw new Error(
						`invalid run.SleepScheduled for ${runId}: sleep schedule diverged`,
					);
				continue;
			}
			if (fact.index !== sleeps.size)
				throw new Error(`sleep schedule diverged on replay for ${runId}`);
			const command: ReplaySleepCommand = {
				kind: "sleep",
				index: fact.index,
				delayMs: fact.delayMs,
				label: fact.label,
				parent: parentFor(fact.parentStepIndex),
				deadlineMs: fact.deadlineMs ?? 0,
				completed: false,
			};
			sleepDeadlines.set(
				fact.index,
				fact.deadlineMs === undefined
					? { kind: "pending" }
					: { kind: "inline", deadlineMs: fact.deadlineMs },
			);
			sleeps.set(fact.index, command);
			append(command);
			continue;
		}
		if (event.type === "run.SleepDeadlineSet") {
			const fact = parseRunSleepDeadlineSetFact(snapshot(event.data));
			const sleep = sleeps.get(fact.index);
			const source = sleepDeadlines.get(fact.index);
			if (!sleep || !source)
				throw new Error(`invalid workflow sleep deadline record for ${runId}`);
			if (source.kind !== "pending")
				throw new Error(`duplicate workflow sleep deadline for ${runId}`);
			const sum = fact.scheduledAtMs + sleep.delayMs;
			if (!Number.isSafeInteger(sum) || fact.deadlineMs !== sum)
				throw new Error(
					`invalid recorded workflow sleep deadline for ${runId}`,
				);
			sleep.deadlineMs = fact.deadlineMs;
			sleepDeadlines.set(fact.index, {
				kind: "rebased",
				deadlineMs: fact.deadlineMs,
			});
			continue;
		}
		if (event.type === "run.SleepCompleted") {
			const fact = parseRunSleepCompletedFact(snapshot(event.data));
			const sleep = sleeps.get(fact.index);
			if (sleep?.completed)
				throw new Error(`duplicate workflow sleep completion for ${runId}`);
			if (!sleep || (sleep.parent !== null && !steps.get(sleep.parent)?.active))
				throw new Error(
					`invalid workflow sleep completion evidence for ${runId}`,
				);
			const deadline = resolvedDeadline(sleepDeadlines.get(fact.index));
			if (deadline === undefined)
				throw new Error(
					`invalid run.SleepScheduled for ${runId}: invalid recorded workflow sleep deadline`,
				);
			if (fact.completedAtMs < deadline)
				throw new Error(`invalid workflow sleep completion time for ${runId}`);
			sleep.deadlineMs = deadline;
			sleep.completed = true;
			continue;
		}
		if (event.type === "run.HookResumed") {
			parseRunHookResumedFact(snapshot(event.data));
			continue;
		}
		if (event.type === "run.StepScheduled") {
			const fact = parseRunStepScheduledFact(snapshot(event.data));
			const previous = steps.get(fact.index);
			if (previous) {
				if (previous.name !== fact.name)
					throw new Error(`step name differs from journal for ${runId}`);
				if (previous.parent !== fact.parentStepIndex || previous.terminal)
					throw new Error(`workflow step schedule diverged for ${runId}`);
				continue;
			}
			if (fact.index !== steps.size)
				throw new Error(`gapped step journal for ${runId}`);
			const command: ReplayStepCommand = {
				kind: "step",
				index: fact.index,
				name: fact.name,
				parent: parentFor(fact.parentStepIndex),
				active: true,
				terminal: undefined,
				children: [],
			};
			steps.set(fact.index, command);
			append(command);
			continue;
		}
		if (event.type !== "run.StepCompleted" && event.type !== "run.StepFailed")
			throw new Error("unknown reserved workflow journal event type");
		const outcome =
			event.type === "run.StepCompleted"
				? {
						kind: "completed" as const,
						fact: parseRunStepCompletedFact(snapshot(event.data)),
					}
				: {
						kind: "failed" as const,
						fact: parseRunStepFailedFact(snapshot(event.data)),
					};
		const terminal = steps.get(outcome.fact.index)?.terminal;
		if (terminal) {
			if (terminal.kind !== outcome.kind)
				throw new Error(`conflicting step outcomes for ${runId}`);
			throw new Error(
				outcome.kind === "completed"
					? `duplicate run.StepCompleted for ${runId}`
					: `duplicate run.StepFailed for ${runId}`,
			);
		}
		const step = stepFor(outcome.fact.index, outcome.fact.name);
		if (step.parent !== null && !steps.get(step.parent)?.active) {
			throw new Error(`workflow command parent is not active for ${runId}`);
		}
		for (const child of step.children) {
			if (child.kind === "sleep" && !child.completed)
				throw new Error(`nested sleep lacks completion evidence for ${runId}`);
			if (child.kind === "step" && (child.active || !child.terminal))
				throw new Error(
					`nested step is unfinished at parent outcome for ${runId}`,
				);
		}
		step.active = false;
		step.terminal =
			outcome.kind === "failed"
				? { kind: "failed", message: outcome.fact.message }
				: { kind: "completed", result: outcome.fact.result };
	}
	for (const sleep of sleeps.values()) {
		const deadline = resolvedDeadline(sleepDeadlines.get(sleep.index));
		if (deadline === undefined)
			throw new Error(
				`invalid run.SleepScheduled for ${runId}: invalid recorded workflow sleep deadline`,
			);
		sleep.deadlineMs = deadline;
	}
	return { roots, steps, sleeps, emits: emitCount };
}
