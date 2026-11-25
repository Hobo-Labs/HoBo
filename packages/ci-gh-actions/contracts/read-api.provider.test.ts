import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readApiFixture, readPath } from "../test/support/read-api-fixture.js";

type Interaction = Readonly<{
	description: string;
	providerState: string;
	request: Readonly<{
		method: string;
		path: string;
		query?: Readonly<{ [name: string]: readonly string[] }>;
		headers: Readonly<{ authorization: string }>;
	}>;
	response: Readonly<{
		status: number;
		headers: Readonly<{ "content-type": string }>;
		body: object;
	}>;
}>;

const pact: { interactions: readonly Interaction[] } = JSON.parse(
	readFileSync(new URL("./read-api.pact.json", import.meta.url), "utf8"),
);

const STATELESS = "the relay keeps no run history";

it("answers every declared read API interaction from the relay's read API", async () => {
	expect(pact.interactions.length).toBeGreaterThanOrEqual(11);
	for (const interaction of pact.interactions) {
		const fixture = await readApiFixture(
			interaction.providerState === STATELESS,
		);
		const query = new URLSearchParams();
		for (const [name, values] of Object.entries(
			interaction.request.query ?? {},
		))
			for (const value of values) query.append(name, value);
		const search = query.size > 0 ? `?${query}` : "";
		expect(interaction.request.method).toBe("GET");
		const response = await readPath(
			fixture,
			`${interaction.request.path}${search}`,
			interaction.request.headers.authorization.replace(/^Bearer /u, ""),
		);
		expect(response.status, interaction.description).toBe(
			interaction.response.status,
		);
		expect(response.headers.get("content-type")).toBe(
			interaction.response.headers["content-type"],
		);
		expect(await response.json(), interaction.description).toEqual(
			interaction.response.body,
		);
	}
});
