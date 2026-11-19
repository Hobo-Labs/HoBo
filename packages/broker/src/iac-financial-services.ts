import { clone, create } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	isBoundedPricingInput,
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

export type IacFinancialPlan = TargetPricingInventoryInput;

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
		if (plan.complete !== true)
			throw new TypeError("infrastructure plan inventory must be complete");
		if (!isBoundedPricingInput(plan))
			throw new TypeError("invalid or unbounded infrastructure plan");
		let stable: IacFinancialPlan;
		try {
			stable = structuredClone(plan);
		} catch {
			throw new TypeError("invalid infrastructure plan");
		}
		const inventory = createTargetPricingInventory(stable);
		const pricing =
			model === undefined
				? targetPricingUnavailable(
						"no financial model was supplied for this target",
					)
				: targetPricingModel({
						...model,
						scenario: clone(QuoteScenarioSchema, model.scenario),
						bindings: model.bindings.map((binding) => ({ ...binding })),
						planDigest: stable.planDigest,
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
			let assessment: ReturnType<typeof assess>;
			try {
				assessment = assess(plan);
			} catch {
				return create(IacTargetAdmissionDecisionSchema, {
					requestId,
					targetId: plan.targetId,
					status: "denied",
					code: "PLAN_INVALID",
					message: "infrastructure plan failed bounded validation",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				});
			}
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
