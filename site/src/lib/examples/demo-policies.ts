import type { BudgetPolicy, SparseBudgetPolicy } from "./policy-planner.js";
import { mergeBudgetPolicy } from "./policy-planner.js";

export type DemoPolicyPresetId =
	| "local-only"
	| "cost-first-multi"
	| "active-passive";

export interface DemoPolicyPreset {
	readonly id: DemoPolicyPresetId;
	readonly label: string;
	readonly blurb: string;
	readonly policy: SparseBudgetPolicy;
}

export const DEMO_POLICY_PRESETS: readonly DemoPolicyPreset[] = Object.freeze([
	{
		id: "local-only",
		label: "Local only",
		blurb: "Single local Environment Station · spend cap $0",
		policy: {
			preferLocal: true,
			routing: "local-first",
			redundancy: "none",
			maxReplicas: 1,
			maxConcurrent: 4,
			monthlySpendCapUsd: 0,
			resourcePool: ["local"],
		},
	},
	{
		id: "cost-first-multi",
		label: "Cost-first multi",
		blurb: "Mirror across local yards · cost-first routing",
		policy: {
			preferLocal: true,
			routing: "cost-first",
			redundancy: "mirror",
			maxReplicas: 3,
			maxConcurrent: 4,
			monthlySpendCapUsd: 0,
			resourcePool: ["local", "anonymous-remote"],
		},
	},
	{
		id: "active-passive",
		label: "Active-passive",
		blurb: "Local primary + standby · demo failover intent",
		policy: {
			preferLocal: true,
			routing: "local-first",
			redundancy: "active-passive",
			maxReplicas: 2,
			maxConcurrent: 4,
			monthlySpendCapUsd: 0,
			resourcePool: ["local", "anonymous-remote"],
		},
	},
]);

export function resolveDemoPolicy(presetId: DemoPolicyPresetId): BudgetPolicy {
	const preset = DEMO_POLICY_PRESETS.find((entry) => entry.id === presetId);
	if (!preset) throw new Error(`Unknown demo policy preset: ${presetId}`);
	return mergeBudgetPolicy(preset.policy);
}

export function isDemoPolicyPresetId(value: string): value is DemoPolicyPresetId {
	return DEMO_POLICY_PRESETS.some((preset) => preset.id === value);
}
