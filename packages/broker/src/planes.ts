import {
	type CandidateDeployment,
	type DeployedContractState,
	evaluateGatekeeper,
	type GatekeeperEffect,
	type PolicyDecisionRequest,
	type PolicyPack,
	type ResidencyGateVerdict,
} from "@hobo/contracts";
import {
	cloneAsJson,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./json.js";

import type {
	BillingPolicy,
	BrokerRequest,
	DeliveryPolicy,
	DeliveryRouteLabel,
	ReconcilerModeName,
	RejectionReason,
	ResolutionReceipt,
} from "./types.js";

// The enforcement/execution planes the broker wraps. Each plane is a port so
// deployments can swap engines (OPA/Rego or Cedar for the policy plane, a
// Pact broker for the contract plane, a metering service for billing, @hobo/cd
// for delivery) without touching the brokering pipeline. The defaults below
// COMPOSE @hobo/contracts — the Gatekeeper (contract compatibility + policy
// pack + obligations + quota) is imported and RUN, not reinvented.

// The engine-neutral gate verdict every policy engine lowers onto: the same
// effect vocabulary as the Gatekeeper, per-plane machine-readable reasons,
// and the decision facts the engine recorded (policy.Decided et al).
export interface GateDecision {
	effect: GatekeeperEffect;
	reasons: RejectionReason[];
	events: Array<JsonObject>;
}

// OPA-shaped: a decision request document in, an effect + reasons out. The
// default runs the @hobo/contracts policy pack + Gatekeeper composition in
// process; createOpaGatePlane (opa.ts) queries a Rego decision instead.
// Engines may be remote, so evaluate is allowed to be async.
export interface GatePlane {
	evaluate(input: {
		request: PolicyDecisionRequest;
		costQuota: { quota: string; used: number; limit: number };
	}): GateDecision | Promise<GateDecision>;
}

// Billing enforcement plane: authorize estimated spend against the billing
// policy (budget + per-resolution spend cap) before any placement happens.
export interface BillingPlane {
	authorize(input: {
		spendEstimateUsd: number;
		billing: BillingPolicy;
		requestId?: string;
		requestDigest?: string;
	}): {
		ok: boolean;
		reasons: RejectionReason[];
	};
	/** Only before a side effect has begun; uncertain effects retain funds. */
	release?(requestId: string, confirmedUnused: true): void;
}

// Delivery plane: hand an accepted receipt to continuous delivery. Neutral
// (plan 0024, D14): the broker never renders a GitOps document, never names a
// cluster or namespace, and never applies anything itself. A ticket records
// how the receipt was routed and, through CD, which promotion carries it.
export interface DeliveryTicket {
	/** @deprecated display label (DeliveryRouteLabel); never read for routing. */
	engine: DeliveryRouteLabel;
	reconcilerMode: ReconcilerModeName;
	/** The cd-gitops publisher target, in publisher mode. */
	publisher?: string;
	/** The CD promotion that carries this receipt, when delivered through CD. */
	promotionId?: string;
	target: string;
	document: JsonObject;
}

export interface DeliveryPlane {
	submit(
		receipt: ResolutionReceipt,
		policy: DeliveryPolicy,
	): DeliveryTicket | Promise<DeliveryTicket>;
}

export interface GatePlaneOptions {
	policyPack?: PolicyPack;
	deployedState?: DeployedContractState;
	candidate?: CandidateDeployment;
	residency?: ResidencyGateVerdict;
}

export function createGatekeeperGatePlane(
	options: GatePlaneOptions = {},
): GatePlane {
	return {
		evaluate(input) {
			const decision = evaluateGatekeeper({
				request: input.request,
				deployedState: options.deployedState ?? { contracts: [] },
				candidate: options.candidate ?? {
					plan: { resources: [] },
					contracts: [],
				},
				...(options.policyPack !== undefined
					? { policyPack: options.policyPack }
					: undefined),
				...(options.residency !== undefined
					? { residency: options.residency }
					: undefined),
				costQuota: input.costQuota,
			});
			const reasons: RejectionReason[] = decision.reasons.map((reason) => ({
				plane:
					reason.gate === "cost"
						? "billing"
						: reason.gate === "contracts"
							? "contracts"
							: reason.gate === "residency"
								? "residency"
								: "policy",
				code: reason.code,
				message: reason.message,
			}));
			return {
				effect: decision.decision,
				reasons,
				events: decision.events.map((event) => {
					const json = cloneAsJson(event);
					return isJsonObject(json) ? json : { value: json };
				}),
			};
		},
	};
}

export function createBillingPlane(): BillingPlane {
	return {
		authorize({ spendEstimateUsd, billing }) {
			const reasons: RejectionReason[] = [];
			if (!Number.isFinite(spendEstimateUsd) || spendEstimateUsd < 0)
				return {
					ok: false,
					reasons: [
						{
							plane: "billing",
							code: "invalid-spend-estimate",
							message: "estimated spend must be finite and nonnegative",
						},
					],
				};
			if (
				!billing.spendCapUnlimited &&
				spendEstimateUsd > billing.spendCapUsd
			) {
				reasons.push({
					plane: "billing",
					code: "spend-cap-exceeded",
					message: `estimated spend ${spendEstimateUsd} USD exceeds per-resolution cap ${billing.spendCapUsd} USD`,
				});
			}
			if (!billing.budgetUnlimited && spendEstimateUsd > billing.budgetUsd) {
				reasons.push({
					plane: "billing",
					code: "budget-exceeded",
					message: `estimated spend ${spendEstimateUsd} USD exceeds remaining budget ${billing.budgetUsd} USD`,
				});
			}
			return { ok: reasons.length === 0, reasons };
		},
	};
}

// public-contract: typed delivery-plane failures with remediation.
export const DELIVERY_FAILURES = Object.freeze({
	"delivery-plane-unwired": {
		remediation:
			"This policy routes through an agent or a GitOps publisher, which only @hobo/cd can drive. Compose the broker with createReconcilerDeliveryPlane({ requestPromotion }), or set delivery.reconcilerMode to conductor for the in-process executor.",
	},
	"delivery-refused": {
		remediation:
			"CD refused the promotion; the reasons name the gate, window, lineage or policy that refused it. Resolve those and deliver again; the request is idempotent per receipt.",
	},
	"delivery-transport-failed": {
		remediation:
			"The CD control plane could not be reached. Check the CD service health and retry; nothing was applied.",
	},
} as const);

export type DeliveryFailureCode = keyof typeof DELIVERY_FAILURES;

// Live delivery fails closed: a refusal or transport error surfaces as a
// thrown DeliverySubmissionError, never a silently dropped rollout.
export class DeliverySubmissionError extends Error {
	readonly code: DeliveryFailureCode;
	readonly remediation: string;

	constructor(
		code: DeliveryFailureCode,
		message: string,
		remediation?: string,
	) {
		super(message);
		this.name = "DeliverySubmissionError";
		this.code = code;
		this.remediation = remediation ?? DELIVERY_FAILURES[code].remediation;
	}
}

/**
 * The in-process plane used when no CD is composed. It only runs the
 * in-process conductor; an agent or publisher policy fails closed, because
 * only @hobo/cd can drive those (no silent downgrade).
 */
export function createDeliveryPlane(): DeliveryPlane {
	return {
		submit(receipt, policy) {
			if (policy.reconcilerMode !== "conductor") {
				throw new DeliverySubmissionError(
					"delivery-plane-unwired",
					`delivery-plane-unwired: reconcilerMode ${policy.reconcilerMode} needs the CD delivery plane`,
				);
			}
			const document = cloneAsJson(receipt);
			return {
				engine: "in-proc",
				reconcilerMode: "conductor",
				target: receipt.brokerId,
				document: { receipt: document },
			};
		},
	};
}

/** What the broker asks CD to do with one accepted receipt. */
export type DeliveryPromotionRequest = Readonly<{
	receipt: ResolutionReceipt;
	delivery: DeliveryPolicy;
}>;

export type DeliveryPromotionReason = Readonly<{
	code: string;
	message: string;
	remediation?: string;
}>;

/** CD's answer: the promotion that carries the receipt, or a refusal. */
export type DeliveryPromotionResult =
	| Readonly<{ ok: true; promotionId: string; target: string }>
	| Readonly<{ ok: false; reasons: readonly DeliveryPromotionReason[] }>;

export interface ReconcilerDeliveryPlaneOptions {
	/**
	 * Request a promotion from @hobo/cd (composed by the host). CD records the
	 * Freight and promotes it; a reconciler converges the target by pull, or
	 * the named cd-gitops publisher commits it and observes the engine.
	 */
	requestPromotion: (
		request: DeliveryPromotionRequest,
	) => Promise<DeliveryPromotionResult>;
}

/**
 * The broker delivers through CD (plan 0024, D14). Every reconciler mode —
 * in-process conductor, pull agent, or GitOps publisher — goes through one
 * promotion request; the broker records the returned ticket and nothing else.
 */
export function createReconcilerDeliveryPlane(
	options: ReconcilerDeliveryPlaneOptions,
): DeliveryPlane {
	return {
		async submit(receipt, policy) {
			let result: DeliveryPromotionResult;
			try {
				result = await options.requestPromotion({ receipt, delivery: policy });
			} catch (error) {
				throw new DeliverySubmissionError(
					"delivery-transport-failed",
					`delivery-transport-failed: CD promotion request failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!result.ok) {
				const first = result.reasons[0];
				throw new DeliverySubmissionError(
					"delivery-refused",
					`delivery-refused: ${result.reasons.map((r) => `${r.code}: ${r.message}`).join("; ") || "no reason given"}`,
					first?.remediation,
				);
			}
			const publisher =
				policy.reconcilerMode === "publisher"
					? policy.publisher?.target
					: undefined;
			return {
				engine: policy.engine,
				reconcilerMode: policy.reconcilerMode,
				...(publisher !== undefined ? { publisher } : undefined),
				promotionId: result.promotionId,
				target: result.target,
				document: {
					promotionId: result.promotionId,
					requestId: receipt.requestId,
					stationId: receipt.stationId,
					railHash: receipt.railHash,
					reconcilerMode: policy.reconcilerMode,
					...(publisher !== undefined ? { publisher } : undefined),
				},
			};
		},
	};
}

// A minimal structural fetch so live planes stay testable against
// pact-derived mocks and never force a global fetch polyfill.
export type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<{ status: number; json(): Promise<JsonValue> }>;

// Adapt a parsed BrokerRequest into the OPA-shaped policy decision request the
// gate plane evaluates: the most specific topology id becomes the resource.
export function toPolicyDecisionRequest(
	brokerId: string,
	request: BrokerRequest,
): PolicyDecisionRequest {
	const scope = request.scope;
	const resource =
		scope.campId !== undefined
			? { kind: "camp", id: scope.campId }
			: scope.yardId !== undefined
				? { kind: "yard", id: scope.yardId }
				: scope.junctionId !== undefined
					? { kind: "junction", id: scope.junctionId }
					: { kind: "bindle", id: scope.bindleId };
	return {
		// The broker acts as a control-plane service in the Policy IR's subject
		// taxonomy (user | service | agent | system).
		subject: { kind: "service", id: brokerId },
		action: "hobo:broker:resolve",
		resource,
		phase: "plan",
		context: {
			target: scope.bindleId,
			costEstimateUsd: request.spendEstimateUsd,
			requirementCount: request.requirements.length,
		},
	};
}
