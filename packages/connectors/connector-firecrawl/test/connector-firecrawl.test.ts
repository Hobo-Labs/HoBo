import { connectorDefinition } from "@hobo/bindles/connector";
import { describe, expect, it } from "vitest";

import { firecrawl } from "../src/index.js";

describe("@hobo/connector-firecrawl", () => {
	it("exports an opaque connector symbol with Auth.md discovery metadata", () => {
		expect(Object.prototype.toString.call(firecrawl)).toBe("[object Symbol]");
		expect(connectorDefinition(firecrawl)).toEqual({
			kind: "connector-definition",
			id: "firecrawl",
			origin: "https://api.firecrawl.dev",
			auth: {
				protocol: "auth.md",
				discovery: "https://www.firecrawl.dev/auth.md",
			},
			capabilities: ["search", "scrape", "map", "extract"],
		});
	});
});
