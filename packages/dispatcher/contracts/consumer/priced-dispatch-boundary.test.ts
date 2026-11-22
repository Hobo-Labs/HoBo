import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	developerPricing,
	type JsonValue,
	parseQuoteScenario,
	pricingUnavailable,
} from "@hobo/pricing";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { describe, expect, it } from "vitest";
import {
	decidePricedDispatch,
	type PricedDispatchCategory,
} from "../../src/priced-dispatch.js";
import { dispatchQuoteScenario } from "../../test/priced-dispatch-fixtures.js";

type Request = {
	dispatchId: string;
	category: PricedDispatchCategory;
	objective: "min-incremental-billed";
	candidates: { providerId: string; scenario: JsonValue }[];
};

type Interaction = {
	type: string;
	description: string;
	request: {
		contents: { contentType: string; encoded: false; content: Request };
	};
	response: {
		contents: { contentType: string; encoded: false; content: object };
	}[];
};

type Contract = {
	metadata: { pactSpecification: { version: string }; transport: string };
	interactions: Interaction[];
};

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../pacts/priced_dispatch_decision.pact.json",
);
const pact: Contract = JSON.parse(readFileSync(pactPath, "utf8"));

function invoke(request: Request) {
	return decidePricedDispatch({
		...request,
		candidates: request.candidates.map(({ providerId, scenario }) => {
			const parsed = parseQuoteScenario(scenario);
			if (!parsed) throw new Error("invalid pricing scenario");
			return { providerId, scenario: parsed };
		}),
	});
}

describe("priced dispatch decision library contract", () => {
	it("describes the synchronous library boundary", () => {
		expect(pact.metadata).toMatchObject({
			pactSpecification: { version: "4.0.0" },
			transport: "library-call",
		});
		expect(pact.interactions).toHaveLength(2);
	});

	it.each(pact.interactions)("$description", (interaction) => {
		expect(interaction.type).toBe("Synchronous/Messages");
		expect(interaction.request.contents.contentType).toBe("application/json");
		expect(interaction.request.contents.encoded).toBe(false);
		const response = interaction.response[0];
		if (!response) throw new Error("contract response missing");
		expect(invoke(interaction.request.contents.content)).toMatchObject(
			response.contents.content,
		);
	});

	it("verifies recorded requests with the Pact provider verifier", async () => {
		const verified = new Set<string>();
		const messageProvider = (message: MessageDescriptor) => {
			if (message.content === undefined || Buffer.isBuffer(message.content))
				throw new Error("invalid priced dispatch contract request");
			const input: Request = JSON.parse(JSON.stringify(message.content));
			verified.add(message.description);
			return invoke(input);
		};
		const messageProviders = Object.fromEntries(
			pact.interactions.map(({ description }) => [
				description,
				messageProvider,
			]),
		);
		await new Verifier({
			provider: "PricedDispatchDecisionBoundary",
			pactUrls: [pactPath],
			messageProviders,
			logLevel: "error",
			failIfNoPactsFound: true,
		}).verifyProvider();
		expect([...verified].sort()).toEqual(
			pact.interactions.map(({ description }) => description).sort(),
		);
	}, 30_000);

	it("discloses supplied pricing and excludes unavailable pricing", () => {
		const decision = decidePricedDispatch({
			dispatchId: "pricing-availability-pact",
			category: "runner",
			candidates: [
				{ providerId: "unpriced", pricing: pricingUnavailable("no model") },
				{
					providerId: "priced",
					pricing: developerPricing(
						{
							modelId: "my-contract",
							revision: "2",
							tenantId: "tenant-a",
							providerId: "priced",
							providerAccountRef: "priced",
							productId: "runner",
						},
						dispatchQuoteScenario("priced", "0.1"),
					),
				},
			],
		});
		expect(decision).toMatchObject({
			ok: true,
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
			selectedProvider: "priced",
			ranking: [
				{
					providerId: "priced",
					pricingModel: {
						source: "developer-supplied",
						modelId: "my-contract",
						revision: "2",
					},
				},
			],
			rejectedCandidates: [
				{ providerId: "unpriced", code: "PRICING_MODEL_UNAVAILABLE" },
			],
		});
	});
});
