import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { pricingCatalogHashFromCommercialRefs } from "../src/commercial-pricing.js";

describe("commercial pricing catalog hashes", () => {
	it("hashes sorted commercial product refs deterministically", () => {
		const first = pricingCatalogHashFromCommercialRefs(["b", "a"]);
		const second = pricingCatalogHashFromCommercialRefs(["a", "b"]);
		assert.equal(first, second);
		assert.match(first, /^sha256:[a-f0-9]{64}$/u);
	});
});
