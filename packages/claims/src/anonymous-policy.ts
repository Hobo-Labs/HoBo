
import type { BootstrapClass, Instant } from "./types.js";
import { ClaimError } from "./types.js";

export type AnonymousAdmissionCode =
	| "ANONYMOUS_QUOTA_EXCEEDED"
	| "SPONSOR_BUDGET_EXCEEDED"
	| "BOOTSTRAP_POLICY_DENIED"
	| "PROVIDER_RATE_LIMITED"
	| "RECIPE_KILL_SWITCH"
	| "PROVIDER_KILL_SWITCH"
	| "TTL_OUT_OF_BOUNDS"
	| "PAYLOAD_TOO_LARGE";

export type AnonymousPolicy = {
	readonly maxDeploymentsPerSession: number;
	readonly maxDeploymentsPerRiskBucketPerWindow: number;
	readonly riskBucketWindowMs: number;
	readonly maxConcurrentProvisioning: number;
	readonly maxConcurrentClaims: number;
	readonly maxResourcesPerSponsorAccount: number;
	readonly maxLeaseTtlMs: number;
	readonly maxRollbackWindowMs: number;
	readonly maxSourceBytes: number;
	readonly maxFileCount: number;
	readonly maxSingleFileBytes: number;
	readonly sponsorBudgetMinorUnits: number;
	readonly minPollIntervalMs: number;
	readonly allowedBootstrapClasses: readonly BootstrapClass[];
	readonly disabledProviders: readonly string[];
	readonly disabledRecipes: readonly string[];
};

export type AnonymousUsage = {
	readonly sessionDeployments: number;
	readonly riskBucketDeployments: number;
	readonly riskBucketWindowStartMs: Instant;
	readonly concurrentProvisioning: number;
	readonly concurrentClaims: number;
	readonly sponsorResourceCount: number;
	readonly sponsorSpentMinorUnits: number;
	readonly lastPollAtMs?: Instant;
};

export type AnonymousRequest = {
	readonly recipeId: string;
	readonly providerIds: readonly string[];
	readonly bootstrapClass: BootstrapClass;
	readonly requestedTtlMs: number;
	readonly requestedRollbackWindowMs?: number;
	readonly estimatedSponsorCostMinorUnits: number;
	readonly sourceBytes: number;
	readonly fileCount: number;
	readonly largestFileBytes: number;
	readonly pollAtMs?: Instant;
};

export type AnonymousRefusal = {
	readonly code: AnonymousAdmissionCode;
	readonly detail: string;
	readonly retryAfterMs?: number;
};

export type AnonymousAdmission =
	| { readonly ok: true }
	| { readonly ok: false; readonly refusals: readonly AnonymousRefusal[] };

export const DEFAULT_ANONYMOUS_POLICY: AnonymousPolicy = Object.freeze({
	maxDeploymentsPerSession: 3,
	maxDeploymentsPerRiskBucketPerWindow: 20,
	riskBucketWindowMs: 60 * 60 * 1000,
	maxConcurrentProvisioning: 2,
	maxConcurrentClaims: 4,
	maxResourcesPerSponsorAccount: 200,
	maxLeaseTtlMs: 72 * 60 * 60 * 1000,
	maxRollbackWindowMs: 24 * 60 * 60 * 1000,
	maxSourceBytes: 50 * 1024 * 1024,
	maxFileCount: 1000,
	maxSingleFileBytes: 5 * 1024 * 1024,
	sponsorBudgetMinorUnits: 50_000,
	minPollIntervalMs: 2_000,
	allowedBootstrapClasses: Object.freeze([
		"public-anonymous",
		"anonymous-claimable",
		"proof-of-work",
		"capability-token",
		"local",
	] as const) as readonly BootstrapClass[],
	disabledProviders: Object.freeze([] as string[]),
	disabledRecipes: Object.freeze([] as string[]),
});

export function admitAnonymousDeployment(input: {
	readonly policy: AnonymousPolicy;
	readonly usage: AnonymousUsage;
	readonly request: AnonymousRequest;
	readonly nowMs: Instant;
}): AnonymousAdmission {
	const { policy, usage, request, nowMs } = input;
	const refusals: AnonymousRefusal[] = [];

	if (policy.disabledRecipes.includes(request.recipeId)) {
		refusals.push({
			code: "RECIPE_KILL_SWITCH",
			detail: `recipe ${request.recipeId} is disabled by operator policy`,
		});
	}
	for (const providerId of request.providerIds) {
		if (policy.disabledProviders.includes(providerId)) {
			refusals.push({
				code: "PROVIDER_KILL_SWITCH",
				detail: `provider ${providerId} is disabled by operator policy`,
			});
		}
	}

	if (!policy.allowedBootstrapClasses.includes(request.bootstrapClass)) {
		refusals.push({
			code: "BOOTSTRAP_POLICY_DENIED",
			detail: `bootstrap class ${request.bootstrapClass} is not permitted`,
		});
	}

	if (usage.sessionDeployments >= policy.maxDeploymentsPerSession) {
		refusals.push({
			code: "ANONYMOUS_QUOTA_EXCEEDED",
			detail: `session already holds ${usage.sessionDeployments} of ${policy.maxDeploymentsPerSession} anonymous deployments`,
		});
	}

	const windowActive =
		nowMs - usage.riskBucketWindowStartMs < policy.riskBucketWindowMs;
	if (
		windowActive &&
		usage.riskBucketDeployments >= policy.maxDeploymentsPerRiskBucketPerWindow
	) {
		refusals.push({
			code: "ANONYMOUS_QUOTA_EXCEEDED",
			detail: `risk bucket exhausted (${usage.riskBucketDeployments}/${policy.maxDeploymentsPerRiskBucketPerWindow})`,
			retryAfterMs:
				usage.riskBucketWindowStartMs + policy.riskBucketWindowMs - nowMs,
		});
	}

	if (usage.concurrentProvisioning >= policy.maxConcurrentProvisioning) {
		refusals.push({
			code: "ANONYMOUS_QUOTA_EXCEEDED",
			detail: `too many provisioning operations in flight (${usage.concurrentProvisioning})`,
		});
	}
	if (usage.concurrentClaims >= policy.maxConcurrentClaims) {
		refusals.push({
			code: "ANONYMOUS_QUOTA_EXCEEDED",
			detail: `too many claim operations in flight (${usage.concurrentClaims})`,
		});
	}

	if (usage.sponsorResourceCount >= policy.maxResourcesPerSponsorAccount) {
		refusals.push({
			code: "SPONSOR_BUDGET_EXCEEDED",
			detail: `sponsor account already holds ${usage.sponsorResourceCount} resources`,
		});
	}
	if (
		usage.sponsorSpentMinorUnits + request.estimatedSponsorCostMinorUnits >
		policy.sponsorBudgetMinorUnits
	) {
		refusals.push({
			code: "SPONSOR_BUDGET_EXCEEDED",
			detail: `estimated spend ${request.estimatedSponsorCostMinorUnits} exceeds remaining sponsor budget ${
				policy.sponsorBudgetMinorUnits - usage.sponsorSpentMinorUnits
			}`,
		});
	}

	if (
		request.requestedTtlMs <= 0 ||
		request.requestedTtlMs > policy.maxLeaseTtlMs
	) {
		refusals.push({
			code: "TTL_OUT_OF_BOUNDS",
			detail: `requested TTL ${request.requestedTtlMs}ms is outside (0, ${policy.maxLeaseTtlMs}]`,
		});
	}
	if (
		request.requestedRollbackWindowMs !== undefined &&
		request.requestedRollbackWindowMs > policy.maxRollbackWindowMs
	) {
		refusals.push({
			code: "TTL_OUT_OF_BOUNDS",
			detail: `rollback window ${request.requestedRollbackWindowMs}ms exceeds ${policy.maxRollbackWindowMs}ms`,
		});
	}

	if (request.sourceBytes > policy.maxSourceBytes) {
		refusals.push({
			code: "PAYLOAD_TOO_LARGE",
			detail: `source ${request.sourceBytes} bytes exceeds ${policy.maxSourceBytes}`,
		});
	}
	if (request.fileCount > policy.maxFileCount) {
		refusals.push({
			code: "PAYLOAD_TOO_LARGE",
			detail: `${request.fileCount} files exceeds ${policy.maxFileCount}`,
		});
	}
	if (request.largestFileBytes > policy.maxSingleFileBytes) {
		refusals.push({
			code: "PAYLOAD_TOO_LARGE",
			detail: `largest file ${request.largestFileBytes} bytes exceeds ${policy.maxSingleFileBytes}`,
		});
	}

	if (
		request.pollAtMs !== undefined &&
		usage.lastPollAtMs !== undefined &&
		request.pollAtMs - usage.lastPollAtMs < policy.minPollIntervalMs
	) {
		refusals.push({
			code: "PROVIDER_RATE_LIMITED",
			detail: "poll interval below the configured minimum",
			retryAfterMs:
				usage.lastPollAtMs + policy.minPollIntervalMs - request.pollAtMs,
		});
	}

	if (refusals.length > 0) return { ok: false, refusals };
	return { ok: true };
}

export function assertAnonymousAdmission(admission: AnonymousAdmission): void {
	if (admission.ok) return;
	const first = admission.refusals[0];
	if (first === undefined) return;
	const extra = admission.refusals.length - 1;
	const detail =
		extra === 0 ? first.detail : `${first.detail} (+${extra} more)`;
	throw new ClaimError(
		first.code === "SPONSOR_BUDGET_EXCEEDED"
			? "SPONSOR_BUDGET_EXCEEDED"
			: "ANONYMOUS_QUOTA_EXCEEDED",
		detail,
	);
}

export function nextPollDelayMs(
	attempt: number,
	policy: Pick<AnonymousPolicy, "minPollIntervalMs">,
	capMs = 60_000,
): number {
	const exponent = Math.max(0, Math.min(attempt, 16));
	return Math.min(policy.minPollIntervalMs * 2 ** exponent, capMs);
}
