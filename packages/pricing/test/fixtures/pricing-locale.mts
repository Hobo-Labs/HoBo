import { quoteScenario } from "../../src/quote.js";
import { isQuoteVector } from "../../src/types.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../fixtures.js";

const credits = [
	creditState("z", "acquisition", 0),
	creditState("ä", "zero", 0),
];
if (process.env.HOBO_TEST_REVERSE === "1") credits.reverse();
const scenario = makeScenario({
	charges: [perUnitCharge("usage", "minute", "1")],
	candidate: [workload("agreement-a", [usage("minute", "10", "minute")])],
	credits,
});
const current = quoteScenario(scenario);
if (!isQuoteVector(current)) throw new Error("quote rejected");
console.log(
	JSON.stringify({
		locale: Intl.Collator().resolvedOptions().locale,
		effective: current.incremental?.effective?.decimal,
		consumption: current.consumption.map((item) => item.sourceId),
		quoteHash: current.quoteHash,
	}),
);
