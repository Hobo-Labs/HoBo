import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { defineCiPolicy } from "../src/policy.js";

it("fulfills every authored policy consumer interaction", () => {
	const pact = JSON.parse(
		readFileSync(
			new URL("./desired-policy.pact.json", import.meta.url),
			"utf8",
		),
	);
	expect(pact.interactions).toHaveLength(1);
	for (const interaction of pact.interactions) {
		const result = defineCiPolicy(interaction.request.body);
		expect({
			accountId: result.accountId,
			connectionRef: result.providers[0]?.connectionRef,
			limitMicros: result.budget?.limitMicros,
			pauseAt: result.thresholds[0]?.fraction,
		}).toEqual(interaction.response.body);
	}
});
