import { isNonEmptyPrimitiveString } from "../workflow-value.js";
import type { EventEnvelope } from "./types.js";

const RUNTIME_EVENT_TYPES = new Set([
	"run.Started",
	"run.Completed",
	"run.Failed",
	"run.StepScheduled",
	"run.StepCompleted",
	"run.StepFailed",
	"run.SleepScheduled",
	"run.SleepDeadlineSet",
	"run.SleepCompleted",
	"run.HookResumed",
]);

export function validateJournalHistory(
	events: readonly EventEnvelope[],
	runId = "workflow",
): void {
	let terminal = false;
	for (const [index, event] of events.entries()) {
		if (!Number.isSafeInteger(event.seq) || event.seq !== index + 1)
			throw new Error(
				"workflow journal sequence must be contiguous safe integers starting at one",
			);
		if (!isNonEmptyPrimitiveString(event.type))
			throw new Error("workflow journal event type must be a non-empty string");
		if (index === 0 && event.type !== "run.Started")
			throw new Error("workflow journal must begin with run.Started");
		if (index > 0 && event.type === "run.Started")
			throw new Error(`duplicate run.Started in workflow journal for ${runId}`);
		if (event.type.startsWith("run.") && !RUNTIME_EVENT_TYPES.has(event.type))
			throw new Error("unknown reserved workflow journal event type");
		const isTerminal =
			event.type === "run.Completed" || event.type === "run.Failed";
		if (terminal)
			throw new Error(
				isTerminal
					? `duplicate terminal facts for ${runId}`
					: `events after terminal for ${runId}`,
			);
		if (isTerminal) terminal = true;
	}
}
