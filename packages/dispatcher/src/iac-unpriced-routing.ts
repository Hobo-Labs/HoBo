import {
	hashTargetPricingInventory,
	isBoundedPricingInput,
	quoteTargetPricing,
	type TargetPricingAvailability,
	type TargetPricingInventory,
} from "@hobo/pricing";
import {
	type IacRouteAuthority,
	type IacRoutePermit,
	runIacRoute,
} from "./iac-route.js";

export interface UnpricedIacExpectation {
	readonly kind: "unpriced";
	readonly targetId: string;
	readonly inventoryHash: string;
}

export interface UnpricedIacRoutingResult {
	readonly status: "selected" | "denied" | "uncertain" | "replay";
	readonly pricing:
		| { readonly status: "not-assessed" }
		| { readonly status: "unavailable"; readonly reason: string };
	readonly budget:
		| {
				readonly evaluation: "not-evaluated";
				readonly reservation: "not-created";
		  }
		| {
				readonly evaluation: "denied" | "unavailable";
				readonly reservation: "not-created";
		  }
		| { readonly evaluation: "bypassed"; readonly reservation: "held" }
		| { readonly evaluation: "unavailable"; readonly reservation: "unknown" };
	readonly targetId?: string;
	readonly code?: string;
	readonly reservationId?: string;
	readonly outputs?: Readonly<Record<string, string>>;
	readonly policy?: {
		readonly policyHash: string;
		readonly evidenceRef: string;
	};
	readonly scope?: {
		readonly authorityRef: string;
		readonly evidenceRef: string;
		readonly ownershipEpoch: string;
	};
}
type MutableRoutingResult = {
	-readonly [K in keyof UnpricedIacRoutingResult]: UnpricedIacRoutingResult[K];
};

interface Admission {
	requestId: string;
	targetId: string;
	status: string;
	code: string;
	message: string;
	requestDigest?: string;
	inventoryHash?: string;
	modelHash?: string;
	quoteHash?: string;
	quote?: unknown;
	budget: { evaluation: string; reservation: string };
	reservation?: {
		reservationId: string;
		unboundedExposure?: boolean;
		unpricedScopeProof?: {
			identity: {
				tenantId: string;
				budgetId: string;
				periodId: string;
				policyRevision: string;
			};
			providerAccountIds: readonly string[];
			authorityRef: string;
			evidenceRef: string;
			ownershipEpoch: string;
			observedAt: string;
			signature: string;
			exclusiveUntilSettled: boolean;
			noSharedEntitlements: boolean;
		};
	};
	unpricedPolicyProof?: {
		requestDigest: string;
		inventoryHash: string;
		identity: {
			tenantId: string;
			budgetId: string;
			periodId: string;
			policyRevision: string;
		};
		policyHash: string;
		evidenceRef: string;
		effect: string;
		obligationsSatisfied: boolean;
		observedAt: string;
		validUntil: string;
	};
}

function name(value: string, limit = 200): boolean {
	return (
		value.length > 0 &&
		value.length <= limit &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: these values cross the provider boundary and are bounded before a detached snapshot is examined. */
function snapshotAdmission(value: unknown): Admission | undefined {
	try {
		if (
			!isBoundedPricingInput(value) ||
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value)
		)
			return undefined;
		// SAFETY: every field used from the detached bounded snapshot is validated before use.
		const row = structuredClone(value) as Admission;
		if (
			typeof row.requestId !== "string" ||
			!name(row.requestId) ||
			typeof row.targetId !== "string" ||
			!name(row.targetId) ||
			typeof row.status !== "string" ||
			!name(row.status) ||
			typeof row.code !== "string" ||
			row.code.length > 200 ||
			typeof row.message !== "string" ||
			row.message.length > 4096 ||
			typeof row.budget !== "object" ||
			row.budget === null ||
			typeof row.budget.evaluation !== "string" ||
			!name(row.budget.evaluation) ||
			typeof row.budget.reservation !== "string" ||
			!name(row.budget.reservation)
		)
			return undefined;
		return row;
	} catch {
		return undefined;
	}
}

function snapshotOutputs(value: unknown): Record<string, string> | undefined {
	try {
		if (
			!isBoundedPricingInput(value) ||
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value)
		)
			return undefined;
		const entries = Object.entries(value);
		if (
			entries.length > 256 ||
			entries.some(
				([key, item]) =>
					!name(key) || typeof item !== "string" || item.length > 4096,
			)
		)
			return undefined;
		// SAFETY: the preceding check establishes string-valued entries.
		return Object.fromEntries(entries) as Record<string, string>;
	} catch {
		return undefined;
	}
}

interface ProviderFailure {
	admission: Admission | undefined;
	requiresReconciliation: boolean;
	reservationId?: string;
}

/* oxlint-disable anti-slop/no-unknown-returns -- SAFETY: the local descriptor reader passes opaque values directly to boundary validation. */
function readFailure(error: unknown): ProviderFailure {
	try {
		if (typeof error !== "object" || error === null)
			return { admission: undefined, requiresReconciliation: true };
		const data = Object.getOwnPropertyDescriptors(error);
		const read = (key: string): unknown => {
			const field = data[key];
			if (field === undefined) return undefined;
			if (!("value" in field)) throw new Error("provider error accessor");
			return field.value;
		};
		const admission = snapshotAdmission(read("admission"));
		const reconciliation = read("requiresReconciliation");
		const id = read("reservationId");
		if (
			id !== undefined &&
			(typeof id !== "string" ||
				id.length > 204 ||
				id.length === 0 ||
				id.trim() !== id ||
				/[\p{Cc}]/u.test(id))
		)
			return { admission: undefined, requiresReconciliation: true };
		const result: ProviderFailure = {
			admission,
			requiresReconciliation: reconciliation !== false,
		};
		if (typeof id === "string") result.reservationId = id;
		return result;
	} catch {
		return { admission: undefined, requiresReconciliation: true };
	}
}
/* oxlint-enable anti-slop/no-unknown-returns */
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the detached provider receipt is checked before any financial conclusion. */
function validHeld(
	admission: Admission,
	requestId: string,
	inventory: TargetPricingInventory,
	inventoryHash: string,
): boolean {
	try {
		const policy = admission.unpricedPolicyProof;
		const scope = admission.reservation?.unpricedScopeProof;
		const accounts = [
			...new Set(inventory.resources.map((entry) => entry.providerAccountRef)),
		].sort();
		return (
			admission.requestId === requestId &&
			admission.targetId === inventory.targetId &&
			admission.status === "admitted" &&
			admission.budget.evaluation === "bypassed" &&
			admission.budget.reservation === "held" &&
			admission.reservation?.reservationId === `iac:${requestId}` &&
			admission.reservation.unboundedExposure === true &&
			typeof admission.requestDigest === "string" &&
			/^sha256:[a-f0-9]{64}$/u.test(admission.requestDigest) &&
			admission.inventoryHash === inventoryHash &&
			(admission.modelHash === undefined || admission.modelHash === "") &&
			(admission.quoteHash === undefined || admission.quoteHash === "") &&
			admission.quote === undefined &&
			policy !== undefined &&
			policy.requestDigest === admission.requestDigest &&
			policy.inventoryHash === inventoryHash &&
			(policy.effect === "allow" || policy.effect === "allow-degraded") &&
			policy.obligationsSatisfied === true &&
			name(policy.policyHash) &&
			name(policy.evidenceRef) &&
			policy.identity.tenantId === inventory.tenantId &&
			Number.isFinite(Date.parse(policy.observedAt)) &&
			Number.isFinite(Date.parse(policy.validUntil)) &&
			Date.parse(policy.observedAt) < Date.parse(policy.validUntil) &&
			scope !== undefined &&
			scope.exclusiveUntilSettled === true &&
			scope.noSharedEntitlements === true &&
			name(scope.authorityRef) &&
			name(scope.evidenceRef) &&
			name(scope.ownershipEpoch) &&
			name(scope.signature, 4096) &&
			Number.isFinite(Date.parse(scope.observedAt)) &&
			(["tenantId", "budgetId", "periodId", "policyRevision"] as const).every(
				(key) =>
					scope.identity[key] === policy.identity[key] &&
					name(policy.identity[key]),
			) &&
			Array.isArray(scope.providerAccountIds) &&
			new Set(scope.providerAccountIds).size ===
				scope.providerAccountIds.length &&
			JSON.stringify([...scope.providerAccountIds].sort()) ===
				JSON.stringify(accounts)
		);
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** An explicit policy-directed single-target route: no cost rank or implicit fallback. */
export async function executeUnpricedIacTarget(input: {
	readonly authority: IacRouteAuthority;
	readonly tenantId: string;
	readonly requestId: string;
	/** Host-authenticated identity of the logical operation across request IDs. */
	readonly operation: {
		readonly operationId: string;
		readonly authorization: string;
	};
	readonly inventory: TargetPricingInventory;
	readonly pricing: TargetPricingAvailability;
	readonly run: (
		requestId: string,
		expected: UnpricedIacExpectation,
		permit: IacRoutePermit,
	) => Promise<{ outputs: Record<string, string>; admission: Admission }>;
}): Promise<UnpricedIacRoutingResult> {
	const pricing = { status: "not-assessed" as const };
	const notEvaluated = {
		evaluation: "not-evaluated",
		reservation: "not-created",
	} as const;
	const unknown = {
		evaluation: "unavailable",
		reservation: "unknown",
	} as const;
	const routed = await runIacRoute({
		authority: input.authority,
		tenantId: input.tenantId,
		requestId: input.requestId,
		operation: input.operation,
		run: async (route) => {
			if (
				!isBoundedPricingInput(input.inventory) ||
				!isBoundedPricingInput(input.pricing)
			)
				throw new Error("invalid routing input");
			const inventory = structuredClone(input.inventory);
			const availability = structuredClone(input.pricing);
			const assessment = quoteTargetPricing(inventory, availability);
			const inventoryHash = hashTargetPricingInventory(inventory);
			if (
				assessment.ok !== false ||
				assessment.code !== "PRICING_MODEL_UNAVAILABLE" ||
				availability.state.case !== "unavailable" ||
				inventoryHash === undefined ||
				inventory.tenantId !== input.tenantId ||
				(inventory.operation !== "deploy" && inventory.operation !== "destroy")
			) {
				const value: UnpricedIacRoutingResult = {
					status: "denied",
					code: "UNPRICED_TARGET_INVALID",
					pricing,
					budget: notEvaluated,
				};
				return { value, outcome: { status: "denied" as const } };
			}
			const selectedPricing = {
				status: "unavailable" as const,
				reason: availability.state.value.reason,
			};
			const targetId = inventory.targetId;
			const permit = await route.beginAttempt({ targetId, inventoryHash });
			let admission: Admission | undefined;
			let outputs: Record<string, string> | undefined;
			let returned = false;
			let failure: ReturnType<typeof readFailure> | undefined;
			try {
				const result = await input.run(
					input.requestId,
					{ kind: "unpriced", targetId, inventoryHash },
					permit,
				);
				returned = true;
				admission = snapshotAdmission(result.admission);
				outputs = snapshotOutputs(result.outputs);
			} catch (error) {
				failure = readFailure(error);
				admission = failure.admission;
			}
			if (
				admission &&
				admission.requestId === input.requestId &&
				admission.targetId === targetId &&
				admission.status === "denied" &&
				!returned &&
				!failure?.requiresReconciliation &&
				failure?.reservationId === undefined &&
				admission.reservation === undefined &&
				(admission.budget.evaluation === "denied" ||
					admission.budget.evaluation === "unavailable") &&
				admission.budget.reservation === "not-created" &&
				name(admission.code)
			) {
				await route.denyAttempt(permit);
				const value: UnpricedIacRoutingResult = {
					status: "denied",
					code: admission.code,
					targetId,
					pricing: selectedPricing,
					budget: {
						evaluation: admission.budget.evaluation,
						reservation: "not-created",
					},
				};
				return { value, outcome: { status: "denied" as const, targetId } };
			}
			if (
				admission &&
				validHeld(admission, input.requestId, inventory, inventoryHash) &&
				outputs !== undefined &&
				admission.unpricedPolicyProof &&
				admission.reservation?.unpricedScopeProof
			) {
				const policy = admission.unpricedPolicyProof;
				const scope = admission.reservation.unpricedScopeProof;
				const value: UnpricedIacRoutingResult = {
					status: "selected",
					targetId,
					outputs,
					pricing: selectedPricing,
					budget: { evaluation: "bypassed", reservation: "held" },
					reservationId: admission.reservation.reservationId,
					policy: {
						policyHash: policy.policyHash,
						evidenceRef: policy.evidenceRef,
					},
					scope: {
						authorityRef: scope.authorityRef,
						evidenceRef: scope.evidenceRef,
						ownershipEpoch: scope.ownershipEpoch,
					},
				};
				return { value, outcome: { status: "selected" as const, targetId } };
			}
			const value: MutableRoutingResult = {
				status: "uncertain",
				code: "UNPRICED_EXECUTION_OUTCOME_UNKNOWN",
				targetId,
				pricing: selectedPricing,
				budget: unknown,
			};
			if (failure?.reservationId !== undefined)
				value.reservationId = failure.reservationId;
			return { value, outcome: { status: "uncertain" as const, targetId } };
		},
	});
	if (routed.status === "executed") return routed.value;
	const result: MutableRoutingResult = {
		status: routed.status,
		code: routed.code,
		pricing,
		budget: unknown,
	};
	if (routed.targetId !== undefined) result.targetId = routed.targetId;
	return result;
}
