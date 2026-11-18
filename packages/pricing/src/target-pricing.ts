import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	type QuoteScenario,
	QuoteScenarioSchema,
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
import {
	isBoundedPricingInput,
	isExactProtoMessage,
	type JsonValue,
	stableHash,
} from "./json.js";
import { rateCardChargeIncomplete } from "./charge-coverage.js";
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
	if (!isBoundedPricingInput(input))
		throw new TypeError("invalid or unbounded target pricing inventory");
	let stable: TargetPricingInventoryInput;
	try {
		stable = structuredClone(input);
	} catch {
		throw new TypeError("invalid target pricing inventory");
	}
	if (!validInventoryInput(stable))
		throw new TypeError(
			"target pricing inventory contains unsupported or malformed data",
		);
	return create(TargetPricingInventorySchema, {
		...stable,
		resources: [...stable.resources],
	});
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: inventory objects cross a runtime input boundary before protobuf normalization. */
type InventoryInputPart =
	| TargetPricingInventoryInput
	| TargetPricingInventoryInput["resources"][number];

function validInventoryInput(input: TargetPricingInventoryInput): boolean {
	const fieldsAreKnown = (
		value: InventoryInputPart,
		allowed: readonly string[],
		typeName: string,
	) => {
		const fields = Object.getOwnPropertyDescriptors(value);
		const unknown = fields.$unknown?.value;
		return (
			(!Object.hasOwn(fields, "$typeName") ||
				fields.$typeName?.value === typeName) &&
			(!Object.hasOwn(fields, "$unknown") ||
				(Array.isArray(unknown) && unknown.length === 0)) &&
			Object.keys(fields).every(
				(key) =>
					allowed.includes(key) || key === "$typeName" || key === "$unknown",
			)
		);
	};
	try {
		return (
			input !== null &&
			typeof input === "object" &&
			fieldsAreKnown(
				input,
				[
					"targetId",
					"tenantId",
					"planDigest",
					"complete",
					"evidenceRef",
					"resources",
					"operation",
				],
				"hobo.pricing.v1.TargetPricingInventory",
			) &&
			typeof input.targetId === "string" &&
			typeof input.tenantId === "string" &&
			typeof input.planDigest === "string" &&
			typeof input.complete === "boolean" &&
			typeof input.evidenceRef === "string" &&
			(input.operation === undefined || typeof input.operation === "string") &&
			Array.isArray(input.resources) &&
			input.resources.every(
				(resource) =>
					resource !== null &&
					typeof resource === "object" &&
					fieldsAreKnown(
						resource,
						["resourceId", "providerId", "providerAccountRef", "productId"],
						"hobo.pricing.v1.TargetPricingResource",
					) &&
					typeof resource.resourceId === "string" &&
					typeof resource.providerId === "string" &&
					typeof resource.providerAccountRef === "string" &&
					typeof resource.productId === "string",
			)
		);
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

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
	if (!isBoundedPricingInput(input))
		throw new TypeError("invalid or unbounded target pricing model");
	let stable: TargetPricingModelInput;
	try {
		stable = structuredClone(input);
	} catch {
		throw new TypeError("invalid target pricing model");
	}
	if (!validModelInput(stable))
		throw new TypeError(
			"target pricing model contains unsupported or malformed data",
		);
	return create(TargetPricingAvailabilitySchema, {
		state: {
			case: "model",
			value: { ...stable, bindings: [...stable.bindings] },
		},
	});
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: developer model objects cross a runtime input boundary before protobuf normalization. */
function validModelInput(input: TargetPricingModelInput): boolean {
	const validKeys = <T extends object>(
		value: T,
		allowed: readonly string[],
		typeName: string,
	) => {
		const fields = Object.getOwnPropertyDescriptors(value);
		const metadata = fields.$typeName?.value;
		const unknown = fields.$unknown?.value;
		return (
			(!Object.hasOwn(fields, "$typeName") || metadata === typeName) &&
			(!Object.hasOwn(fields, "$unknown") ||
				(Array.isArray(unknown) && unknown.length === 0)) &&
			Object.keys(fields).every(
				(key) =>
					allowed.includes(key) || key === "$typeName" || key === "$unknown",
			)
		);
	};
	try {
		return (
			input !== null &&
			typeof input === "object" &&
			validKeys(
				input,
				["modelId", "revision", "planDigest", "scenario", "bindings"],
				"hobo.pricing.v1.TargetPricingModel",
			) &&
			typeof input.modelId === "string" &&
			typeof input.revision === "string" &&
			typeof input.planDigest === "string" &&
			Array.isArray(input.bindings) &&
			input.bindings.every(
				(binding) =>
					binding !== null &&
					typeof binding === "object" &&
					validKeys(
						binding,
						["resourceId", "candidateIndex"],
						"hobo.pricing.v1.TargetPricingBinding",
					) &&
					typeof binding.resourceId === "string" &&
					Number.isSafeInteger(binding.candidateIndex) &&
					binding.candidateIndex >= 0 &&
					binding.candidateIndex <= 0xffff_ffff,
			) &&
			isExactProtoMessage(QuoteScenarioSchema, input.scenario)
		);
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

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
			"pricing input is uninspectable or exceeds the bounded data limits",
		);
	if (!isExactProtoMessage(TargetPricingInventorySchema, inventory))
		return refuse(
			"TARGET_INVENTORY_INCOMPLETE",
			"target inventory contains unsupported or malformed data",
		);
	if (!isExactProtoMessage(TargetPricingAvailabilitySchema, availability))
		return refuse(
			"PRICING_MODEL_INVALID",
			"pricing model contains unsupported or malformed data",
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
		const workloadsForAgreement = [...scenario.baseline, ...scenario.candidate].filter(
			(entry) => entry.agreementRef === row.agreementId,
		);
		if (
			rateCard.charges.length === 0 ||
			rateCard.charges.some((charge) =>
				rateCardChargeIncomplete(
					charge,
					dimensions,
					agreement,
					workloadsForAgreement,
				),
			)
		)
			return refuse(
				"TARGET_PRICING_INCOMPLETE",
				"rate-card charges must have declared meters or quantity inputs",
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
