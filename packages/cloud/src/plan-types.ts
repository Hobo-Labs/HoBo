import { createHash } from "node:crypto";

// Parse, don't validate: the types below are the parsed derived domain types the
// Planner works with. Their protobuf wire forms live in data-models/cloud.proto
// and their CUE constraints in data-models/cloud.cue; these narrow those wire
// shapes with unions and required fields. Constructors here are the only way to
// build a plan value, so downstream code never re-validates a raw record.

// The plan schema discriminant, re-exported from the package that owns the
// plan shape. It is hashed into every plan digest, so two declarations of it
// would be two ways to change what the repo content-addresses; unlike the plan
// *types* below, a bare string constant re-exports without friction, so there
// is no reason for this one to be declared twice.
//
// `pnpm run standards:check` had never flagged the local declaration this
// replaces, because the check runs over added and modified files only. The
// constant has been exported without a `// public-contract:` marker since it
// was written; touching this file is what surfaced it.
import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlanAuthoring as DeploymentPlan,
} from "@hobo/manifest-plan";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

// ── The declaration manifest, re-exported from its owner ────────────────────
//
// `ResourceIntent` and the placement vocabulary were declared here. They are
// now `@hobo/manifest-declaration`'s, and re-exported so every consumer keeps
// its import path. The types re-exported are the **authoring** ones: mutable,
// unbranded, field-for-field what this file declared, because the Planner and
// `src/intent.ts` build intents with object literals and assign `intent.region`
// after construction — neither a brand nor a `readonly` admits that.
// `ParsedResourceIntent` is the branded refinement, obtainable only from
// `parseResourceIntent`; it is exported alongside rather than instead.
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

// Canonical shape per control-plane-event-schema-contract (ADR-0033/ADR-0088):
// full ranking, structured rejections with reasons, an explicit tie flag, and
// the catalog content-hash. `rejected`/`catalogHash` remain populated as
// deprecated aliases for one release.
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
	/** Full ranking, winner first (ADR-0088 attribution). */
	ranking: RankedCandidate[];
	/** True when the winner beat the runner-up only on the definition-id tiebreak. */
	tie: boolean;
	objective: string;
	region?: string;
	rationale: string;
	/** @deprecated alias of `catalogContentHash`. */
	catalogHash: string;
	catalogContentHash: string;
	/**
	 * The provider offering the winner realizes, when Yard binding authority
	 * constrained the decision (ADR-0157). Recorded on the decision so the
	 * audit trail names *what was chosen to be built*, not only which
	 * definition won — a definition id is not a product.
	 */
	productId?: string;
	/** Canonical keys of the Yard binding rows that constrained this decision. */
	appliedRows?: readonly string[];
	/** Provider-native realization parameters merged from the applied rows. */
	realizationParameters?: Readonly<JsonObject>;
	/** Applied rows that contributed realization parameters (portability attribution). */
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
	// SAFETY: everything that is not an array or object here is a JSON scalar by
	// the time a plan reaches serialization; the walk above has handled the two
	// container cases.
	return value as JsonValue;
}

// Canonical, key-sorted serialization — the byte-stable form a plan is
// content-addressed by (control-plane.md: "The plan is content-addressed and
// stored via deployment.Planned").
export function canonicalPlanJson(plan: DeploymentPlan): string {
	return JSON.stringify(sortKeys(plan));
}

export function hashDeploymentPlan(plan: DeploymentPlan): PlanHash {
	const digest = createHash("sha256")
		.update(canonicalPlanJson(plan))
		.digest("hex");
	return `sha256:${digest}`;
}
