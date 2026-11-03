import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	ActualChargeObservedSchema,
	CommitmentObservedSchema,
	GrantObservedSchema,
	ProviderAgreementObservedSchema,
	QuoteCreatedSchema,
	RateCardPublishedSchema,
	ReconciliationRecordedSchema,
	ReservationConfirmedSchema,
	ReservationCreatedSchema,
	ReservationExpiredSchema,
	ReservationReleasedSchema,
} from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import { PRICING_EVENT_CONTRACTS } from "../src/pricing-event-contracts.js";

const GENERATED_SCHEMAS = [
	["pricing.RateCardPublished", RateCardPublishedSchema],
	["pricing.ProviderAgreementObserved", ProviderAgreementObservedSchema],
	["pricing.GrantObserved", GrantObservedSchema],
	["pricing.CommitmentObserved", CommitmentObservedSchema],
	["pricing.QuoteCreated", QuoteCreatedSchema],
	["pricing.ReservationCreated", ReservationCreatedSchema],
	["pricing.ReservationConfirmed", ReservationConfirmedSchema],
	["pricing.ReservationReleased", ReservationReleasedSchema],
	["pricing.ReservationExpired", ReservationExpiredSchema],
	["pricing.ActualChargeObserved", ActualChargeObservedSchema],
	["pricing.ReconciliationRecorded", ReconciliationRecordedSchema],
] as const;

describe("pricing event generated protobuf compatibility", () => {
	it("pins every canonical v1 event body with byte-identical generated replay", () => {
		expect(PRICING_EVENT_CONTRACTS).toHaveLength(GENERATED_SCHEMAS.length);
		for (const [type, schema] of GENERATED_SCHEMAS) {
			const contract = PRICING_EVENT_CONTRACTS.find(
				(candidate) => candidate.type === type,
			);
			expect(contract, type).toBeDefined();
			const entry = contract?.goldenCorpus[0];
			expect(entry, type).toBeDefined();
			if (entry === undefined) continue;
			const pinned = Buffer.from(entry.bodyBase64, "base64");
			const decoded = fromBinary(schema, pinned);
			expect(Buffer.from(toBinary(schema, decoded)).equals(pinned), type).toBe(
				true,
			);
		}
	});
});
