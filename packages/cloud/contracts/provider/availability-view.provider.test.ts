import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { expect, it } from "vitest";
import {
	computeAvailabilityView,
	parseAvailabilityViewRequest,
} from "../../src/index.js";
import { cloneAsJson, parseJsonValue } from "../../src/json.js";
import {
	availabilityInteractions,
	availabilityPactPath,
} from "../availability-view-fixture.js";

it("verifies each availability view against the cloud estimator", async () => {
	const interactions = availabilityInteractions();
	const verified = new Set<string>();
	const invoke = (message: MessageDescriptor) => {
		if (message.content === undefined || Buffer.isBuffer(message.content)) {
			throw new Error("availability pact request is missing");
		}
		const request = parseAvailabilityViewRequest(
			parseJsonValue(JSON.stringify(message.content)),
		);
		verified.add(message.description);
		return cloneAsJson(computeAvailabilityView(request));
	};
	await new Verifier({
		provider: "CloudAvailabilityView",
		pactUrls: [availabilityPactPath],
		messageProviders: Object.fromEntries(
			interactions.map(({ description }) => [description, invoke]),
		),
		logLevel: "error",
		failIfNoPactsFound: true,
	}).verifyProvider();
	expect([...verified].sort()).toEqual(
		interactions.map(({ description }) => description).sort(),
	);
}, 30_000);
