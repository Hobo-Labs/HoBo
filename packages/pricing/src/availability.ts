import { create, fromJson } from "@bufbuild/protobuf";
import {
	type PricingAvailability,
	PricingAvailabilitySchema,
	type PricingModelScope,
	type QuoteScenario,
	QuoteScenarioSchema,
	type QuoteVector,
} from "./_generated/pricing_pb.js";
import { resolveRateCard } from "./catalog.js";
import {
	isBoundedPricingInput,
	isExactProtoMessage,
	type JsonValue,
} from "./json.js";
import {
	agreementRequiresRateCardValidation,
	rateCardChargesIncomplete,
} from "./charge-coverage.js";
import { quoteScenario } from "./quote.js";
import { isQuoteVector } from "./types.js";

export type DeveloperPricingScope = Omit<PricingModelScope, "$typeName">;

export type AvailabilityQuote =
	| {
			readonly ok: true;
			readonly quote: QuoteVector;
			readonly source: "developer-supplied";
			readonly modelId: string;
			readonly revision: string;
	  }
	| { readonly ok: false; readonly code: string; readonly reason: string };

export function pricingUnavailable(reason: string): PricingAvailability {
	return create(PricingAvailabilitySchema, {
		state: { case: "unavailable", value: { reason } },
	});
}

export function parsePricingAvailability(
	value: JsonValue,
): PricingAvailability | undefined {
	if (!isBoundedPricingInput(value)) return undefined;
	try {
		return fromJson(PricingAvailabilitySchema, value);
	} catch {
		return undefined;
	}
}

export function developerPricing(
	scope: DeveloperPricingScope,
	scenario: QuoteScenario,
): PricingAvailability {
	if (!isBoundedPricingInput({ scope, scenario }))
		throw new TypeError("invalid or unbounded developer pricing model");
	let stable: { scope: DeveloperPricingScope; scenario: QuoteScenario };
	try {
		stable = structuredClone({ scope, scenario });
	} catch {
		throw new TypeError("invalid developer pricing model");
	}
	if (
		!validDeveloperScope(stable.scope) ||
		!isExactProtoMessage(QuoteScenarioSchema, stable.scenario)
	)
		throw new TypeError(
			"developer pricing model contains unsupported or malformed data",
		);
	return create(PricingAvailabilitySchema, {
		state: { case: "developerModel", value: stable },
	});
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: developer scope crosses a runtime boundary before protobuf normalization. */
function validDeveloperScope(scope: DeveloperPricingScope): boolean {
	if (scope === null || typeof scope !== "object" || Array.isArray(scope))
		return false;
	const fields = Object.getOwnPropertyDescriptors(scope);
	const names = [
		"modelId",
		"revision",
		"tenantId",
		"providerId",
		"providerAccountRef",
		"productId",
	] as const;
	return (
		(!Object.hasOwn(fields, "$typeName") ||
			fields.$typeName?.value === "hobo.pricing.v1.PricingModelScope") &&
		(!Object.hasOwn(fields, "$unknown") ||
			(Array.isArray(fields.$unknown?.value) &&
				fields.$unknown.value.length === 0)) &&
		Object.keys(fields).every(
			(key) =>
				key === "$typeName" ||
				key === "$unknown" ||
				names.some((name) => name === key),
		) &&
		names.every((name) => typeof fields[name]?.value === "string")
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function failed(code: string, reason: string): AvailabilityQuote {
	return { ok: false, code, reason };
}

function validName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

export function quoteAvailablePricing(
	providerId: string,
	availability: PricingAvailability,
): AvailabilityQuote {
	if (!isBoundedPricingInput(availability))
		return failed(
			"PRICING_INPUT_TOO_LARGE",
			"pricing input exceeds the bounded data limits",
		);
	if (!isExactProtoMessage(PricingAvailabilitySchema, availability))
		return failed(
			"PRICING_MODEL_INVALID",
			"pricing availability contains unsupported or malformed data",
		);
	if (availability.state.case === "unavailable") {
		const reason = availability.state.value.reason;
		return validName(reason)
			? failed("PRICING_MODEL_UNAVAILABLE", reason)
			: failed("PRICING_MODEL_INVALID", "unavailable pricing needs a reason");
	}
	if (availability.state.case !== "developerModel") {
		return failed(
			"PRICING_MODEL_UNAVAILABLE",
			"pricing availability was not declared",
		);
	}
	const { scope, scenario } = availability.state.value;
	if (
		scope === undefined ||
		scenario === undefined ||
		![
			scope.modelId,
			scope.revision,
			scope.tenantId,
			scope.providerId,
			scope.providerAccountRef,
			scope.productId,
		].every(validName)
	) {
		return failed(
			"PRICING_MODEL_INVALID",
			"model scope and scenario are required",
		);
	}
	const { catalog, state, options } = scenario;
	if (providerId !== scope.providerId) {
		return failed(
			"PRICING_MODEL_SCOPE_MISMATCH",
			"model provider differs from the target",
		);
	}
	if (
		catalog === undefined ||
		state === undefined ||
		options === undefined ||
		state.completeness !== "complete" ||
		options.allowPartialFinancialState
	) {
		return failed(
			"INCOMPLETE_FINANCIAL_STATE",
			"a complete financial state is required for routing",
		);
	}
	if (state.tenantId !== scope.tenantId) {
		return failed(
			"PRICING_MODEL_SCOPE_MISMATCH",
			"model tenant differs from the financial state",
		);
	}
	const products = catalog.products.filter(
		(product) => product.id === scope.productId,
	);
	const product = products[0];
	if (
		products.length !== 1 ||
		product === undefined ||
		product.providerId !== scope.providerId
	) {
		return failed(
			"PRICING_MODEL_SCOPE_MISMATCH",
			"model product does not match the target provider",
		);
	}
	const dimensions = product.meters.map((meter) => meter.dimension);
	if (
		dimensions.length === 0 ||
		dimensions.some((dimension) => !validName(dimension)) ||
		new Set(dimensions).size !== dimensions.length ||
		scenario.candidate.length === 0
	) {
		return failed(
			"PRICING_MODEL_INCOMPLETE",
			"the target needs a workload and unambiguous declared meters",
		);
	}
	for (const workload of [...scenario.baseline, ...scenario.candidate]) {
		const agreements = state.agreements.filter(
			(agreement) => agreement.id === workload.agreementRef,
		);
		const agreement = agreements[0];
		if (
			workload.productRef !== scope.productId ||
			agreements.length !== 1 ||
			agreement?.productId !== scope.productId ||
			agreement.tenantId !== scope.tenantId ||
			agreement.providerAccountRef !== scope.providerAccountRef
		) {
			return failed(
				"PRICING_MODEL_SCOPE_MISMATCH",
				"workload agreement differs from model scope",
			);
		}
		const measured = new Set(
			workload.usage.map((measurement) => measurement.dimension),
		);
		if (
			dimensions.some((dimension) => !measured.has(dimension)) ||
			[...measured].some((dimension) => !dimensions.includes(dimension))
		) {
			return failed(
				"PRICING_MODEL_INCOMPLETE",
				"workload usage must cover every declared meter, with no unmodeled dimensions",
			);
		}
	}
	const workloadsAll = [...scenario.baseline, ...scenario.candidate];
	const meterDimensions = new Set(dimensions);
	for (const agreement of state.agreements) {
		if (!agreementRequiresRateCardValidation(agreement, workloadsAll)) continue;
		if (
			agreement.productId !== scope.productId ||
			agreement.tenantId !== scope.tenantId ||
			agreement.providerAccountRef !== scope.providerAccountRef
		) {
			continue;
		}
		const rateCard = resolveRateCard(
			catalog,
			agreement,
			scenario.at,
			scenario.horizon,
		);
		const workloadsForAgreement = workloadsAll.filter(
			(entry) => entry.agreementRef === agreement.id,
		);
		if (
			rateCardChargesIncomplete(
				rateCard.charges,
				meterDimensions,
				agreement,
				workloadsForAgreement,
			)
		) {
			return failed(
				"PRICING_MODEL_INCOMPLETE",
				"a rate-card charge is missing declared meters or quantity inputs",
			);
		}
	}
	const quote = quoteScenario(scenario);
	if (!isQuoteVector(quote)) return failed(quote.code, quote.message);
	if (
		quote.unpriced.length > 0 ||
		quote.eligibility?.eligible !== true ||
		quote.incremental?.billed === undefined
	) {
		return failed(
			"PRICING_MODEL_INCOMPLETE",
			"the quote is not completely priced",
		);
	}
	return {
		ok: true,
		quote,
		source: "developer-supplied",
		modelId: scope.modelId,
		revision: scope.revision,
	};
}
