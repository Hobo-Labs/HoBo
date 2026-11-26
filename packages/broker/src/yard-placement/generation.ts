import { must } from "@hobo/core/total-access";
import {
	type ContentHash,
	contentHashOf,
	YARD_GENERATION_PLAN_SCHEMA,
	type YardGenerationPlan,
	type YardGenerationPolicy,
	type YardGenerationResult,
	type YardLayout,
	type YardRuntimeCatalogSnapshot,
	type YardRuntimeRegistration,
} from "./types.js";

export const DEFAULT_YARD_GENERATION_POLICY: YardGenerationPolicy =
	Object.freeze({
		id: "yard-generation-default-deny",
		effect: "deny",
		// SAFETY: assertion required at this I/O or test boundary.
		allowedRuntimeIds: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		deniedRuntimeIds: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		allowedProviderIds: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		deniedProviderIds: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		allowedConnectorIds: Object.freeze([] as string[]),
		maxConcurrentGenerations: 0,
		maxYardsPerTenant: 0,
		requireApproval: true,
		requireAttestation: true,
		// SAFETY: assertion required at this I/O or test boundary.
		lockedProperties: Object.freeze([] as string[]),
	});

export interface YardGenerationConnector {
	readonly id: string;
	readonly kind: string;
	plan(input: {
		readonly requestedLayout: YardLayout;
		readonly runtime: YardRuntimeRegistration;
		readonly ownerTenantId: string;
		readonly attemptId: string;
	}): YardGenerationPlan;
	provision(plan: YardGenerationPlan): Promise<YardGenerationResult>;
	inspect(attemptId: string): Promise<YardGenerationResult>;
	compensate?(plan: YardGenerationPlan): Promise<YardGenerationResult>;
}

/**
 * Pure decision: whether generation is allowed and which runtime/connector wins.
 * Default effect is deny.
 */
export function planYardGeneration(options: {
	readonly ownerTenantId: string;
	readonly requestedLayout: YardLayout;
	readonly runtimeCatalog: YardRuntimeCatalogSnapshot;
	readonly policy: YardGenerationPolicy;
	readonly allowGenerationRequested: boolean;
	readonly attemptId: string;
	readonly brokerEnvironmentId?: string;
}):
	| {
			readonly allowed: false;
			readonly reason: string;
			readonly policyId: string;
	  }
	| {
			readonly allowed: true;
			readonly plan: YardGenerationPlan;
			readonly runtime: YardRuntimeRegistration;
			readonly policyId: string;
	  } {
	const policy = options.policy;
	if (!options.allowGenerationRequested) {
		return {
			allowed: false,
			reason: "generation not requested on placement request",
			policyId: policy.id,
		};
	}
	if (policy.effect === "deny") {
		return {
			allowed: false,
			reason: "yard generation policy denies generation by default",
			policyId: policy.id,
		};
	}

	const providerId = options.requestedLayout.providerId;
	if (!providerId) {
		return {
			allowed: false,
			reason: "generation requires requestedLayout.providerId",
			policyId: policy.id,
		};
	}
	if (
		policy.deniedProviderIds.includes(providerId) ||
		(policy.allowedProviderIds.length > 0 &&
			!policy.allowedProviderIds.includes(providerId))
	) {
		return {
			allowed: false,
			reason: `provider ${providerId} not allowed for generation`,
			policyId: policy.id,
		};
	}

	const candidates = options.runtimeCatalog.runtimes
		.filter(
			(r) =>
				r.providerId === providerId &&
				r.status === "approved" &&
				Boolean(r.generatorConnectorId) &&
				!policy.deniedRuntimeIds.includes(r.runtimeId) &&
				(policy.allowedRuntimeIds.length === 0 ||
					policy.allowedRuntimeIds.includes(r.runtimeId)) &&
				(policy.allowedConnectorIds.length === 0 ||
					policy.allowedConnectorIds.includes(must(r.generatorConnectorId))),
		)
		.sort((a, b) => {
			if (a.default !== b.default) return a.default ? -1 : 1;
			if (a.priority !== b.priority) return b.priority - a.priority;
			return a.runtimeId < b.runtimeId ? -1 : 1;
		});

	const runtime = candidates[0];
	if (!runtime?.generatorConnectorId) {
		return {
			allowed: false,
			reason: `no approved YardRuntimeRegistration with generator for provider ${providerId}`,
			policyId: policy.id,
		};
	}

	// SAFETY: assertion required at this I/O or test boundary.
	const layoutHash = contentHashOf(options.requestedLayout) as ContentHash;
	// SAFETY: assertion required at this I/O or test boundary.
	const idempotencyKey = contentHashOf({
		ownerTenantId: options.ownerTenantId,
		layoutHash,
		runtimeId: runtime.runtimeId,
		runtimeVersion: runtime.version,
		brokerEnvironmentId: options.brokerEnvironmentId ?? "default",
	}) as ContentHash;

	const expectedYardId = `yard:gen-${idempotencyKey.slice(7, 23)}`;
	const inputs = Object.freeze({
		ownerTenantId: options.ownerTenantId,
		providerId,
		runtimeId: runtime.runtimeId,
	});
	const planBody = {
		schemaVersion: YARD_GENERATION_PLAN_SCHEMA,
		attemptId: options.attemptId,
		idempotencyKey,
		requestedLayout: options.requestedLayout,
		requestedLayoutHash: layoutHash,
		runtimeId: runtime.runtimeId,
		providerId,
		generatorConnectorId: runtime.generatorConnectorId,
		expectedYardId,
		requiredPermissions: runtime.requiredPermissions,
		credentialScopeRef: `scope://${runtime.generatorConnectorId}/${providerId}`,
		inputs,
	};
	const plan: YardGenerationPlan = Object.freeze({
		...planBody,
		// SAFETY: assertion required at this I/O or test boundary.
		planHash: contentHashOf(planBody) as ContentHash,
	});

	return {
		allowed: true,
		plan,
		runtime,
		policyId: policy.id,
	};
}

/**
 * In-memory generation saga coordinator: leases by idempotency key so concurrent
 * identical requests share one attempt.
 */
export interface YardGenerationSaga {
	readonly run: (plan: YardGenerationPlan) => Promise<YardGenerationResult>;
	readonly inspect: (
		idempotencyKey: string,
	) => YardGenerationResult | undefined;
}

export function createYardGenerationSaga(options: {
	readonly connectors: ReadonlyMap<string, YardGenerationConnector>;
}): YardGenerationSaga {
	const attempts = new Map<
		string,
		{ plan: YardGenerationPlan; result: YardGenerationResult }
	>();

	return {
		async run(plan) {
			const existing = attempts.get(plan.idempotencyKey);
			if (existing) {
				if (
					existing.result.status === "ready" ||
					existing.result.status === "failed"
				) {
					return existing.result;
				}
				// Resume inspect path for in-flight.
				const connector = options.connectors.get(plan.generatorConnectorId);
				if (!connector) {
					return fail(plan, "connector-missing", "generator connector missing");
				}
				const inspected = await connector.inspect(plan.attemptId);
				attempts.set(plan.idempotencyKey, { plan, result: inspected });
				return inspected;
			}

			const connector = options.connectors.get(plan.generatorConnectorId);
			if (!connector) {
				const result = fail(
					plan,
					"connector-missing",
					"generator connector not registered",
				);
				attempts.set(plan.idempotencyKey, { plan, result });
				return result;
			}

			const started: YardGenerationResult = Object.freeze({
				attemptId: plan.attemptId,
				status: "started",
				externalRefs: Object.freeze({}),
				outputHash: contentHashOf({
					attemptId: plan.attemptId,
					status: "started",
				}),
			});
			attempts.set(plan.idempotencyKey, { plan, result: started });

			const result = await connector.provision(plan);
			// Never treat provisioned as ready without registration path.
			const normalized =
				result.status === "provisioned"
					? Object.freeze({ ...result, status: "registered" as const })
					: result;
			attempts.set(plan.idempotencyKey, { plan, result: normalized });
			return normalized;
		},
		inspect(idempotencyKey) {
			return attempts.get(idempotencyKey)?.result;
		},
	};
}

function fail(
	plan: YardGenerationPlan,
	code: string,
	message: string,
): YardGenerationResult {
	return Object.freeze({
		attemptId: plan.attemptId,
		status: "failed",
		externalRefs: Object.freeze({}),
		outputHash: contentHashOf({ attemptId: plan.attemptId, code }),
		failure: Object.freeze({ code, message, retryable: false }),
	});
}
