export type Redundancy =
	| "none"
	| "active-passive"
	| "active-active"
	| "mirror";

export type ResourceClass = "local" | "anonymous-remote" | "paid-remote";

export type RoutingPolicy = "local-first" | "latency-first" | "cost-first";

export interface BudgetPolicy {
	readonly preferLocal: boolean;
	readonly routing: RoutingPolicy;
	readonly redundancy: Redundancy;
	readonly maxReplicas: number;
	readonly maxConcurrent: number;
	readonly monthlySpendCapUsd: number;
	readonly resourcePool: readonly ResourceClass[];
}

export type SparseBudgetPolicy = Partial<BudgetPolicy>;

/** Writable sparse policy used while parsing untrusted JSON field-by-field. */
export type MutableSparseBudgetPolicy = {
	preferLocal?: boolean;
	routing?: RoutingPolicy;
	redundancy?: Redundancy;
	maxReplicas?: number;
	maxConcurrent?: number;
	monthlySpendCapUsd?: number;
	resourcePool?: ResourceClass[];
};

export interface StationTarget {
	/** Deployable target id shown in the Home Station. */
	readonly id: string;
	/** One provider-specific Yard owned by the Environment Station. */
	readonly yardId: string;
	readonly providerId: string;
	readonly resourceClass: ResourceClass;
	readonly canHostNow: boolean;
	readonly unavailableReason?: string;
	readonly estimatedMonthlySpendUsd: number;
}

export type DeploymentRole = "primary" | "standby" | "replica";

export interface ProvisionedTarget {
	readonly target: StationTarget;
	readonly role: DeploymentRole;
}

export type SkipReason =
	| "yard-blocked"
	| "not-in-resource-pool"
	| "spend-cap"
	| "cannot-host"
	| "over-replica-budget";

export interface SkippedTarget {
	readonly target: StationTarget;
	readonly reason: SkipReason;
	readonly detail: string;
}

export interface JunctionComposition {
	readonly yardIds: readonly string[];
	readonly routing: string;
}

export interface DeployPlan {
	readonly policy: BudgetPolicy;
	readonly provision: readonly ProvisionedTarget[];
	readonly skipped: readonly SkippedTarget[];
	readonly replicas: number;
	readonly summary: string;
	/** A Junction composes multiple provider-specific Yards; one host needs none. */
	readonly junction: JunctionComposition | null;
}

export const DEFAULT_BUDGET_POLICY: Readonly<BudgetPolicy> = Object.freeze({
	preferLocal: true,
	routing: "local-first",
	redundancy: "none",
	maxReplicas: 1,
	maxConcurrent: 4,
	monthlySpendCapUsd: 0,
	resourcePool: Object.freeze<readonly ResourceClass[]>([
		"local",
		"anonymous-remote",
	]),
});

/** Merge only authored keys: defaults -> app -> deployment. */
export function mergeBudgetPolicy(
	appPolicy: SparseBudgetPolicy = {},
	deploymentPolicy: SparseBudgetPolicy = {},
): BudgetPolicy {
	const merged = {
		...DEFAULT_BUDGET_POLICY,
		...appPolicy,
		...deploymentPolicy,
	};
	return {
		...merged,
		maxReplicas:
			deploymentPolicy.maxReplicas ??
			appPolicy.maxReplicas ??
			defaultReplicas(merged.redundancy),
	};
}

export function resolveDeployPlan(
	candidates: readonly StationTarget[],
	policy: BudgetPolicy,
	allowedYardIds: readonly string[] | null = null,
): DeployPlan {
	assertPlanInput(candidates, policy);
	const allowed = allowedYardIds ? new Set(allowedYardIds) : null;
	const yardBlocked = allowed
		? candidates
				.filter((target) => !allowed.has(target.yardId))
				.map((target) => ({
					target,
					reason: "yard-blocked" as const,
					detail: "target is not in this deployment's Yard allow-list",
				}))
			: [];
	const resourcePool = new Set(policy.resourcePool);
	const eligible: StationTarget[] = [];
	const policySkipped: SkippedTarget[] = [];
	for (const target of candidates) {
		if (allowed && !allowed.has(target.yardId)) continue;
		if (!resourcePool.has(target.resourceClass)) {
			policySkipped.push({
				target,
				reason: "not-in-resource-pool",
				detail: `${target.resourceClass} is not in resourcePool`,
			});
			continue;
		}
		if (!target.canHostNow) {
			policySkipped.push({
				target,
				reason: "cannot-host",
				detail: target.unavailableReason ?? "target cannot host this app now",
			});
			continue;
		}
		eligible.push(target);
	}
	const ranked = rankTargets(
		eligible,
		policy,
	);
	const withinSpendCap: StationTarget[] = [];
	let estimatedSpend = 0;
	for (const target of ranked) {
		const nextSpend = estimatedSpend + target.estimatedMonthlySpendUsd;
		if (target.resourceClass === "paid-remote" && nextSpend > policy.monthlySpendCapUsd) {
			policySkipped.push({
				target,
				reason: "spend-cap",
				detail: `cumulative estimate $${nextSpend}/month exceeds $${policy.monthlySpendCapUsd} cap`,
			});
			continue;
		}
		estimatedSpend = nextSpend;
		withinSpendCap.push(target);
	}
	const replicaLimit = effectiveReplicaLimit(policy);
	const provision = withinSpendCap.slice(0, replicaLimit).map((target, index) => ({
		target,
		role: roleFor(policy.redundancy, index),
	}));
	const skipped = [
		...yardBlocked,
		...policySkipped,
		...withinSpendCap.slice(replicaLimit).map((target) => ({
			target,
			reason: "over-replica-budget" as const,
			detail: `over replica budget (redundancy=${policy.redundancy}, maxReplicas=${replicaLimit})`,
		})),
	]
		.sort((left, right) => compareText(left.target.id, right.target.id));
	const junction =
		provision.length > 1
			? {
					yardIds: provision.map(({ target }) => target.yardId),
					routing: describeRoutingParts(provision, policy.routing),
				}
			: null;

	return {
		policy,
		provision,
		skipped,
		replicas: provision.length,
		summary: `redundancy=${policy.redundancy} → ${describeProvision(provision)}`,
		junction,
	};
}

export function describeRouting(
	plan: Pick<DeployPlan, "policy" | "provision">,
): string {
	return describeRoutingParts(plan.provision, plan.policy.routing);
}

function rankTargets(
	candidates: readonly StationTarget[],
	policy: BudgetPolicy,
): StationTarget[] {
	const ranked = [...candidates].sort((left, right) => {
		const leftRank = targetRank(left, policy.preferLocal);
		const rightRank = targetRank(right, policy.preferLocal);
		return leftRank - rightRank || compareText(left.id, right.id);
	});
	if (policy.redundancy !== "active-passive" || !policy.preferLocal) {
		return ranked;
	}
	const primary = ranked.find(
		(target) => target.resourceClass === "local",
	);
	if (!primary) return ranked;
	return [
		primary,
		...ranked.filter(
			(target) =>
				target !== primary && target.resourceClass !== "local",
		),
		...ranked.filter(
			(target) => target !== primary && target.resourceClass === "local",
		),
	];
}

function targetRank(target: StationTarget, preferLocal: boolean): number {
	if (target.id === "browser-wasm" && preferLocal) return 0;
	if (target.id === "webernetes" && preferLocal) return 1;
	if (target.resourceClass === "local") return preferLocal ? 2 : 3;
	return preferLocal ? 3 : 0;
}

function roleFor(redundancy: Redundancy, index: number): DeploymentRole {
	if (index === 0) return "primary";
	return redundancy === "active-passive" ? "standby" : "replica";
}

function effectiveReplicaLimit(policy: BudgetPolicy): number {
	if (policy.redundancy === "none") return Math.min(policy.maxReplicas, 1);
	if (policy.redundancy === "active-passive") {
		return Math.min(policy.maxReplicas, 2);
	}
	return policy.maxReplicas;
}

function defaultReplicas(redundancy: Redundancy): number {
	if (redundancy === "none") return 1;
	if (redundancy === "mirror") return 3;
	return 2;
}

function describeRoutingParts(
	provision: readonly ProvisionedTarget[],
	routing: RoutingPolicy,
): string {
	if (provision.length === 0) return `${routing} · no live yards`;
	if (provision.length === 1) {
		return `${routing} · single-host · ${provision[0]!.target.id}`;
	}
	return `${routing} · ${provision
		.map(({ target, role }) => `${role}=${target.id}`)
		.join(" · ")}`;
}

function describeProvision(provision: readonly ProvisionedTarget[]): string {
	if (provision.length === 0) return "provision 0 hosts";
	if (provision.length === 1) {
		const { target, role } = provision[0]!;
		return `provision 1 ${role} host → ${target.id}`;
	}
	return `provision ${provision.length} hosts → ${provision
		.map(({ target, role }) => `${target.id} ${role}`)
		.join(" + ")}`;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlanInput(
	candidates: readonly StationTarget[],
	policy: BudgetPolicy,
): void {
	if (!Number.isInteger(policy.maxReplicas) || policy.maxReplicas < 0) {
		throw new RangeError("maxReplicas must be a non-negative integer");
	}
	if (!Number.isInteger(policy.maxConcurrent) || policy.maxConcurrent < 1) {
		throw new RangeError("maxConcurrent must be a positive integer");
	}
	if (
		!Number.isFinite(policy.monthlySpendCapUsd) ||
		policy.monthlySpendCapUsd < 0
	) {
		throw new RangeError("monthlySpendCapUsd must be finite and non-negative");
	}
	const ids = new Set<string>();
	const yardIds = new Set<string>();
	for (const target of candidates) {
		if (ids.has(target.id)) throw new TypeError(`duplicate target id: ${target.id}`);
		if (yardIds.has(target.yardId)) {
			throw new TypeError(`duplicate Yard id: ${target.yardId}`);
		}
		if (
			!Number.isFinite(target.estimatedMonthlySpendUsd) ||
			target.estimatedMonthlySpendUsd < 0
		) {
			throw new RangeError(
				`target ${target.id} estimatedMonthlySpendUsd must be finite and non-negative`,
			);
		}
		ids.add(target.id);
		yardIds.add(target.yardId);
	}
}
