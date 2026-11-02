import type { ManifestV1 } from "@hobo/bindles";
import type {
	CapabilityProfileRegistry,
	CapabilityRequirement,
	TrustPolicy,
} from "@hobo/capability-profiles";
import { lowerManifest, type LowerOptions } from "../intent.js";
import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	hashDeploymentPlan,
	type MatchDecided,
	type PlacementCriteria,
	type PlanHash,
	type PlanRemediation,
	type ResourceIntent,
	type ResourcePlan,
} from "../plan-types.js";
import type { PlannerRegistry } from "../registry/catalog.js";
import type { ResourceDefinitionVNext } from "../registry/resource-definition-vnext.js";
import { matchResource } from "./matching.js";
import { emptyPlacementContext } from "./placement.js";
import {
	matchCapabilityRequirement,
	type YardBindingContext,
} from "./profile-matching.js";
import { type JsonObject } from "../json.js";


// The Planner: a pure function `plan(bindle, config, registry) -> DeploymentPlan`
// (control-plane.md "The Planner"). Easy to test, replayable, deterministic. It
// never provisions anything — it emits the content-addressed plan (or a precise,
// machine-readable rejection) and the per-resource match.Decided decisions.

/**
 * Yard binding authority for a planning pass (ADR-0157).
 *
 * Supplying this promotes planning from the legacy port-only path onto the
 * ADR-0151 capability-profile pipeline for the resources it covers: the Yard's
 * rows hard-filter which offering may satisfy each profile, and the winning
 * product plus its Yard-scoped realization parameters land on the plan so a
 * deployment driver can act on them. Without it the planner behaves exactly as
 * before and plan nodes carry no `productId` — which a driver must read as
 * "not decided here", never "any product will do".
 *
 * This is opt-in on purpose. Turning it on changes which offering a resource
 * resolves to, so it is a decision an operator makes rather than a default
 * that shifts under them.
 */
export interface PlanBindingAuthority {
	/** The Yard whose rows constrain this pass, and the rows themselves. */
	readonly yard: YardBindingContext;
	/** The capability-profile registry the required profiles resolve against. */
	readonly profiles: CapabilityProfileRegistry;
	/** Profile-bearing definitions; legacy port-only definitions are ignored. */
	readonly definitions: readonly ResourceDefinitionVNext[];
	readonly policy: TrustPolicy;
	/**
	 * Canonical evaluation instant. Planning never reads a clock itself, so the
	 * caller supplies it and two passes over the same inputs are byte-stable.
	 */
	readonly nowMs: number;
	/**
	 * Per-resource capability requirements, keyed by resource name. A resource
	 * with no entry keeps the legacy port-only decision — absent means "this
	 * pass says nothing about that resource", not "it has no requirements".
	 */
	readonly requirements: Readonly<Record<string, CapabilityRequirement>>;
	readonly consumableBindingProfiles?: readonly string[];
}

/** What a Yard-bound match contributes to both the decision and the plan node. */
type BoundOffering = {
	readonly productId?: string;
	readonly appliedRows?: readonly string[];
	readonly realizationParameters?: Readonly<JsonObject>;
	readonly nonPortableRows?: readonly string[];
};

export interface PlanConfig {
	deploymentId: string;
	objective?: string;
	region?: string;
	// E19: per-resource placement-constraint criteria, keyed by resource name.
	// Attached to the lowered intents so the bindle manifest stays untouched.
	placement?: Record<string, PlacementCriteria>;
	/**
	 * Optional Yard binding authority. See `PlanBindingAuthority` — absent keeps
	 * the pre-existing port-only behaviour byte-for-byte.
	 */
	binding?: PlanBindingAuthority;
}

export interface PlanSuccess {
	ok: true;
	deploymentId: string;
	decisions: MatchDecided[];
	plan: DeploymentPlan;
	planHash: PlanHash;
}

export interface PlanRejection {
	ok: false;
	deploymentId: string;
	reason: string;
	remediations: PlanRemediation[];
}

export type PlanResult = PlanSuccess | PlanRejection;

// Stable topological order over the bind-edge DAG (Kahn's algorithm with an
// alphabetical tiebreak, so the dependency order is byte-stable).
function dependencyOrder(intents: ResourceIntent[]): string[] {
	const names = new Set(intents.map((i) => i.name));
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const intent of intents) indegree.set(intent.name, 0);

	for (const intent of intents) {
		for (const dep of intent.deps) {
			if (!names.has(dep)) continue;
			// edge dep -> intent (dependency provisioned before dependent)
			indegree.set(intent.name, (indegree.get(intent.name) ?? 0) + 1);
			dependents.set(dep, [...(dependents.get(dep) ?? []), intent.name]);
		}
	}

	const ready = [...indegree.entries()]
		.filter(([, deg]) => deg === 0)
		.map(([name]) => name)
		.sort();
	const order: string[] = [];
	while (ready.length > 0) {
		// SAFETY: `const next = ready.shift() as string;` is required at this I/O or test boundary.
		const next = ready.shift() as string;
		order.push(next);
		for (const child of (dependents.get(next) ?? []).sort()) {
			const deg = (indegree.get(child) ?? 0) - 1;
			indegree.set(child, deg);
			if (deg === 0) {
				ready.push(child);
				ready.sort();
			}
		}
	}
	// A cycle would leave nodes unordered; append any stragglers deterministically.
	for (const name of [...names].sort()) {
		if (!order.includes(name)) order.push(name);
	}
	return order;
}

export function plan(
	bindle: ManifestV1,
	config: PlanConfig,
	registry: PlannerRegistry,
): PlanResult {
	const objective = config.objective ?? "min-cost";
	const lowerOptions: LowerOptions = { objective };
	if (config.region !== undefined) lowerOptions.region = config.region;
	const intents = lowerManifest(bindle, lowerOptions);
	// E19: attach per-resource placement criteria to the lowered intents.
	if (config.placement !== undefined) {
		for (const intent of intents) {
			const criteria = config.placement[intent.name];
			if (criteria !== undefined) intent.placement = criteria;
		}
	}

	const decisions: MatchDecided[] = [];
	const resources: ResourcePlan[] = [];
	const remediations: PlanRemediation[] = [];
	// Placements decided so far this pass — affinity/anti-affinity/spread rules
	// evaluate against it; deterministic because intents arrive in the
	// byte-stable lowered (sorted-name) order.
	const placementContext = emptyPlacementContext();

	for (const intent of intents) {
		const outcome = matchResource(intent, registry, placementContext);
		if (!outcome.ok) {
			remediations.push(outcome.remediation);
			continue;
		}
		// Yard binding authority, when supplied for this resource: the rows
		// hard-filter the offering and carry the realization parameters. A row
		// set that admits nothing is a refusal, not a fall-through to the
		// port-only winner — otherwise the Yard's authority would be advisory,
		// and a Yard that cannot satisfy a capability would silently deploy
		// something it never declared.
		const requirement = config.binding?.requirements[intent.name];
		let bound: BoundOffering | undefined;
		if (config.binding !== undefined && requirement !== undefined) {
			const authority = config.binding;
			const profileOutcome = matchCapabilityRequirement({
				resourceName: intent.name,
				requirement,
				profiles: authority.profiles,
				definitions: authority.definitions,
				policy: authority.policy,
				nowMs: authority.nowMs,
				yard: authority.yard,
				...(authority.consumableBindingProfiles !== undefined
					? {
							consumableBindingProfiles: authority.consumableBindingProfiles,
						}
					: undefined),
			});
			if (!profileOutcome.ok) {
				remediations.push(profileOutcome.remediation);
				continue;
			}
			bound = {
				...(profileOutcome.definition.semantics?.productId !== undefined
					? { productId: profileOutcome.definition.semantics.productId }
					: undefined),
				...(profileOutcome.appliedRows !== undefined
					? { appliedRows: profileOutcome.appliedRows }
					: undefined),
				...(profileOutcome.realizationParameters !== undefined
					? { realizationParameters: profileOutcome.realizationParameters }
					: undefined),
				...(profileOutcome.nonPortableRows !== undefined
					? { nonPortableRows: profileOutcome.nonPortableRows }
					: undefined),
			};
		}

		const decision = {
			...outcome.decision,
			deploymentId: config.deploymentId,
			...bound,
		};
		decisions.push(decision);
		placementContext.placements.push({
			resource: intent.name,
			port: intent.port,
			providerId: decision.providerId,
			region: outcome.region,
		});
		const node: ResourcePlan = {
			name: intent.name,
			port: intent.port,
			provider: decision.providerId,
			deps: intent.deps,
			strategy: "rolling-update",
			// `appliedRows` stays on the decision (the audit trail) and off the
			// plan node: the plan is content-addressed, and which rows were
			// consulted does not change what gets built.
			...(bound?.productId !== undefined ? { productId: bound.productId } : undefined),
			...(bound?.realizationParameters !== undefined
				? { realizationParameters: bound.realizationParameters }
				: undefined),
			...(bound?.nonPortableRows !== undefined
				? { nonPortableRows: bound.nonPortableRows }
				: undefined),
		};
		if (outcome.region) node.region = outcome.region;
		resources.push(node);
	}

	if (remediations.length > 0) {
		return {
			ok: false,
			deploymentId: config.deploymentId,
			reason: `plan rejected: ${remediations.length} resource(s) could not be satisfied`,
			remediations,
		};
	}

	const deploymentPlan: DeploymentPlan = {
		schema: DEPLOYMENT_PLAN_SCHEMA,
		resources: resources.sort((a, b) => a.name.localeCompare(b.name)),
		dependencyOrder: dependencyOrder(intents),
		objective,
	};

	return {
		ok: true,
		deploymentId: config.deploymentId,
		decisions,
		plan: deploymentPlan,
		planHash: hashDeploymentPlan(deploymentPlan),
	};
}
