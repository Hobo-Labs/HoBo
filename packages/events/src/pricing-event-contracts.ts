import {
	createCorpusBaseline,
	createCorpusEntry,
	type EventEvolutionContract,
	eventSchema,
	stringField,
} from "./upcaster.js";

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

export const PRICING_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		pricingV1Contract(
			"pricing.QuoteCreated",
			[
				stringField("eventId", 1),
				stringField("occurredAt", 2),
				stringField("quoteHash", 3),
			],
			{
				eventId: "evt-pricing-quote-1",
				occurredAt: "2026-06-27T00:00:00.000Z",
				quoteHash:
					"sha256:e7d6d1ded5ea96d08b47239a7f52e9ce0d6436c9f15ce4fc151e9b51a7f33c56",
			},
		),
	]);

export function pricingCorpusBaseline() {
	return createCorpusBaseline(
		PRICING_EVENT_CONTRACTS.flatMap((contract) => contract.goldenCorpus),
	);
}
