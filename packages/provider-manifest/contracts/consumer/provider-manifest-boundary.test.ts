import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type JsonObject, type JsonValue, toJson } from "@bufbuild/protobuf";
import { PricingCatalogSchema } from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import {
	parseProviderManifestJson,
	toCapabilityManifest,
	toPricingCatalog,
} from "../../src/index.js";

type Interaction = {
	readonly description: string;
	readonly request: { readonly body: JsonValue };
	readonly response: { readonly status: number; readonly body: JsonObject };
};

// SAFETY: the pact file is authored in this package; its shape is fixed here.
const pact = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("../pacts/provider-manifest-lowering.pact.json", import.meta.url),
		),
		"utf8",
	),
) as { readonly interactions: readonly Interaction[] };

// The registry (consumer) hands this package a manifest document and expects
// either the derived documents or a typed list of issues — never a partial
// import. The pact is a hand-authored consumer expectation.
describe("provider manifest lowering boundary", () => {
	it.each(pact.interactions)("$description", ({ request, response }) => {
		const result = parseProviderManifestJson(request.body);
		if (!result.ok) {
			expect(response.status).toBe(422);
			expect({ issues: result.issues }).toMatchObject(response.body);
			return;
		}
		expect(response.status).toBe(200);
		const published = toCapabilityManifest(result.manifest);
		const billing = toPricingCatalog(result.manifest);
		expect({
			providerId: published.providerId,
			auth: published.auth,
			capabilities: published.capabilities,
			cost: published.cost,
			pricingCatalog:
				billing === undefined
					? null
					: toJson(PricingCatalogSchema, billing.catalog),
			unrated: billing?.unrated ?? [],
		}).toMatchObject(response.body);
	});
});
