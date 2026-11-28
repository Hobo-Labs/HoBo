import { describe, expect, it } from "vitest";

import { GET } from "../../pages/examples/index.json.js";

describe("Examples catalog endpoint", () => {
	it("prerenders the repository catalog as JSON", async () => {
		// SAFETY: Astro endpoint tests only need an empty context bag.
		const response = await GET({} as never);
		type CatalogRow = { id: string; sourcePath: string };
		// SAFETY: catalog JSON is decoded as row records at this test boundary.
		const catalog = (await response.json()) as CatalogRow[];

		expect(response.headers.get("content-type")).toContain("application/json");
		expect(catalog).toHaveLength(4);
		expect(catalog[0]?.sourcePath).toBe(
			"examples/try-site/apps/hello-world/app.ts",
		);
	});
});
