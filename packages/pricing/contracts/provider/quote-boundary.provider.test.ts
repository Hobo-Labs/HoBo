import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { expect, it } from "vitest";
import { isJsonObject, parseJson, quoteVectorToJson } from "../../src/json.js";
import { quoteScenarioJson } from "../../src/quote.js";
import { isQuoteVector } from "../../src/types.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../pacts/pricing-quote.pact.json",
);
const pact = parseJson(readFileSync(pactPath, "utf8"));
if (
	!isJsonObject(pact) ||
	!Array.isArray(pact.interactions) ||
	pact.interactions.length === 0
)
	throw new Error("Pricing quote pact must contain interactions");
const descriptions = pact.interactions.map((interaction) => {
	if (
		!isJsonObject(interaction) ||
		!isJsonObject(interaction.request) ||
		!isJsonObject(interaction.request.contents) ||
		Object.prototype.toString.call(interaction.description) !==
			"[object String]"
	)
		throw new Error("Pricing quote pact interaction is malformed");
	return String(interaction.description);
});

it("verifies each recorded quote against the pricing kernel", async () => {
	const verified = new Set<string>();
	const invoke = (message: MessageDescriptor) => {
		if (message.content === undefined || Buffer.isBuffer(message.content))
			throw new Error("Pricing quote pact request is missing");
		const result = quoteScenarioJson(
			parseJson(JSON.stringify(message.content)),
		);
		if (!isQuoteVector(result))
			throw new Error(`${result.code}: ${result.message}`);
		verified.add(message.description);
		return quoteVectorToJson(result);
	};
	await new Verifier({
		provider: "hobo-pricing-quote-kernel",
		pactUrls: [pactPath],
		messageProviders: Object.fromEntries(
			descriptions.map((description) => [description, invoke]),
		),
		logLevel: "error",
		failIfNoPactsFound: true,
	}).verifyProvider();
	expect([...verified].sort()).toEqual([...descriptions].sort());
}, 30_000);
