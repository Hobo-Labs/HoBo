import { isNonEmptyPrimitiveString } from "../workflow-boundary.js";
import type { EventEnvelope } from "./types.js";

/** Validate the visible prefix before trusting it for execution or replay. */
export function validateJournalHistory(events: readonly EventEnvelope[]): void {
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
			throw new Error("workflow journal contains a duplicate run.Started");
		if (terminal)
			throw new Error("workflow journal record after terminal outcome");
		if (event.type === "run.Completed" || event.type === "run.Failed")
			terminal = true;
	}
}

/** Version three reserves run.* for the runtime's known command records. */
export function validateCurrentJournalTypes(
	events: readonly EventEnvelope[],
): void {
	const runtimeTypes = new Set([
		"run.Started",
		"run.Completed",
		"run.Failed",
		"run.StepScheduled",
		"run.StepCompleted",
		"run.StepFailed",
		"run.SleepScheduled",
		"run.SleepCompleted",
	]);
	for (const event of events) {
		if (event.type.startsWith("run.") && !runtimeTypes.has(event.type))
			throw new Error("unknown reserved workflow journal event type");
	}
}
