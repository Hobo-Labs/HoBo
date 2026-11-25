import type { ManifestV1 } from "@hobo/bindles";
import type {
	CapabilityProfileRegistry,
	CapabilityRequirement,
	TrustPolicy,
} from "@hobo/capability-profiles";
import {
	BudgetPolicyError,
	canonicalBudgetPolicyJson,
	parseBudgetPolicy,
} from "@hobo/core";
import { type LowerOptions, lowerManifest } from "../intent.js";
import type { JsonBag, JsonObject } from "../json.js";
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
import {
	createHostingPlanningPass,
	type HostingPlanCommitment,
	HostingPlanningError,
	type HostingPlanningInput,
	manifestHostingPolicy,
} from "./hosting-budget.js";
import { matchResource } from "./matching.js";
import { emptyPlacementContext } from "./placement.js";
import {
	matchCapabilityRequirement,
	validateYardBindingOwnership,
	type YardBindingContext,
} from "./profile-matching.js";

export interface PlanBindingAuthority {
	readonly yard: YardBindingContext;
	readonly profiles: CapabilityProfileRegistry;
	readonly definitions: readonly ResourceDefinitionVNext[];
	readonly policy: TrustPolicy;
	readonly nowMs: number;
	readonly requirements: Readonly<Record<string, CapabilityRequirement>>;
	readonly consumableBindingProfiles?: readonly string[];
}

function realizationParametersOf(
	intent: ResourceIntent,
	fromRow: JsonObject | undefined,
): JsonObject | undefined {
	if (intent.cadence === undefined) return fromRow;
	const target = intent.deps.length === 1 ? intent.deps[0] : undefined;
	const result: JsonBag = {
		...fromRow,
		cron: intent.cadence,
	};
	if (target === undefined) delete result.target;
	else result.target = target;
	return result;
}

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
	placement?: Record<string, PlacementCriteria>;
	binding?: PlanBindingAuthority;
	hostingBudget?: HostingPlanningInput;
	unavailableProviders?: readonly string[];
}

export interface PlanSuccess {
	ok: true;
	deploymentId: string;
	decisions: MatchDecided[];
	plan: DeploymentPlan;
	planHash: PlanHash;
	hostingCommitment?: HostingPlanCommitment;
}

export interface PlanRejection {
	ok: false;
	deploymentId: string;
	reason: string;
	remediations: PlanRemediation[];
}

export type PlanResult = PlanSuccess | PlanRejection;

function dependencyOrder(intents: ResourceIntent[]): string[] | undefined {
	const names = new Set(intents.map((i) => i.name));
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const intent of intents) indegree.set(intent.name, 0);

	for (const intent of intents) {
		for (const dep of intent.deps) {
			if (!names.has(dep)) continue;
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
	return order.length === names.size ? order : undefined;
}

export function plan(
	bindle: ManifestV1,
	config: PlanConfig,
	registry: PlannerRegistry,
): PlanResult {
	const unavailable: ReadonlySet<string> = new Set(
		config.unavailableProviders ?? [],
	);
	let authored: ReturnType<typeof manifestHostingPolicy>;
	let pinnedPolicy: ReturnType<typeof parseBudgetPolicy> | undefined;
	try {
		authored = manifestHostingPolicy(bindle);
		pinnedPolicy =
			config.hostingBudget?.budgetPolicy === undefined
				? undefined
				: parseBudgetPolicy(config.hostingBudget.budgetPolicy);
	} catch (error) {
		if (
			!(error instanceof HostingPlanningError) &&
			!(error instanceof BudgetPolicyError)
		)
			throw error;
		return rejectFinancialEvidence(config.deploymentId, error);
	}
	const objective =
		config.objective ??
		authored.budgetPolicy?.objective ??
		pinnedPolicy?.objective ??
		"min-cost";
	const lowerOptions: LowerOptions = { objective };
	if (config.region !== undefined) lowerOptions.region = config.region;
	const intents = lowerManifest(bindle, lowerOptions);
	if (config.binding) {
		const failures = validateYardBindingOwnership(
			config.binding.yard,
			config.binding.definitions,
		);
		if (failures.length)
			return {
				ok: false,
				deploymentId: config.deploymentId,
				reason: "plan rejected: Yard products must belong to its provider",
				remediations: failures.map(({ profile, rejection }) => ({
					resource: "*",
					code: rejection.code,
					requiredPort: profile,
					requiredFeatures: [],
					missing: [rejection.code],
					remediation: rejection.detail,
				})),
			};
	}
	const order = dependencyOrder(intents);
	if (!order)
		return {
			ok: false,
			deploymentId: config.deploymentId,
			reason: "plan rejected: resource dependencies contain a cycle",
			remediations: [
				{
					resource: "*",
					code: "dependency.cycle",
					requiredPort: "*",
					requiredFeatures: [],
					missing: [],
					remediation:
						"Remove the circular dependency so every resource can be provisioned after its dependencies.",
				},
			],
		};
	if (config.placement !== undefined) {
		for (const intent of intents) {
			const criteria = config.placement[intent.name];
			if (criteria !== undefined) intent.placement = criteria;
		}
	}

	const decisions: MatchDecided[] = [];
	const resources: ResourcePlan[] = [];
	const remediations: PlanRemediation[] = [];
	const placementContext = emptyPlacementContext();
	let hosting: ReturnType<typeof createHostingPlanningPass> | undefined;
	try {
		if (authored.required && !config.hostingBudget)
			throw new HostingPlanningError(
				"manifest declares financial policy but no authoritative hosting budget evidence was supplied",
			);
		if (config.hostingBudget) {
			if (
				authored.budgetPolicy &&
				(pinnedPolicy === undefined ||
					canonicalBudgetPolicyJson(authored.budgetPolicy) !==
						canonicalBudgetPolicyJson(pinnedPolicy))
			)
				throw new HostingPlanningError(
					"trusted financial evidence does not pin the authored shared budget policy",
				);
			const policy = authored.budgetPolicy ?? pinnedPolicy;
			if (
				policy &&
				(objective === "cost" ? "min-cost" : objective) !== policy.objective
			)
				throw new HostingPlanningError(
					"requested objective conflicts with the shared budget policy",
				);
			if (
				authored.hardLimitMicros !== undefined &&
				(config.hostingBudget.budget.currency !== "USD" ||
					config.hostingBudget.budget.capMicros > authored.hardLimitMicros)
			)
				throw new HostingPlanningError(
					"resolved budget widens the authored hard ceiling",
				);
			if (
				authored.period !== undefined &&
				config.hostingBudget.budget.periodKind !== authored.period
			)
				throw new HostingPlanningError(
					"resolved budget does not attest the authored accounting period",
				);
			hosting = createHostingPlanningPass(config.hostingBudget);
		}
	} catch (error) {
		if (
			!(error instanceof HostingPlanningError) &&
			!(error instanceof BudgetPolicyError)
		)
			throw error;
		return rejectFinancialEvidence(config.deploymentId, error);
	}

	for (const intent of intents) {
		const requirement = config.binding?.requirements[intent.name];
		let bound: BoundOffering | undefined;
		let approvedDefinition: { id: string; providerId: string } | undefined;
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
			approvedDefinition = profileOutcome.definition;
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
		const matchingRegistry: PlannerRegistry =
			config.binding || approvedDefinition
				? {
						catalogHash: registry.catalogHash,
						definitions: () =>
							registry
								.definitions()
								.filter(
									(definition) =>
										(!config.binding ||
											definition.providerId ===
												config.binding.yard.providerId) &&
										(!approvedDefinition ||
											(definition.id === approvedDefinition.id &&
												definition.providerId ===
													approvedDefinition.providerId)),
								),
						providers: () => registry.providers(),
						...(registry.held
							? { held: () => registry.held?.() ?? [] }
							: undefined),
					}
				: registry;
		const outcome = matchResource(
			intent,
			matchingRegistry,
			placementContext,
			hosting,
			unavailable,
		);
		if (!outcome.ok) {
			remediations.push(outcome.remediation);
			continue;
		}
		if (!bound && outcome.definition.productId)
			bound = { productId: outcome.definition.productId };
		if (hosting) hosting.commit(intent.name, outcome.definition);

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
			...(bound?.productId !== undefined
				? { productId: bound.productId }
				: undefined),
			...(realizationParametersOf(intent, bound?.realizationParameters) !==
			undefined
				? {
						realizationParameters: realizationParametersOf(
							intent,
							bound?.realizationParameters,
						),
					}
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
	if (
		hosting &&
		authored.spendCapMicros !== undefined &&
		hosting.commitment().reservedMicros > authored.spendCapMicros
	)
		return {
			ok: false,
			deploymentId: config.deploymentId,
			reason: "plan exceeds authored spend cap",
			remediations: [
				{
					resource: "*",
					code: "budget.spend-cap-exceeded",
					requiredPort: "*",
					requiredFeatures: [],
					missing: [],
					remediation:
						"whole-plan bounded exposure exceeds the authored per-action spend cap",
				},
			],
		};

	const deploymentPlan: DeploymentPlan = {
		schema: DEPLOYMENT_PLAN_SCHEMA,
		resources: resources.sort((a, b) => a.name.localeCompare(b.name)),
		dependencyOrder: order,
		objective,
	};

	const result: PlanSuccess = {
		ok: true,
		deploymentId: config.deploymentId,
		decisions,
		plan: deploymentPlan,
		planHash: hashDeploymentPlan(deploymentPlan),
	};
	if (hosting) result.hostingCommitment = hosting.commitment();
	return result;
}

function rejectFinancialEvidence(
	deploymentId: string,
	error: HostingPlanningError | BudgetPolicyError,
): PlanRejection {
	return {
		ok: false,
		deploymentId,
		reason: error.message,
		remediations: [
			{
				resource: "*",
				code: error.code,
				requiredPort: "*",
				requiredFeatures: [],
				missing: [],
				remediation: error.message,
			},
		],
	};
}
