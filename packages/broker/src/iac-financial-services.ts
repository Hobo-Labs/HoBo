import { clone, create, toJson } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	hashTargetPricingInventory,
	isBoundedPricingInput,
	QuoteScenarioSchema,
	QuoteVectorSchema,
	quoteTargetPricing,
	stableHash,
	type TargetPricingInventoryInput,
	TargetPricingInventorySchema,
	type TargetPricingModelInput,
	type TargetPricingQuote,
	targetPricingModel,
	targetPricingUnavailable,
} from "@hobo/pricing";
import {
	IacTargetAdmissionDecisionSchema,
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
} from "./_generated/yard_placement_pb.js";
import {
	admitIacTarget,
	type IacTargetAdmissionDeps,
	type IacTargetLiabilityEvidence,
} from "./iac-target.js";
import {
	admitUnpricedIacTarget,
	type IacUnpricedAuthorizer,
} from "./iac-unpriced.js";

/** Provider-neutral input accepted from an injected IaC adapter. */
export type IacFinancialPlan = Omit<TargetPricingInventoryInput, "complete">;

export type IacFinancialExpectation =
	| {
			readonly kind?: "priced";
			readonly targetId: string;
			readonly inventoryHash: string;
			readonly modelHash: string;
			readonly quoteHash: string;
	  }
	| {
			readonly kind: "unpriced";
			readonly targetId: string;
			readonly inventoryHash: string;
	  };

/** Structural receipt accepted from an IaC adapter before provider execution. */
export interface IacRevalidationReceipt {
	readonly requestId: string;
	readonly targetId: string;
	readonly status: string;
	readonly requestDigest?: string | undefined;
	readonly inventoryHash?: string | undefined;
	readonly modelHash?: string | undefined;
	readonly quoteHash?: string | undefined;
	readonly budget?:
		| {
				readonly evaluation: string;
				readonly reservation: string;
		  }
		| undefined;
	readonly reservation?:
		| {
				readonly reservationId: string;
				readonly unboundedExposure?: boolean;
				readonly unpricedScopeProof?:
					| {
							readonly identity?:
								| {
										readonly tenantId: string;
										readonly budgetId: string;
										readonly periodId: string;
										readonly policyRevision: string;
								  }
								| undefined;
							readonly providerAccountIds: readonly string[];
							readonly authorityRef: string;
							readonly evidenceRef: string;
							readonly ownershipEpoch: string;
							readonly observedAt: string;
							readonly exclusiveUntilSettled: boolean;
							readonly noSharedEntitlements: boolean;
							readonly signature: string;
					  }
					| undefined;
		  }
		| undefined;
	readonly unpricedPolicyProof?:
		| {
				readonly requestDigest: string;
				readonly inventoryHash: string;
				readonly identity?:
					| {
							readonly tenantId: string;
							readonly budgetId: string;
							readonly periodId: string;
							readonly policyRevision: string;
					  }
					| undefined;
				readonly policyHash: string;
				readonly effect: string;
				readonly evidenceRef: string;
				readonly obligationsSatisfied: boolean;
				readonly observedAt: string;
				readonly validUntil: string;
		  }
		| undefined;
}

export interface IacFinancialServicesOptions
	extends Omit<IacTargetAdmissionDeps, "authorize" | "verifyLiability"> {
	readonly pricing?: Omit<TargetPricingModelInput, "planDigest">;
	readonly verifyLiability?: IacTargetAdmissionDeps["verifyLiability"];
	readonly authorize?: IacTargetAdmissionDeps["authorize"];
	readonly unpriced?: { readonly authorize: IacUnpricedAuthorizer };
	readonly issueLiability?: (input: {
		inventory: ReturnType<typeof createTargetPricingInventory>;
		priced: Extract<TargetPricingQuote, { ok: true }>;
	}) => IacTargetLiabilityEvidence | Promise<IacTargetLiabilityEvidence>;
}

/** Compose pricing and durable admission behind a provider-independent port. */
export function createIacFinancialServices(
	options: IacFinancialServicesOptions,
) {
	let rawPricing: IacFinancialServicesOptions["pricing"];
	try {
		const field = Object.getOwnPropertyDescriptor(options, "pricing");
		if (
			(field === undefined && "pricing" in options) ||
			(field !== undefined &&
				(!("value" in field) || field.value === undefined))
		)
			throw new Error("pricing must be own data");
		rawPricing = field?.value;
	} catch {
		throw new TypeError("invalid pricing configuration");
	}
	let model: Omit<TargetPricingModelInput, "planDigest"> | undefined;
	if (rawPricing !== undefined) {
		if (!isBoundedPricingInput(rawPricing))
			throw new TypeError("invalid or unbounded pricing configuration");
		let stable: NonNullable<IacFinancialServicesOptions["pricing"]>;
		try {
			stable = structuredClone(rawPricing);
		} catch {
			throw new TypeError("invalid pricing configuration");
		}
		if (Object.hasOwn(stable, "planDigest"))
			throw new TypeError("the target plan digest is supplied by admission");
		const prepared = targetPricingModel({
			...stable,
			planDigest: `sha256:${"0".repeat(64)}`,
		});
		if (prepared.state.case !== "model")
			throw new TypeError("invalid pricing configuration");
		const source = prepared.state.value;
		const scenario = source.scenario;
		if (scenario === undefined)
			throw new TypeError("invalid pricing configuration");
		model = {
			modelId: source.modelId,
			revision: source.revision,
			scenario,
			bindings: source.bindings.map((binding) => {
				if (binding.candidateIndex === undefined)
					throw new TypeError("invalid pricing binding");
				return {
					resourceId: binding.resourceId,
					candidateIndex: binding.candidateIndex,
				};
			}),
		};
	}
	const assess = (plan: IacFinancialPlan) => {
		const inventory = createTargetPricingInventory({ ...plan, complete: true });
		const pricing =
			model === undefined
				? targetPricingUnavailable(
						"no financial model was supplied for this target",
					)
				: targetPricingModel({
						...model,
						scenario: clone(QuoteScenarioSchema, model.scenario),
						bindings: model.bindings.map((binding) => ({ ...binding })),
						planDigest: plan.planDigest,
					});
		return {
			inventory,
			inventoryHash: hashTargetPricingInventory(inventory),
			pricing,
			quote: quoteTargetPricing(inventory, pricing),
			budget: {
				evaluation: "not-evaluated",
				reservation: "not-created",
			} as const,
		};
	};
	return {
		assess,
		async revalidate(
			admission: IacRevalidationReceipt,
			plan: IacFinancialPlan,
		): Promise<boolean> {
			try {
				const assessment = assess(plan);
				const requestDigest = admission.requestDigest;
				const inventoryHash = assessment.inventoryHash;
				if (
					admission.status !== "admitted" ||
					admission.targetId !== plan.targetId ||
					admission.reservation?.reservationId !==
						`iac:${admission.requestId}` ||
					admission.budget?.reservation !== "held" ||
					requestDigest === undefined ||
					inventoryHash === undefined ||
					admission.inventoryHash !== inventoryHash ||
					!/^sha256:[a-f0-9]{64}$/u.test(requestDigest)
				)
					return false;
				if (admission.budget.evaluation === "bypassed") {
					if (
						admission.reservation.unboundedExposure !== true ||
						admission.reservation.unpricedScopeProof === undefined ||
						admission.unpricedPolicyProof === undefined ||
						assessment.quote.ok ||
						assessment.quote.code !== "PRICING_MODEL_UNAVAILABLE" ||
						(admission.modelHash !== undefined && admission.modelHash !== "") ||
						(admission.quoteHash !== undefined && admission.quoteHash !== "")
					)
						return false;
					return await options.authority.revalidateUnbounded({
						reservationId: admission.reservation.reservationId,
						requestDigest,
						inventoryHash,
						policyProofHash: stableHash(
							toJson(
								IacUnpricedPolicyProofSchema,
								create(
									IacUnpricedPolicyProofSchema,
									admission.unpricedPolicyProof,
								),
								{ alwaysEmitImplicit: true },
							),
						),
						scopeProofHash: stableHash(
							toJson(
								IacUnpricedScopeProofSchema,
								create(IacUnpricedScopeProofSchema, {
									...admission.reservation.unpricedScopeProof,
									providerAccountIds: [
										...admission.reservation.unpricedScopeProof
											.providerAccountIds,
									],
								}),
								{ alwaysEmitImplicit: true },
							),
						),
						executionDigest: stableHash({
							kind: "iac-target-execution",
							requestDigest,
							planDigest: plan.planDigest,
						}),
						now: options.now(),
					});
				}
				if (
					admission.budget.evaluation !== "allowed" ||
					admission.reservation.unboundedExposure === true ||
					!assessment.quote.ok ||
					admission.modelHash !== assessment.quote.modelHash ||
					admission.quoteHash !== assessment.quote.quote.quoteHash
				)
					return false;
				return await options.authority.revalidatePriced({
					reservationId: admission.reservation.reservationId,
					requestId: admission.requestId,
					targetId: admission.targetId,
					tenantId: plan.tenantId,
					requestDigest,
					planDigest: plan.planDigest,
					inventoryHash,
					modelHash: assessment.quote.modelHash,
					quoteHash: assessment.quote.quote.quoteHash,
					now: options.now(),
				});
			} catch {
				return false;
			}
		},
		async admit(
			requestId: string,
			plan: IacFinancialPlan,
			expected?: IacFinancialExpectation,
		) {
			const assessment = assess(plan);
			const mismatch =
				expected !== undefined &&
				(expected.targetId !== plan.targetId ||
					(expected.kind === "unpriced"
						? assessment.quote.ok ||
							assessment.quote.code !== "PRICING_MODEL_UNAVAILABLE" ||
							expected.inventoryHash !== assessment.inventoryHash
						: !assessment.quote.ok ||
							expected.inventoryHash !== assessment.quote.inventoryHash ||
							expected.modelHash !== assessment.quote.modelHash ||
							expected.quoteHash !== assessment.quote.quote.quoteHash));
			if (mismatch) {
				return create(IacTargetAdmissionDecisionSchema, {
					requestId,
					targetId: plan.targetId,
					status: "denied",
					code:
						expected?.kind === "unpriced"
							? "ROUTING_INVENTORY_CHANGED"
							: "ROUTING_QUOTE_CHANGED",
					message:
						"the target pricing or inventory no longer matches the reviewed assessment",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				});
			}
			if (
				!assessment.quote.ok &&
				assessment.quote.code === "PRICING_MODEL_UNAVAILABLE" &&
				options.unpriced !== undefined
			) {
				return admitUnpricedIacTarget(
					{
						requestId,
						inventory: assessment.inventory,
						pricing: assessment.pricing,
					},
					{
						authority: options.authority,
						now: options.now,
						authorizeUnpriced: options.unpriced.authorize,
					},
				);
			}
			let evidence: IacTargetLiabilityEvidence | undefined;
			if (assessment.quote.ok) {
				if (
					options.issueLiability === undefined ||
					options.authorize === undefined ||
					options.verifyLiability === undefined
				)
					return create(IacTargetAdmissionDecisionSchema, {
						requestId,
						targetId: plan.targetId,
						status: "denied",
						code: "FINANCIAL_CONFIGURATION_INCOMPLETE",
						message:
							"priced admission requires liability and policy authorities",
						budget: { evaluation: "unavailable", reservation: "not-created" },
					});
				try {
					evidence = await options.issueLiability({
						inventory: clone(
							TargetPricingInventorySchema,
							assessment.inventory,
						),
						priced: {
							...assessment.quote,
							quote: clone(QuoteVectorSchema, assessment.quote.quote),
						},
					});
				} catch {
					return create(IacTargetAdmissionDecisionSchema, {
						requestId,
						targetId: plan.targetId,
						status: "denied",
						code: "LIABILITY_SERVICE_UNAVAILABLE",
						message: "liability evidence could not be issued",
						budget: { evaluation: "unavailable", reservation: "not-created" },
					});
				}
			}
			try {
				const admission = {
					requestId,
					inventory: assessment.inventory,
					pricing: assessment.pricing,
				};
				if (
					evidence === undefined ||
					options.authorize === undefined ||
					options.verifyLiability === undefined
				)
					return create(IacTargetAdmissionDecisionSchema, {
						requestId,
						targetId: plan.targetId,
						status: "denied",
						code: assessment.quote.ok
							? "FINANCIAL_CONFIGURATION_INCOMPLETE"
							: assessment.quote.code,
						message: assessment.quote.ok
							? "priced admission requires liability and policy authorities"
							: assessment.quote.reason,
						budget: { evaluation: "unavailable", reservation: "not-created" },
					});
				return await admitIacTarget(
					{ ...admission, evidence },
					{
						authority: options.authority,
						now: options.now,
						authorize: options.authorize,
						verifyLiability: options.verifyLiability,
					},
				);
			} catch {
				return create(IacTargetAdmissionDecisionSchema, {
					requestId,
					targetId: plan.targetId,
					status: "uncertain",
					code: "ADMISSION_OUTCOME_UNKNOWN",
					message: "admission outcome must be reconciled before retry",
					budget: { evaluation: "unavailable", reservation: "unknown" },
				});
			}
		},
		async uncertain(reservationId: string): Promise<void> {
			await options.authority.uncertain(reservationId);
		},
	};
}
