import {
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
}

export type ReplayCommand = ReplayStepCommand | ReplaySleepCommand;

/** Parse v1 command provenance before reusing a parent result. */
export function readReplayCommandTree(
	events: readonly EventEnvelope[],
): ReplayCommand[] {
	const roots: ReplayCommand[] = [];
	const steps = new Map<number, ReplayStepCommand>();
	let sleepCount = 0;
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
		if (event.type === "run.Completed" || event.type === "run.Failed") {
			afterTerminal = true;
			continue;
		}
		if (
			event.type !== "run.StepScheduled" &&
			event.type !== "run.StepCompleted" &&
			event.type !== "run.StepFailed" &&
			event.type !== "run.SleepScheduled"
		)
			continue;
		if (afterTerminal)
			throw new Error("workflow command recorded after terminal outcome");
		if (
			!isJsonObject(event.data) ||
			!isJsonNumber(event.data.index) ||
			!Number.isSafeInteger(event.data.index) ||
			event.data.index < 0
		) {
			throw new Error("invalid recorded workflow command");
		}
		const index = event.data.index;
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
			append({ kind: "sleep", index, delayMs: event.data.delayMs, parent });
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
			if (child.kind === "sleep")
				throw new Error("nested sleep lacks completion evidence");
			if (child.active || !child.terminal)
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
