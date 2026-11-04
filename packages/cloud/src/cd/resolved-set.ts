/**
 * Gatekeeper-approved, post-Matching resolved Deployment Set (CD plane input).
 * The CD plane never re-renders raw Git/Helm under high privilege.
 */
import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "../json.js";
import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	hashDeploymentPlan,
	type ResourcePlan,
} from "../plan-types.js";

// public-contract: resolved deployment set schema.
export const RESOLVED_SET_SCHEMA = "hobo.resolved-deployment-set/v1" as const;

export type GatekeeperApproval = Readonly<{
	decision: "allow" | "allow-degraded";
	gatekeeperDecisionId: string;
	obligations: readonly string[];
	decidedAt: string;
}>;

export type MatchSelection = Readonly<{
	resource: string;
	providerId: string;
	port: string;
	rationale: string;
}>;

/**
 * Resolved Set: content-addressed plan + Gatekeeper approval + Matching winners.
 * Secret material is forbidden — only references may appear in resource outputs.
 */
export type ResolvedDeploymentSet = Readonly<{
	schemaVersion: typeof RESOLVED_SET_SCHEMA;
	setId: string;
	tenant: string;
	environment: string;
	campId: string;
	/** Content-addressed post-Matching plan DAG. */
	plan: DeploymentPlan;
	planHash: `sha256:${string}`;
	/** Matching selections already decided (not re-selected by CD plane). */
	matches: readonly MatchSelection[];
	/** Gatekeeper-approved — CD plane refuses unapproved sets. */
	gatekeeper: GatekeeperApproval;
	/** Opaque secret references only (never plaintext values). */
	secretRefs: readonly string[];
	/** Progressive policy hints (optional; defaults applied by CD plane). */
	progressive?: Readonly<{
		flag?: string;
		stages?: readonly number[];
		traffic?: "flag-only" | "gateway-weighted";
		autoRollback?: boolean;
	}>;
	contentHash: `sha256:${string}`;
}>;

export function createResolvedDeploymentSet(input: {
	readonly tenant: string;
	readonly environment: string;
	readonly campId: string;
	readonly plan: DeploymentPlan;
	readonly matches: readonly MatchSelection[];
	readonly gatekeeper: GatekeeperApproval;
	readonly secretRefs?: readonly string[];
	readonly progressive?: ResolvedDeploymentSet["progressive"];
	readonly setId?: string;
}): ResolvedDeploymentSet {
	if (
		input.gatekeeper.decision !== "allow" &&
		input.gatekeeper.decision !== "allow-degraded"
	) {
		throw Object.assign(new Error("resolved set requires Gatekeeper allow"), {
			code: "set-not-approved",
		});
	}
	if (input.plan.schema !== DEPLOYMENT_PLAN_SCHEMA) {
		throw Object.assign(new Error("plan schema mismatch"), {
			code: "set-plan-schema",
		});
	}
	const planHash = hashDeploymentPlan(input.plan);
	const setId =
		input.setId ??
		`set_${createHash("sha256").update(planHash).digest("hex").slice(0, 12)}`;
	const body = {
		schemaVersion: RESOLVED_SET_SCHEMA,
		setId,
		tenant: input.tenant,
		environment: input.environment,
		campId: input.campId,
		plan: input.plan,
		planHash,
		matches: input.matches,
		gatekeeper: input.gatekeeper,
		secretRefs: Object.freeze([...(input.secretRefs ?? [])]),
		...(input.progressive !== undefined
			? { progressive: input.progressive }
			: undefined),
	};
	const contentHash =
		`sha256:${createHash("sha256").update(stableStringify(body)).digest("hex")}` as const;
	return Object.freeze({
		...body,
		matches: Object.freeze([...input.matches]),
		secretRefs: Object.freeze([...(input.secretRefs ?? [])]),
		contentHash,
	});
}

/** Resource plan + matching provider for a named resource. */
export function providerForResource(
	set: ResolvedDeploymentSet,
	resourceName: string,
): string {
	const match = set.matches.find((m) => m.resource === resourceName);
	if (match) return match.providerId;
	const planNode = set.plan.resources.find((r) => r.name === resourceName);
	return planNode?.provider ?? "unknown";
}

export function listResources(
	set: ResolvedDeploymentSet,
): readonly ResourcePlan[] {
	return set.plan.resources;
}

// Serializes opaque values for stable digests; callers pass JSON-shaped records.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- hashing boundary accepts any JSON-serializable input
function stableStringify(value: unknown): string {
	if (value === null || !isJsonObject(value)) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	// SAFETY: `const obj = value as JsonObject;` is required at this I/O or test boundary.
	const obj = value as JsonObject;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
