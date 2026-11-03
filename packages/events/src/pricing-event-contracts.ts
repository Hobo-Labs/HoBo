import {
	createCorpusBaseline,
	createCorpusEntry,
	type EventBody,
	type EventEvolutionContract,
	eventSchema,
	messageField,
	repeatedMessageField,
	stringField,
	u64Field,
} from "./upcaster.js";

const SAMPLE_HASH =
	"sha256:e7d6d1ded5ea96d08b47239a7f52e9ce0d6436c9f15ce4fc151e9b51a7f33c56";
const SAMPLE_AT = "2026-06-27T00:00:00.000Z";

const RATE_CARD = "CgdjYXJkLXYxEgExGgNVU0Q=";
const AGREEMENT =
	"CgthZ3JlZW1lbnQtYRIIdGVuYW50LWEaCWFjY291bnQtYSIHc2FuZGJveDIGYWN0aXZl";
const ALLOWANCE =
	"ChBpbmNsdWRlZC1taW51dGVzEgh0ZW5hbnQtYRoOCgQxMDAwEgZtaW51dGVKDGJpbGwtb3ZlcmFnZQ==";
const COMMITMENT =
	"Cgxjb21taXRtZW50LWESCHRlbmFudC1hGgVzcGVuZCIMCgoKAzEwMBIDVVNEKg5iaWxsaW5nLXBlcmlvZDoHdXBmcm9udEIHZm9yZmVpdEoPcHJvdmlkZXItYWN0dWFs";
const SCENARIO =
	"CgVwbGFjZRIYMjAyNi0wNi0yN1QwMDowMDowMC4wMDBaGhgyMDI2LTA2LTI4VDAwOjAwOjAwLjAwMFoiR3NoYTI1NjplN2Q2ZDFkZWQ1ZWE5NmQwOGI0NzIzOWE3ZjUyZTljZTBkNjQzNmM5ZjE1Y2U0ZmMxNTFlOWI1MWE3ZjMzYzU2UiMaD3Byb3ZpZGVyLWFjdHVhbCIQbWFyZ2luYWwtY29uc3VtZQ==";
const QUOTE =
	"ChVob2JvLnByaWNpbmcucXVvdGUvdjESEXByaWNpbmctcmF0aW5nL3YxGkdzaGEyNTY6ZTdkNmQxZGVkNWVhOTZkMDhiNDcyMzlhN2Y1MmU5Y2UwZDY0MzZjOWYxNWNlNGZjMTUxZTliNTFhN2YzM2M1NiJHc2hhMjU2OmU3ZDZkMWRlZDVlYTk2ZDA4YjQ3MjM5YTdmNTJlOWNlMGQ2NDM2YzlmMTVjZTRmYzE1MWU5YjUxYTdmMzNjNTYqR3NoYTI1NjplN2Q2ZDFkZWQ1ZWE5NmQwOGI0NzIzOWE3ZjUyZTljZTBkNjQzNmM5ZjE1Y2U0ZmMxNTFlOWI1MWE3ZjMzYzU2MkdzaGEyNTY6ZTdkNmQxZGVkNWVhOTZkMDhiNDcyMzlhN2Y1MmU5Y2UwZDY0MzZjOWYxNWNlNGZjMTUxZTliNTFhN2YzM2M1NkokCgoKAzAuNRIDVVNEEgoKAzAuNRIDVVNEGgoKAzAuNRIDVVNEUhBtYXJnaW5hbC1jb25zdW1lqgECCAE=";
const RESERVATION =
	"Cg1yZXNlcnZhdGlvbi0xEkdzaGEyNTY6ZTdkNmQxZGVkNWVhOTZkMDhiNDcyMzlhN2Y1MmU5Y2UwZDY0MzZjOWYxNWNlNGZjMTUxZTliNTFhN2YzM2M1NhpHc2hhMjU2OmU3ZDZkMWRlZDVlYTk2ZDA4YjQ3MjM5YTdmNTJlOWNlMGQ2NDM2YzlmMTVjZTRmYzE1MWU5YjUxYTdmMzNjNTYiR3NoYTI1NjplN2Q2ZDFkZWQ1ZWE5NmQwOGI0NzIzOWE3ZjUyZTljZTBkNjQzNmM5ZjE1Y2U0ZmMxNTFlOWI1MWE3ZjMzYzU2KkdzaGEyNTY6ZTdkNmQxZGVkNWVhOTZkMDhiNDcyMzlhN2Y1MmU5Y2UwZDY0MzZjOWYxNWNlNGZjMTUxZTliNTFhN2YzM2M1NjABOhgyMDI2LTA2LTI3VDAwOjAwOjAwLjAwMFpCGDIwMjYtMDYtMjhUMDA6MDA6MDAuMDAwWkoHcGVuZGluZw==";
const RESTORED_STATE =
	"Cg9ob2JvLnByaWNpbmcvdjESEGNvbW1lcmNpYWwtc3RhdGUaCHRlbmFudC1hIAIqR3NoYTI1NjplN2Q2ZDFkZWQ1ZWE5NmQwOGI0NzIzOWE3ZjUyZTljZTBkNjQzNmM5ZjE1Y2U0ZmMxNTFlOWI1MWE3ZjMzYzU2MhgyMDI2LTA2LTI3VDAwOjAwOjAwLjAwMFpiCGNvbXBsZXRl";
const ACTUAL_CHARGE =
	"CghhY3R1YWwtMRILYWdyZWVtZW50LWEaB292ZXJhZ2UiCgoDMC41EgNVU0QqCgoDMC41EgNVU0QyCgoDMC41EgNVU0Q6CgoDMC41EgNVU0RCBXVzYWdlSgRub25lUhgyMDI2LTA2LTI3VDAwOjAwOjAwLjAwMFo=";

function encoded(value: string): Uint8Array {
	return Buffer.from(value, "base64");
}

function pricingV1Contract(
	type: string,
	fields: Parameters<typeof eventSchema>[2],
	sampleBody: EventBody,
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

function envelope(eventId: string) {
	return { eventId, occurredAt: SAMPLE_AT };
}

/** Append-only v1 wire shapes for the `pricing.*` commercial-terms event family. */
export const PRICING_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		pricingV1Contract(
			"pricing.RateCardPublished",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				messageField("rateCard", 3),
			],
			{ ...envelope("evt-pricing-rate-card-1"), rateCard: encoded(RATE_CARD) },
		),
		pricingV1Contract(
			"pricing.ProviderAgreementObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				messageField("agreement", 3),
			],
			{ ...envelope("evt-pricing-agreement-1"), agreement: encoded(AGREEMENT) },
		),
		pricingV1Contract(
			"pricing.GrantObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				messageField("allowance", 3, { required: false }),
				messageField("credit", 4, { required: false }),
			],
			{ ...envelope("evt-pricing-grant-1"), allowance: encoded(ALLOWANCE) },
		),
		pricingV1Contract(
			"pricing.CommitmentObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				messageField("commitment", 3),
			],
			{
				...envelope("evt-pricing-commitment-1"),
				commitment: encoded(COMMITMENT),
			},
		),
		pricingV1Contract(
			"pricing.QuoteCreated",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				messageField("scenario", 3),
				messageField("quote", 4),
			],
			{
				...envelope("evt-pricing-quote-1"),
				scenario: encoded(SCENARIO),
				quote: encoded(QUOTE),
			},
		),
		pricingV1Contract(
			"pricing.ReservationCreated",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				messageField("reservation", 3),
			],
			{
				...envelope("evt-pricing-reservation-created-1"),
				reservation: encoded(RESERVATION),
			},
		),
		pricingV1Contract(
			"pricing.ReservationConfirmed",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("reservationId", 3),
				u64Field("stateSeq", 4),
			],
			{
				...envelope("evt-pricing-reservation-confirmed-1"),
				reservationId: "reservation-1",
				stateSeq: 2n,
			},
		),
		pricingV1Contract(
			"pricing.ReservationReleased",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("reservationId", 3),
				u64Field("stateSeq", 4),
				messageField("restoredState", 5),
			],
			{
				...envelope("evt-pricing-reservation-released-1"),
				reservationId: "reservation-1",
				stateSeq: 3n,
				restoredState: encoded(RESTORED_STATE),
			},
		),
		pricingV1Contract(
			"pricing.ReservationExpired",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("reservationId", 3),
				u64Field("stateSeq", 4),
				messageField("restoredState", 5),
			],
			{
				...envelope("evt-pricing-reservation-expired-1"),
				reservationId: "reservation-1",
				stateSeq: 3n,
				restoredState: encoded(RESTORED_STATE),
			},
		),
		pricingV1Contract(
			"pricing.ActualChargeObserved",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				messageField("actualCharge", 3),
			],
			{
				...envelope("evt-pricing-actual-charge-1"),
				actualCharge: encoded(ACTUAL_CHARGE),
			},
		),
		pricingV1Contract(
			"pricing.ReconciliationRecorded",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("reservationId", 3),
				repeatedMessageField("actualCharges", 4),
				stringField("reconciliationHash", 5),
			],
			{
				...envelope("evt-pricing-reconciliation-1"),
				reservationId: "reservation-1",
				actualCharges: [encoded(ACTUAL_CHARGE)],
				reconciliationHash: SAMPLE_HASH,
			},
		),
	]);

export function pricingCorpusBaseline() {
	return createCorpusBaseline(
		PRICING_EVENT_CONTRACTS.flatMap((contract) => contract.goldenCorpus),
	);
}
