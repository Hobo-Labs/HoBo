import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseConfiguration } from "../src/config.js";

it("fulfills the in-process SDK configuration consumer contract", () => {
	const pact = JSON.parse(
		readFileSync(new URL("./configuration.pact.json", import.meta.url), "utf8"),
	);
	expect(pact.interactions).toHaveLength(1);
	for (const interaction of pact.interactions) {
		const config = parseConfiguration(JSON.stringify(interaction.request.body));
		expect({
			accountId: config.accounts[0]?.id,
			repository: config.connections[0]?.repository,
			offers: config.accounts[0]?.offers.length,
		}).toEqual(interaction.response.body);
	}
});
