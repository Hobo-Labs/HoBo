import { clone, create } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	QuoteScenarioSchema,
	QuoteVectorSchema,
	quoteTargetPricing,
	type TargetPricingInventoryInput,
	TargetPricingInventorySchema,
	type TargetPricingModelInput,
	type TargetPricingQuote,
	targetPricingModel,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { IacTargetAdmissionDecisionSchema } from "./_generated/yard_placement_pb.js";
import {
	admitIacTarget,
	type IacTargetAdmissionDeps,
	type IacTargetLiabilityEvidence,
} from "./iac-target.js";

/** Provider-neutral input accepted from an injected IaC adapter. */
export type IacFinancialPlan = Omit<TargetPricingInventoryInput, "complete">;

export interface IacFinancialExpectation {
	readonly targetId: string;
	readonly inventoryHash: string;
	readonly modelHash: string;
	readonly quoteHash: string;
}

export interface IacFinancialServicesOptions extends IacTargetAdmissionDeps {
	readonly pricing?: Omit<TargetPricingModelInput, "planDigest">;
	readonly issueLiability: (input: {
		inventory: ReturnType<typeof createTargetPricingInventory>;
		priced: Extract<TargetPricingQuote, { ok: true }>;
	}) => IacTargetLiabilityEvidence | Promise<IacTargetLiabilityEvidence>;
}

/** Compose pricing and durable admission behind a provider-independent port. */
export function createIacFinancialServices(
	options: IacFinancialServicesOptions,
) {
	const model =
		options.pricing === undefined
			? undefined
			: {
					...options.pricing,
					scenario: clone(QuoteScenarioSchema, options.pricing.scenario),
					bindings: options.pricing.bindings.map((binding) => ({ ...binding })),
				};
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
		async admit(
			requestId: string,
			plan: IacFinancialPlan,
			expected?: IacFinancialExpectation,
		) {
			const assessment = assess(plan);
			if (
				expected !== undefined &&
				(expected.targetId !== plan.targetId ||
					assessment.quote.ok === false ||
					expected.inventoryHash !== assessment.quote.inventoryHash ||
					expected.modelHash !== assessment.quote.modelHash ||
					expected.quoteHash !== assessment.quote.quote.quoteHash)
			) {
				return create(IacTargetAdmissionDecisionSchema, {
					requestId,
					targetId: plan.targetId,
					status: "denied",
					code: "ROUTING_QUOTE_CHANGED",
					message: "the priced target no longer matches the ranked assessment",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				});
			}
			let evidence: IacTargetLiabilityEvidence | undefined;
			if (assessment.quote.ok) {
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
				return await admitIacTarget(
					evidence === undefined ? admission : { ...admission, evidence },
					options,
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
