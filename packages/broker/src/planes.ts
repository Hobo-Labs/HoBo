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
	RejectionReason,
	ResolutionReceipt,
} from "./types.js";

// The enforcement/execution planes the broker wraps. Each plane is a port so
// deployments can swap engines (OPA/Rego or Cedar for the policy plane, a
// Pact broker for the contract plane, a metering service for billing, Argo CD
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

// Argo-shaped delivery plane: hand an accepted receipt to the rollout engine.
// Live engines submit over the network, so submit is allowed to be async.
export interface DeliveryTicket {
	engine: string;
	target: string;
	document: JsonObject;
	response?: JsonObject;
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

// Render an Argo CD Application document for an accepted receipt. Pure data —
// submission to a real Argo control plane happens behind DeliveryPlane, so
// tests and dry runs can inspect exactly what would be applied.
export function renderArgoApplication(
	receipt: ResolutionReceipt,
	policy: DeliveryPolicy,
): JsonObject {
	return {
		apiVersion: "argoproj.io/v1alpha1",
		kind: "Application",
		metadata: {
			name: `hobo-${receipt.requestId}`,
			labels: {
				"hobo.dev/broker": receipt.brokerId,
				"hobo.dev/policy-hash": receipt.policyHash,
			},
		},
		spec: {
			project: "hobo",
			source: {
				repoURL: policy.gitopsRepo ?? "",
				path: `receipts/${receipt.requestId}`,
			},
			destination: {
				namespace: policy.destinationNamespace ?? "hobo",
			},
			syncPolicy:
				policy.syncMode === "auto"
					? { automated: { prune: policy.prune } }
					: {},
		},
	};
}

export function createDeliveryPlane(): DeliveryPlane {
	return {
		submit(receipt, policy) {
			if (policy.engine === "argo") {
				return {
					engine: "argo",
					target: policy.gitopsRepo ?? "",
					document: renderArgoApplication(receipt, policy),
				};
			}
			return {
				engine: "in-proc",
				target: receipt.brokerId,
				// SAFETY: assertion required at this I/O or test boundary.
				document: { receipt: cloneAsJson(receipt) },
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

export interface ArgoCdDeliveryPlaneOptions {
	endpoint: string;
	fetchFn: FetchLike;
	// Resolves the delivery credential OUT of the token broker; the plane
	// never holds a raw secret itself.
	tokenProvider?: () => Promise<string> | string;
}

// Live Argo CD submission: POST the rendered Application to the Argo CD
// applications API. Fail-closed — a non-2xx or transport error surfaces as a
// thrown DeliverySubmissionError, never a silently-dropped rollout.
export class DeliverySubmissionError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DeliverySubmissionError";
		this.code = code;
	}
}

export function createArgoCdDeliveryPlane(
	options: ArgoCdDeliveryPlaneOptions,
): DeliveryPlane {
	return {
		async submit(receipt, policy) {
			const document = renderArgoApplication(receipt, policy);
			const token = options.tokenProvider
				? await options.tokenProvider()
				: undefined;
			let response: { status: number; json(): Promise<JsonValue> };
			try {
				response = await options.fetchFn(
					`${options.endpoint.replace(/\/$/u, "")}/api/v1/applications`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							...(token !== undefined
								? { authorization: `Bearer ${token}` }
								: undefined),
						},
						body: JSON.stringify(document),
					},
				);
			} catch (error) {
				throw new DeliverySubmissionError(
					"delivery-transport-failed",
					`Argo CD submission failed in transport: ${String(error)}`,
				);
			}
			if (response.status < 200 || response.status >= 300) {
				throw new DeliverySubmissionError(
					"delivery-rejected",
					`Argo CD rejected the Application (HTTP ${response.status})`,
				);
			}
			// SAFETY: assertion required at this I/O or test boundary.
			const body = (await response.json()) as JsonObject;
			return {
				engine: "argo",
				target: options.endpoint,
				document,
				response: body,
			};
		},
	};
}

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
