import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	type QuoteScenario,
	type QuoteVector,
	type TargetPricingAvailability,
	TargetPricingAvailabilitySchema,
	type TargetPricingBinding,
	type TargetPricingInventory,
	TargetPricingInventorySchema,
	type TargetPricingModel,
	type TargetPricingResource,
} from "./_generated/pricing_pb.js";
import { resolveRateCard } from "./catalog.js";
import { isBoundedPricingInput, type JsonValue, stableHash } from "./json.js";
import { quoteScenario } from "./quote.js";
import { isQuoteVector } from "./types.js";

export type TargetPricingInventoryInput = Omit<
	TargetPricingInventory,
	"$typeName" | "resources"
> & {
	readonly resources: readonly Omit<TargetPricingResource, "$typeName">[];
};
export type TargetPricingModelInput = Omit<
	TargetPricingModel,
	"$typeName" | "scenario" | "bindings"
> & {
	readonly scenario: QuoteScenario;
	readonly bindings: readonly (Omit<
		TargetPricingBinding,
		"$typeName" | "candidateIndex"
	> & { readonly candidateIndex: number })[];
};
export type TargetPricingQuote =
	| {
			readonly ok: true;
			readonly source: "developer-supplied";
			readonly modelId: string;
			readonly revision: string;
			readonly modelHash: string;
			readonly inventoryHash: string;
			readonly quote: QuoteVector;
	  }
	| { readonly ok: false; readonly code: string; readonly reason: string };

export function createTargetPricingInventory(
	input: TargetPricingInventoryInput,
): TargetPricingInventory {
	return create(TargetPricingInventorySchema, {
		...input,
		resources: [...input.resources],
	});
}

export function targetPricingUnavailable(
	reason: string,
): TargetPricingAvailability {
	return create(TargetPricingAvailabilitySchema, {
		state: { case: "unavailable", value: { reason } },
	});
}

export function targetPricingModel(
	input: TargetPricingModelInput,
): TargetPricingAvailability {
	return create(TargetPricingAvailabilitySchema, {
		state: {
			case: "model",
			value: { ...input, bindings: [...input.bindings] },
		},
	});
}

export function parseTargetPricingAvailability(
	input: JsonValue,
): TargetPricingAvailability | undefined {
	if (!isBoundedPricingInput(input)) return undefined;
	try {
		return fromJson(TargetPricingAvailabilitySchema, input);
	} catch {
		return undefined;
	}
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_RESOURCES = 256;

function validName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
function refuse(code: string, reason: string): TargetPricingQuote {
	return { ok: false, code, reason };
}

/** Quote the complete target jointly so shared credits and commitments are consumed once. */
export function quoteTargetPricing(
	inventory: TargetPricingInventory,
	availability: TargetPricingAvailability,
): TargetPricingQuote {
	if (!isBoundedPricingInput(inventory) || !isBoundedPricingInput(availability))
		return refuse(
			"PRICING_INPUT_TOO_LARGE",
			"pricing input exceeds the bounded data limits",
		);
	if (
		!validName(inventory.targetId) ||
		!validName(inventory.tenantId) ||
		!DIGEST.test(inventory.planDigest) ||
		!inventory.complete ||
		!validName(inventory.evidenceRef) ||
		(inventory.operation !== undefined &&
			inventory.operation !== "deploy" &&
			inventory.operation !== "destroy") ||
		inventory.resources.length === 0 ||
		inventory.resources.length > MAX_RESOURCES ||
		inventory.resources.some(
			(resource) =>
				![
					resource.resourceId,
					resource.providerId,
					resource.providerAccountRef,
					resource.productId,
				].every(validName),
		) ||
		new Set(inventory.resources.map((resource) => resource.resourceId)).size !==
			inventory.resources.length
	) {
		return refuse(
			"TARGET_INVENTORY_INCOMPLETE",
			"target inventory must be complete, bounded and uniquely identified with evidence",
		);
	}
	if (availability.state.case === "unavailable") {
		return validName(availability.state.value.reason)
			? refuse("PRICING_MODEL_UNAVAILABLE", availability.state.value.reason)
			: refuse(
					"PRICING_MODEL_INVALID",
					"unavailable pricing requires a reason",
				);
	}
	if (availability.state.case !== "model")
		return refuse(
			"PRICING_MODEL_UNAVAILABLE",
			"target pricing was not declared",
		);
	const model = availability.state.value;
	const scenario = model.scenario;
	if (
		!validName(model.modelId) ||
		!validName(model.revision) ||
		scenario === undefined
	)
		return refuse(
			"PRICING_MODEL_INVALID",
			"model identity, revision and scenario are required",
		);
	if (
		model.planDigest !== inventory.planDigest ||
		scenario.state?.tenantId !== inventory.tenantId
	)
		return refuse(
			"PRICING_MODEL_SCOPE_MISMATCH",
			"model plan or tenant differs from target inventory",
		);
	const { catalog, state, options } = scenario;
	if (
		catalog === undefined ||
		state === undefined ||
		options === undefined ||
		state.completeness !== "complete" ||
		options.allowPartialFinancialState
	)
		return refuse(
			"INCOMPLETE_FINANCIAL_STATE",
			"a complete financial state is required for target pricing",
		);
	if (
		model.bindings.length !== inventory.resources.length ||
		scenario.candidate.length !== inventory.resources.length ||
		new Set(model.bindings.map((binding) => binding.resourceId)).size !==
			model.bindings.length ||
		new Set(model.bindings.map((binding) => binding.candidateIndex)).size !==
			model.bindings.length
	)
		return refuse(
			"TARGET_PRICING_INCOMPLETE",
			"every target resource needs exactly one candidate and binding",
		);
	const used: { productId: string; agreementId: string }[] = [];
	for (const workload of scenario.baseline) {
		const products = catalog.products.filter(
			(entry) => entry.id === workload.productRef,
		);
		const agreements = state.agreements.filter(
			(entry) => entry.id === workload.agreementRef,
		);
		const product = products[0];
		const agreement = agreements[0];
		if (
			products.length !== 1 ||
			agreements.length !== 1 ||
			product === undefined ||
			agreement === undefined ||
			agreement.productId !== product.id ||
			agreement.tenantId !== inventory.tenantId
		)
			return refuse(
				"PRICING_MODEL_SCOPE_MISMATCH",
				"baseline workload does not match its tenant and product agreement",
			);
		const dimensions = product.meters.map((meter) => meter.dimension);
		const measured = new Set(
			workload.usage.map((measurement) => measurement.dimension),
		);
		if (
			dimensions.some((dimension) => !validName(dimension)) ||
			new Set(dimensions).size !== dimensions.length ||
			dimensions.some((dimension) => !measured.has(dimension)) ||
			[...measured].some((dimension) => !dimensions.includes(dimension))
		)
			return refuse(
				"TARGET_PRICING_INCOMPLETE",
				"baseline usage must cover every declared meter without unmodeled dimensions",
			);
		used.push({ productId: product.id, agreementId: agreement.id });
	}
	for (const binding of model.bindings) {
		const resource = inventory.resources.find(
			(entry) => entry.resourceId === binding.resourceId,
		);
		const index = binding.candidateIndex;
		const candidate =
			index === undefined ? undefined : scenario.candidate[index];
		if (
			resource === undefined ||
			index === undefined ||
			!Number.isInteger(index) ||
			index < 0 ||
			candidate === undefined
		)
			return refuse(
				"TARGET_PRICING_INCOMPLETE",
				"target binding references a missing resource or candidate",
			);
		const products = catalog.products.filter(
			(entry) => entry.id === candidate.productRef,
		);
		const agreements = state.agreements.filter(
			(entry) => entry.id === candidate.agreementRef,
		);
		const product = products[0];
		const agreement = agreements[0];
		if (
			products.length !== 1 ||
			agreements.length !== 1 ||
			product === undefined ||
			agreement === undefined ||
			product.id !== resource.productId ||
			product.providerId !== resource.providerId ||
			agreement.productId !== resource.productId ||
			agreement.providerAccountRef !== resource.providerAccountRef ||
			agreement.tenantId !== inventory.tenantId
		)
			return refuse(
				"PRICING_MODEL_SCOPE_MISMATCH",
				"candidate product, provider, account or tenant differs from target inventory",
			);
		const dimensions = product.meters.map((meter) => meter.dimension);
		const measured = new Set(
			candidate.usage.map((measurement) => measurement.dimension),
		);
		if (
			dimensions.some((dimension) => !validName(dimension)) ||
			new Set(dimensions).size !== dimensions.length ||
			dimensions.some((dimension) => !measured.has(dimension)) ||
			[...measured].some((dimension) => !dimensions.includes(dimension))
		)
			return refuse(
				"TARGET_PRICING_INCOMPLETE",
				"candidate usage must cover every declared meter without unmodeled dimensions",
			);
		used.push({ productId: product.id, agreementId: agreement.id });
	}
	const quote = quoteScenario(scenario);
	if (!isQuoteVector(quote)) return refuse(quote.code, quote.message);
	if (
		quote.unpriced.length > 0 ||
		quote.eligibility?.eligible !== true ||
		quote.incremental?.billed === undefined
	)
		return refuse(
			"TARGET_PRICING_INCOMPLETE",
			"joint target quote is incomplete",
		);
	for (const row of used) {
		const product = catalog.products.find(
			(entry) => entry.id === row.productId,
		);
		const agreement = state.agreements.find(
			(entry) => entry.id === row.agreementId,
		);
		if (product === undefined || agreement === undefined)
			return refuse(
				"TARGET_PRICING_INCOMPLETE",
				"priced product or agreement is missing",
			);
		const dimensions = new Set(product.meters.map((meter) => meter.dimension));
		const rateCard = resolveRateCard(
			catalog,
			agreement,
			scenario.at,
			scenario.horizon,
		);
		if (
			rateCard.charges.length === 0 ||
			rateCard.charges.some(
				(charge) =>
					charge.variant.case === undefined ||
					(charge.variant.case === "usage" &&
						!dimensions.has(charge.variant.value.dimension)),
			)
		)
			return refuse(
				"TARGET_PRICING_INCOMPLETE",
				"rate-card charges must have declared product meters",
			);
	}
	return {
		ok: true,
		source: "developer-supplied",
		modelId: model.modelId,
		revision: model.revision,
		modelHash: stableHash(
			toJson(TargetPricingAvailabilitySchema, availability, {
				alwaysEmitImplicit: true,
			}),
		),
		inventoryHash: stableHash(
			toJson(TargetPricingInventorySchema, inventory, {
				alwaysEmitImplicit: true,
			}),
		),
		quote,
	};
}
