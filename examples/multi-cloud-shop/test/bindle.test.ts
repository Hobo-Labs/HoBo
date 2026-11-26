import { readFile } from "node:fs/promises";

import { collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { describe, expect, it } from "vitest";

import { shopApi } from "../src/api.js";
import definition from "../src/bindle.js";
import { storefront } from "../src/webapp.js";

describe("multi-cloud-shop", () => {
	it("wires storefront -> api -> {products kv, orders queue}", () => {
		expect(Object.keys(definition.resources)).toEqual([
			"products",
			"orders",
			"api",
			"web",
		]);
		expect(definition.edges).toEqual(
			expect.arrayContaining([
				{ from: "api", to: "products" },
				{ from: "api", to: "orders" },
				{ from: "web", to: "api" },
			]),
		);
	});

	it("stays provider-neutral: provider selection belongs on a Yard", () => {
		// bindle-provider-selection-forbidden: no cloud provider pins may appear
		// in resource annotations; only platform annotations (hobo env /
		// session-replay) are allowed. Two-cloud deployment attaches this same
		// bindle to provider-specific Camps/Yards.
		for (const resource of Object.values(definition.resources)) {
			for (const annotation of resource.annotations) {
				expect(annotation.provider).toBe("hobo");
			}
		}
	});

	it("serves the catalog from the bound api entrypoint, pinned by the pact", async () => {
		const boundApi = definition.entrypoint("api");
		expect(boundApi).toBeTypeOf("function");

		// SAFETY: assertion to `boundApi?.() as typeof shopApi` is required at this boundary.
		const fetch = boundApi?.() as typeof shopApi;
		const response = await fetch(
			new Request("http://multi-cloud-shop.test/products"),
		);
		expect(response.status).toBe(200);

		// SAFETY: assertion to `JSON.parse( await readFile( new URL("../contracts/pacts/web-to-api.pact.json", import.meta.url), "utf8", ), ) as { inter` is required at this boundary.
		const pact = JSON.parse(
			await readFile(
				new URL("../contracts/pacts/web-to-api.pact.json", import.meta.url),
				"utf8",
			),
		) as {
			interactions: { response: { body: unknown } }[];
		};
		expect(await response.json()).toEqual(pact.interactions[0]?.response.body);
	});

	it("accepts a parsed order and refuses an unparsable one", async () => {
		const accepted = await shopApi(
			new Request("http://multi-cloud-shop.test/orders", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sku: "mug-01", quantity: 2 }),
			}),
		);
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toMatchObject({
			sku: "mug-01",
			quantity: 2,
		});

		const refused = await shopApi(
			new Request("http://multi-cloud-shop.test/orders", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sku: "", quantity: 0 }),
			}),
		);
		expect(refused.status).toBe(400);
	});

	it("serves the storefront page", async () => {
		const response = storefront(new Request("http://multi-cloud-shop.test/"));
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("multi-cloud-shop");
	});

	it("compiles deterministically through run-to-collect (provider-agnostic manifest)", () => {
		const first = collectBindleManifest(targetFromBindleDefinition(definition));
		const second = collectBindleManifest(
			targetFromBindleDefinition(definition),
		);

		expect(first.bindleId).toBe("multi-cloud-shop");
		expect(first.resources).toEqual(["api", "orders", "products", "web"]);
		expect(second.manifestHash).toBe(first.manifestHash);
		expect(second.manifest).toEqual(first.manifest);
	});
});
