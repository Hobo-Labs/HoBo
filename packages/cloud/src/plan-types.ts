import { createHash } from "node:crypto";

import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlanAuthoring as DeploymentPlan,
} from "@hobo/manifest-plan";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

export {
	type Negotiation,
	type ParsedPlacementAffinityRule,
	type ParsedPlacementCriteria,
	type ParsedPlacementPickN,
	type ParsedPlacementPropertySelector,
	type ParsedPlacementSpread,
	type ParsedResourceIntent,
	type PlacementAffinityMode,
	type PlacementAffinityRule,
	type PlacementCriteria,
	type PlacementPickN,
	type PlacementPropertySelector,
	type PlacementScope,
	type PlacementSelectorOp,
	type PlacementSpread,
	parseResourceIntent,
	type ResourceIntent,
	ResourceIntentError,
	toResourceIntent,
} from "@hobo/manifest-declaration";
export { DEPLOYMENT_PLAN_SCHEMA };

export type CapabilityVerdict =
	| { kind: "full" }
	| { kind: "partial"; missing: string[] }
	| { kind: "none" };

export type {
	DeploymentPlanAuthoring as DeploymentPlan,
	ResourcePlanAuthoring as ResourcePlan,
} from "@hobo/manifest-plan";

export interface RankedCandidate {
	definitionId: string;
	providerId: string;
	specificity: number;
	priority: number;
}

export interface RejectedCandidate {
	definitionId: string;
	reason: string;
}

export interface MatchDecided {
	deploymentId: string;
	resource: string;
	winner: string;
	providerId: string;
	port: string;
	specificity: number;
	/** @deprecated */
	rejected: string[];
	rejectedCandidates: RejectedCandidate[];
	ranking: RankedCandidate[];
	tie: boolean;
	objective: string;
	region?: string;
	rationale: string;
	/** @deprecated */
	catalogHash: string;
	catalogContentHash: string;
	productId?: string;
	appliedRows?: readonly string[];
	realizationParameters?: Readonly<JsonObject>;
	nonPortableRows?: readonly string[];
}

export interface PlanRemediation {
	resource: string;
	code: string;
	requiredPort: string;
	requiredFeatures: string[];
	missing: string[];
	suggestedProvider?: string;
	remediation: string;
}

export type PlanHash = `sha256:${string}`;

function sortKeys(value: JsonValue | DeploymentPlan): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && isJsonObject(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortKeys(value[key])]),
		);
	}
	return value as JsonValue;
}

export function canonicalPlanJson(plan: DeploymentPlan): string {
	return JSON.stringify(sortKeys(plan));
}

export function hashDeploymentPlan(plan: DeploymentPlan): PlanHash {
	const digest = createHash("sha256")
		.update(canonicalPlanJson(plan))
		.digest("hex");
	return `sha256:${digest}`;
}
