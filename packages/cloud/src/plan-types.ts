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

// domain-view: capability-negotiation verdict; wire form is CapabilityVerdict in data-models/cloud.proto.
export type CapabilityVerdict =
	| { kind: "full" }
	| { kind: "partial"; missing: string[] }
	| { kind: "none" };

export type {
	DeploymentPlanAuthoring as DeploymentPlan,
	ResourcePlanAuthoring as ResourcePlan,
} from "@hobo/manifest-plan";

// domain-view: ranked candidate inside match.Decided; wire form is RankedCandidate in data-models/cloud.proto.
export interface RankedCandidate {
	definitionId: string;
	providerId: string;
	specificity: number;
	priority: number;
}

// domain-view: structured rejection inside match.Decided; wire form is RejectedCandidate in data-models/cloud.proto.
export interface RejectedCandidate {
	definitionId: string;
	reason: string;
}

// domain-view: match.Decided body; wire form is MatchDecided in data-models/cloud.proto.
export interface MatchDecided {
	deploymentId: string;
	resource: string;
	winner: string;
	providerId: string;
	port: string;
	specificity: number;
	/** @deprecated flat ids; read `rejectedCandidates` (reasons included). */
	rejected: string[];
	rejectedCandidates: RejectedCandidate[];
	ranking: RankedCandidate[];
	tie: boolean;
	objective: string;
	region?: string;
	rationale: string;
	/** @deprecated alias of `catalogContentHash`. */
	catalogHash: string;
	catalogContentHash: string;
	productId?: string;
	appliedRows?: readonly string[];
	realizationParameters?: Readonly<JsonObject>;
	nonPortableRows?: readonly string[];
}

// domain-view: rejection remediation; wire form is PlanRemediation in data-models/cloud.proto.
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
