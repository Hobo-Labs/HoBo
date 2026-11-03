import {
	createCorpusBaseline,
	createCorpusEntry,
	type EventEvolutionContract,
	eventSchema,
	stringField,
} from "./upcaster.js";

const SAMPLE_HASH =
	"sha256:e7d6d1ded5ea96d08b47239a7f52e9ce0d6436c9f15ce4fc151e9b51a7f33c56";
const SAMPLE_AT = "2026-06-27T00:00:00.000Z";

function pricingV1Contract(
	type: string,
	fields: Parameters<typeof eventSchema>[2],
	sampleBody: Record<string, string>,
): EventEvolutionContract {
	const schema = eventSchema(type, 1, fields);
	return Object.freeze({
		type,
		currentVersion: 1,
		schemas: Object.freeze([schema]),
		upcasters: Object.freeze([]),
		goldenCorpus: Object.freeze([
			createCorpusEntry(schema, `${type.replaceAll(".", "-")}-v1`, sampleBody),
		]),
	});
}

/** Append-only v1 wire shapes for the `pricing.*` commercial-terms event family. */
export const PRICING_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		pricingV1Contract(
			"pricing.RateCardPublished",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("rateCardId", 3),
				stringField("catalogHash", 4),
			],
			{
				eventId: "evt-pricing-rate-card-1",
				occurredAt: SAMPLE_AT,
				rateCardId: "card-v1",
				catalogHash: SAMPLE_HASH,
			},
		),
		pricingV1Contract(
			"pricing.ProviderAgreementObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("agreementId", 3),
				stringField("stateHash", 4),
			],
			{
				eventId: "evt-pricing-agreement-1",
				occurredAt: SAMPLE_AT,
				agreementId: "agreement-a",
				stateHash: SAMPLE_HASH,
			},
		),
		pricingV1Contract(
			"pricing.GrantObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("grantId", 3),
				stringField("kind", 4),
			],
			{
				eventId: "evt-pricing-grant-1",
				occurredAt: SAMPLE_AT,
				grantId: "included-minutes",
				kind: "allowance",
			},
		),
		pricingV1Contract(
			"pricing.CommitmentObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("commitmentId", 3),
				stringField("stateHash", 4),
			],
			{
				eventId: "evt-pricing-commitment-1",
				occurredAt: SAMPLE_AT,
				commitmentId: "commitment-a",
				stateHash: SAMPLE_HASH,
			},
		),
		pricingV1Contract(
			"pricing.QuoteCreated",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("quoteHash", 3),
			],
			{
				eventId: "evt-pricing-quote-1",
				occurredAt: SAMPLE_AT,
				quoteHash: SAMPLE_HASH,
			},
		),
		pricingV1Contract(
			"pricing.ReservationCreated",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("reservationId", 3),
				stringField("quoteHash", 4),
			],
			{
				eventId: "evt-pricing-reservation-created-1",
				occurredAt: SAMPLE_AT,
				reservationId: "reservation-1",
				quoteHash: SAMPLE_HASH,
			},
		),
		pricingV1Contract(
			"pricing.ReservationReleased",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("reservationId", 3),
				stringField("quoteHash", 4),
			],
			{
				eventId: "evt-pricing-reservation-released-1",
				occurredAt: SAMPLE_AT,
				reservationId: "reservation-1",
				quoteHash: SAMPLE_HASH,
			},
		),
		pricingV1Contract(
			"pricing.ActualChargeObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("chargeId", 3),
				stringField("stateHash", 4),
			],
			{
				eventId: "evt-pricing-actual-charge-1",
				occurredAt: SAMPLE_AT,
				chargeId: "usage-line-1",
				stateHash: SAMPLE_HASH,
			},
		),
		pricingV1Contract(
			"pricing.ReconciliationRecorded",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("reconciliationId", 3),
				stringField("quoteHash", 4),
			],
			{
				eventId: "evt-pricing-reconciliation-1",
				occurredAt: SAMPLE_AT,
				reconciliationId: "recon-1",
				quoteHash: SAMPLE_HASH,
			},
		),
	]);

export function pricingCorpusBaseline() {
	return createCorpusBaseline(
		PRICING_EVENT_CONTRACTS.flatMap((contract) => contract.goldenCorpus),
	);
}
