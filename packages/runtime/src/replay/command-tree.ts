import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";
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
		| { kind: "failed" }
		| undefined;
	children: ReplayCommand[];
}

export interface ReplaySleepCommand {
	kind: "sleep";
	index: number;
	delayMs: number;
	parent: ParentIndex;
	deadlineMs: number | undefined;
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

export function readReplayCommandTree(
	events: readonly EventEnvelope[],
	requireSleepCompletion = false,
	trackEmits = false,
): ReplayCommand[] {
	const roots: ReplayCommand[] = [];
	const steps = new Map<number, ReplayStepCommand>();
	const sleeps = new Map<number, ReplaySleepCommand>();
	let sleepCount = 0;
	let emitCount = 0;
	let afterTerminal = false;
	let lastSeq = 0;

	function parentFor(value: JsonValue | undefined): ParentIndex {
		if (value === null) return null;
		if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
			throw new Error("invalid workflow command parent");
		}
		const parent = steps.get(value);
		if (!parent?.active)
			throw new Error("workflow command parent is not active");
		return value;
	}

	function append(command: ReplayCommand): void {
		if (command.parent === null) roots.push(command);
		else {
			const parent = steps.get(command.parent);
			if (!parent?.active)
				throw new Error("workflow command parent is not active");
			parent.children.push(command);
		}
	}

	for (const event of events) {
		if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) {
			throw new Error("invalid workflow journal sequence");
		}
		lastSeq = event.seq;
		if (afterTerminal)
			throw new Error("workflow journal record after terminal outcome");
		if (event.type === "run.Completed" || event.type === "run.Failed") {
			if (requireSleepCompletion) {
				for (const root of roots) {
					if (root.kind === "sleep" && !root.completed)
						throw new Error("workflow sleep lacks completion evidence");
					if (root.kind === "step" && root.active)
						throw new Error(
							"workflow root step is unfinished at terminal outcome",
						);
				}
			}
			afterTerminal = true;
			continue;
		}
		if (trackEmits && !event.type.startsWith("run.")) {
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
			const parent = parentFor(metadata.parentStepIndex);
			append({
				kind: "emit",
				index: emitCount,
				parent,
				type: event.type,
				data: metadata.nullPayload ? null : event.data,
				seq: event.seq,
			});
			emitCount += 1;
			continue;
		}
		if (
			event.type !== "run.StepScheduled" &&
			event.type !== "run.StepCompleted" &&
			event.type !== "run.StepFailed" &&
			event.type !== "run.SleepScheduled" &&
			event.type !== "run.SleepCompleted"
		)
			continue;
		if (
			!isJsonObject(event.data) ||
			!isJsonNumber(event.data.index) ||
			!Number.isSafeInteger(event.data.index) ||
			event.data.index < 0
		) {
			throw new Error("invalid recorded workflow command");
		}
		const index = event.data.index;
		if (event.type === "run.SleepCompleted") {
			const sleep = sleeps.get(index);
			if (sleep?.completed)
				throw new Error("duplicate workflow sleep completion");
			if (
				!sleep ||
				(sleep.parent !== null && !steps.get(sleep.parent)?.active) ||
				!isJsonNumber(event.data.completedAtMs) ||
				!Number.isSafeInteger(event.data.completedAtMs) ||
				sleep.deadlineMs === undefined
			) {
				throw new Error("invalid workflow sleep completion evidence");
			}
			if (event.data.completedAtMs < sleep.deadlineMs)
				throw new Error("invalid workflow sleep completion time");
			sleep.completed = true;
			continue;
		}
		if (event.type === "run.SleepScheduled") {
			if (
				index !== sleepCount ||
				!isJsonNumber(event.data.delayMs) ||
				!Number.isSafeInteger(event.data.delayMs) ||
				event.data.delayMs < 0
			) {
				throw new Error("sleep schedule diverged");
			}
			const parent = parentFor(event.data.parentStepIndex);
			const { scheduledAtMs, deadlineMs } = event.data;
			if (
				scheduledAtMs !== undefined ||
				deadlineMs !== undefined ||
				requireSleepCompletion
			) {
				if (
					!isJsonNumber(scheduledAtMs) ||
					!Number.isSafeInteger(scheduledAtMs) ||
					scheduledAtMs < 0 ||
					!isJsonNumber(deadlineMs) ||
					!Number.isSafeInteger(deadlineMs) ||
					deadlineMs !== scheduledAtMs + event.data.delayMs
				) {
					throw new Error("invalid recorded workflow sleep deadline");
				}
			}
			const command: ReplaySleepCommand = {
				kind: "sleep",
				index,
				delayMs: event.data.delayMs,
				parent,
				deadlineMs: isJsonNumber(deadlineMs) ? deadlineMs : undefined,
				completed: false,
			};
			sleeps.set(index, command);
			append(command);
			sleepCount += 1;
			continue;
		}
		if (!isJsonString(event.data.name))
			throw new Error("invalid recorded workflow step");
		const name = event.data.name;
		const previous = steps.get(index);
		if (event.type === "run.StepScheduled") {
			const parent = parentFor(event.data.parentStepIndex);
			if (previous) {
				if (
					previous.name !== name ||
					previous.parent !== parent ||
					previous.terminal?.kind === "completed"
				) {
					throw new Error("workflow step schedule diverged");
				}
				previous.active = true;
				previous.terminal = undefined;
			} else {
				if (index !== steps.size)
					throw new Error("invalid workflow step order");
				const command: ReplayStepCommand = {
					kind: "step",
					index,
					name,
					parent,
					active: true,
					terminal: undefined,
					children: [],
				};
				steps.set(index, command);
				append(command);
			}
			continue;
		}
		if (!previous?.active || previous.name !== name)
			throw new Error("invalid workflow step outcome");
		if (previous.parent !== null && !steps.get(previous.parent)?.active) {
			throw new Error("workflow command parent is not active");
		}
		for (const child of previous.children) {
			if (child.kind === "sleep" && !child.completed)
				throw new Error("nested sleep lacks completion evidence");
			if (child.kind === "step" && (child.active || !child.terminal))
				throw new Error("nested step is unfinished at parent outcome");
		}
		previous.active = false;
		previous.terminal =
			event.type === "run.StepFailed"
				? { kind: "failed" }
				: { kind: "completed", result: event.data.result };
	}
	return roots;
}
