import { describe, expect, it } from "vitest";
import { defineConnector } from "../src/connector.js";
import { bindle } from "../src/index.js";

const sample = defineConnector({
	kind: "connector-definition",
	id: "sample-search",
	origin: "https://search.example.com",
	auth: {
		protocol: "auth.md",
		discovery: "https://search.example.com/auth.md",
	},
	capabilities: ["search", "scrape"] as const,
});

describe("Bindle connectors", () => {
	it("records b.connector(symbol) beside resources and wires dependency edges", () => {
		const definition = bindle("connector-demo", (b) => {
			const search = b.connector(sample).allow("search");
			return { api: b.api().dependsOn(search) };
		});

		expect(definition.connectors).toEqual({
			"sample-search": {
				kind: "connector",
				name: "sample-search",
				target: "sample-search",
				origin: "https://search.example.com",
				auth: {
					protocol: "auth.md",
					discovery: "https://search.example.com/auth.md",
				},
				allow: ["search"],
			},
		});
		expect(definition.resources.api?.dependsOn).toEqual([
			"connector:sample-search",
		]);
		expect(definition.edges).toEqual([
			{ from: "api", to: "connector:sample-search" },
		]);
	});

	it("rejects capabilities not advertised by the connector package", () => {
		expect(() =>
			bindle("bad-connector", (b) => {
				const search = b.connector(sample);
				search.allow("admin" as "search");
				return { api: b.api() };
			}),
		).toThrow(/does not advertise capability admin/);
	});
});
