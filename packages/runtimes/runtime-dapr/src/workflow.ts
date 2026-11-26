/**
 * Supported Dapr workflow surface: deterministic activity-name mapping only.
 *
 * Permanent non-goal (not an open residual): full Dapr workflow engine parity
 * (durable timers, external events, multi-app orchestration). HoBo workflows
 * remain canonical on `hobo:workflow` / native runtime; this map exists so a
 * Camp that already runs Dapr workflows can name-align activities.
 */

import type { DaprWorkflowStepMap } from "./types.js";

export interface HoboWorkflowLike {
	readonly name: string;
	readonly steps: readonly { readonly name: string }[];
}

export interface DaprWorkflowMapping {
	readonly workflowName: string;
	readonly activities: readonly DaprWorkflowStepMap[];
	readonly backend: "dapr-workflow";
	/** Supported surface is activity-name mapping only — not full engine parity. */
	readonly parity: "activity-map-only";
	readonly fullEngineParity: false;
}

export function mapWorkflowToDapr(
	workflow: HoboWorkflowLike,
): DaprWorkflowMapping {
	return Object.freeze({
		workflowName: workflow.name,
		activities: workflow.steps.map((step) =>
			Object.freeze({
				hoboStep: step.name,
				daprActivity: `${workflow.name}.${step.name}`,
			}),
		),
		backend: "dapr-workflow" as const,
		parity: "activity-map-only" as const,
		fullEngineParity: false as const,
	});
}
