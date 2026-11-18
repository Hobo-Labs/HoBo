import { must } from "@hobo/core/total-access";
import { hasUnverifiedYardCamps } from "./camp-constraints.js";
import { hasValidYardResidency } from "./residency.js";
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
	if (policy.effect !== "allow-if-no-match") {
		return {
			allowed: false,
			reason:
				"generation policy effect is unsupported or requires dedicated Yard evidence",
			policyId: policy.id,
		};
	}
	if (!hasValidYardResidency(options.requestedLayout)) {
		return {
			allowed: false,
			reason: "requested layout has invalid residency",
			policyId: policy.id,
		};
	}
	if (hasUnverifiedYardCamps(options.requestedLayout)) {
		return {
			allowed: false,
			reason: "requested Camp layouts cannot yet be verified",
			policyId: policy.id,
		};
	}
	if (policy.requireApproval !== false) {
		return {
			allowed: false,
			reason:
				"generation requires approval, but approval evidence is unavailable",
			policyId: policy.id,
		};
	}

	if (policy.requireAttestation !== false) {
		return {
			allowed: false,
			reason:
				"generation requires attestation, but attestation evidence is unavailable",
			policyId: policy.id,
		};
	}
	if (
		!Array.isArray(policy.lockedProperties) ||
		policy.lockedProperties.length > 0
	) {
		return {
			allowed: false,
			reason: "generation locked properties cannot yet be verified",
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
	/** Trusted host decision bound to the complete plan; it must be side-effect free. */
	readonly authorizePlan?: (plan: YardGenerationPlan) => boolean;
}): YardGenerationSaga {
	const attempts = new Map<
		string,
		{
			planDigest: ContentHash;
			plan: YardGenerationPlan;
			result: YardGenerationResult;
		}
	>();
	const inFlight = new Map<string, Promise<YardGenerationResult>>();
	const authorized = (
		authorize: (plan: YardGenerationPlan) => boolean,
		plan: YardGenerationPlan,
		planDigest: ContentHash,
	) => {
		try {
			// The host may retain its argument. Do not expose the private plan
			// that will subsequently be handed to an asynchronous provider.
			const decisionPlan = structuredClone(plan);
			return (
				options.authorizePlan === authorize &&
				authorize(decisionPlan) === true &&
				contentHashOf(decisionPlan) === planDigest &&
				contentHashOf(plan) === planDigest &&
				options.authorizePlan === authorize
			);
		} catch {
			return false;
		}
	};

	return {
		async run(inputPlan) {
			// Capture the work before any asynchronous provider operation. A caller
			// retaining its original object cannot change what the connector sees.
			const plan = structuredClone(inputPlan);
			if (!hasValidYardResidency(plan.requestedLayout)) {
				return fail(
					plan,
					"invalid-residency",
					"requested layout has invalid residency",
				);
			}
			if (hasUnverifiedYardCamps(plan.requestedLayout)) {
				return fail(
					plan,
					"camp-constraints-unverified",
					"requested Camp layouts cannot yet be verified",
				);
			}
			const planDigest = contentHashOf(plan);
			const authorize = options.authorizePlan;
			if (!authorize)
				return fail(
					plan,
					"generation-authorization-required",
					"a trusted host authorization is required",
				);
			if (!authorized(authorize, plan, planDigest))
				return fail(
					plan,
					"generation-authorization-denied",
					"host authorization denied or changed the generation plan",
				);
			// A provider may finish after the host revokes this caller's decision.
			// Keep its outcome in the saga for later reconciliation, but do not
			// return the result or provider error to a no-longer-authorized caller.
			const deliveryPlan = structuredClone(plan);
			const awaitAuthorized = async (
				operation: Promise<YardGenerationResult>,
			): Promise<YardGenerationResult> => {
				let result: YardGenerationResult;
				try {
					result = await operation;
				} catch (error) {
					if (!authorized(authorize, deliveryPlan, planDigest))
						return fail(
							deliveryPlan,
							"generation-authorization-denied",
							"host authorization changed before result delivery",
						);
					throw error;
				}
				if (!authorized(authorize, deliveryPlan, planDigest))
					return fail(
						deliveryPlan,
						"generation-authorization-denied",
						"host authorization changed before result delivery",
					);
				return result;
			};
			const key = plan.idempotencyKey;
			const existing = attempts.get(key);
			if (existing && existing.planDigest !== planDigest) {
				return fail(
					plan,
					"generation-plan-conflict",
					"idempotency key belongs to a different generation plan",
				);
			}
			const pending = inFlight.get(key);
			if (pending) return await awaitAuthorized(pending);
			if (
				existing &&
				(existing.result.status === "ready" ||
					existing.result.status === "failed")
			) {
				return existing.result;
			}
			// Keep authorization evidence apart from both the original caller and
			// the provider, which may retain or modify its own plan argument.
			const recordedPlan = existing?.plan ?? structuredClone(plan);

			const connector = options.connectors.get(plan.generatorConnectorId);
			if (!connector) {
				const result = fail(
					plan,
					"connector-missing",
					existing
						? "generator connector missing"
						: "generator connector not registered",
				);
				if (!existing)
					attempts.set(key, { planDigest, plan: recordedPlan, result });
				return result;
			}

			if (!existing) {
				const started: YardGenerationResult = Object.freeze({
					attemptId: plan.attemptId,
					status: "started",
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({
						attemptId: plan.attemptId,
						status: "started",
					}),
				});
				attempts.set(key, { planDigest, plan: recordedPlan, result: started });
			}

			const provision = connector.provision;
			const inspect = connector.inspect;

			// Schedule after publishing the in-flight promise, including for a
			// connector that synchronously reenters the saga. Failed calls retain
			// the started record so a later retry inspects rather than provisions.
			const operation = Promise.resolve().then(async () => {
				if (!authorized(authorize, plan, planDigest))
					return fail(
						plan,
						"generation-authorization-denied",
						"host authorization changed before the provider call",
					);
				const result = existing
					? await inspect.call(connector, plan.attemptId)
					: await provision.call(connector, plan);
				const normalized = snapshotGenerationResult(result);
				attempts.set(key, {
					planDigest,
					plan: recordedPlan,
					result: normalized,
				});
				return normalized;
			});
			inFlight.set(key, operation);
			try {
				return await awaitAuthorized(operation);
			} finally {
				if (inFlight.get(key) === operation) inFlight.delete(key);
			}
		},
		inspect(idempotencyKey) {
			const attempt = attempts.get(idempotencyKey);
			if (!attempt) return undefined;
			try {
				const authorize = options.authorizePlan;
				if (
					!authorize ||
					!authorized(authorize, attempt.plan, attempt.planDigest)
				)
					return undefined;
				return attempt.result;
			} catch {
				return undefined;
			}
		},
	};
}

function snapshotGenerationResult(
	value: YardGenerationResult,
): YardGenerationResult {
	const result = structuredClone(value);
	// A provisioned Yard is not usable until its registration path completes.
	const snapshot = {
		...result,
		status: result.status === "provisioned" ? "registered" : result.status,
		externalRefs: Object.freeze(result.externalRefs),
	};
	if (result.failure)
		return Object.freeze({
			...snapshot,
			failure: Object.freeze(result.failure),
		});
	return Object.freeze(snapshot);
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
