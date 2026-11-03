import { create } from "@bufbuild/protobuf";
import {
	type ExternalProviderQuote,
	type PricingRejected,
	PricingRejectedSchema,
} from "./_generated/pricing_pb.js";

export function rejectExternalProviderQuote(
	quote: ExternalProviderQuote,
): PricingRejected {
	return create(PricingRejectedSchema, {
		schema: "hobo.pricing.rejected/v1",
		code: "PRICING_MODEL_UNSUPPORTED",
		message: `external provider quote ${quote.id} is persisted evidence, not an executable rating model`,
		unpriced: [
			{
				productRef: quote.productId,
				agreementRef: quote.providerAccountRef,
				chargeId: quote.id,
				reason: "external quotes cannot drive live rating or replay",
			},
		],
		rejectedCandidates: [],
	});
}
