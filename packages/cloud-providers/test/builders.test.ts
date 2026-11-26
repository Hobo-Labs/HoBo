/**
 * The one-import authoring surface, exercised as an author would type it. The
 * example in this file is the target shape verbatim; the assertions pin it to
 * the `defineStation` / `defineYard` authoring of the same topology, which is
 * the proof that the builder is a front end and not a second parse.
 */
import { defineStation, defineYard } from "@hobo/yards";
import { describe, expect, it } from "vitest";

import {
	aws,
	azure,
	camp,
	cloudflare,
	gcp,
	station,
	vercel,
	yard,
} from "../src/index.js";

const NAMESPACES = [
	{ name: "aws", ns: aws },
	{ name: "azure", ns: azure },
	{ name: "gcp", ns: gcp },
	{ name: "cloudflare", ns: cloudflare },
	{ name: "vercel", ns: vercel },
] as const;

describe("PROVIDER_ID", () => {
	it.each(
		NAMESPACES,
	)("$name states the same provider id its catalog Yard carries", ({ ns }) => {
		expect(ns.PROVIDER_ID).toBeTypeOf("string");
		expect(ns.PROVIDER_ID).toBe(ns.Yard().providerId);
	});
});

describe("the target authoring surface", () => {
	// The example from the API brief, unedited.
	const acme = station("acme", (s) => {
		s.tenant("acme").residency("eu").trustDomain("acme.hobo.internal");

		s.yard(azure, "prod-eu", (y) => {
			y.region("westeurope").residency("eu").label("tier", "public");

			y.web(
				azure.containerApps({ ingress: "external" }),
				azure.appService({ sku: "P1v3" }),
			);
			y.data(azure.postgresFlexible({ tier: "GeneralPurpose" }));
			y.bucket(azure.blobStorage({ accessTier: "hot" }));

			y.camp("api", (c) => c.production().label("exposure", "public"));
			y.camp("preview", (c) =>
				c.preview().require("ephemeral").label("ttl", "72h"),
			);
		});

		s.yard(cloudflare.Yard());
	});

	it("is deep-equal to the defineStation authoring of the same topology", () => {
		const defined = defineStation("acme", {
			isolation: {
				tenant: "acme",
				residency: "eu",
				trustDomain: "acme.hobo.internal",
				airgap: false,
			},
			yards: [
				defineYard("prod-eu", {
					provider: "azure",
					region: "westeurope",
					residency: ["eu"],
					labels: { tier: "public" },
					web: [
						azure.containerApps({ ingress: "external" }),
						azure.appService({ sku: "P1v3" }),
					],
					data: azure.postgresFlexible({ tier: "GeneralPurpose" }),
					bucket: azure.blobStorage({ accessTier: "hot" }),
					// Camp-level equivalence against @hobo/camps' own `camp()` is
					// proven in packages/yards/test/builder.test.ts; here the
					// claim under test is that nesting equals attachment.
					camps: [
						camp("api", (c) => c.production().label("exposure", "public")),
						camp("preview", (c) =>
							c.preview().require("ephemeral").label("ttl", "72h"),
						),
					],
				}),
				cloudflare.Yard(),
			],
		});

		expect(acme).toEqual(defined);
	});

	it("registers both the built Yard and the prebuilt catalog Yard", () => {
		expect(acme.yardRefs).toEqual(["cloudflare", "prod-eu"]);
	});

	it("nests camps under the Yard that already knows its id and provider", () => {
		const prodEu = acme.yards.find((entry) => entry.name === "prod-eu");
		expect(prodEu?.camps.map((entry) => entry.id)).toEqual([
			"prod-eu/api",
			"prod-eu/preview",
		]);
		expect(
			prodEu?.camps.every((entry) => entry.derivedProviderId === "azure"),
		).toBe(true);
	});

	it("keeps several offerings per capability", () => {
		const prodEu = acme.yards.find((entry) => entry.name === "prod-eu");
		expect(
			prodEu?.bindings
				.filter((row) => row.profile === "web.hosted/v1")
				.map((row) => row.productId),
		).toEqual(["azure.app-service/v1", "azure.container-apps/v1"]);
	});
});

describe("standalone builders", () => {
	it("yard() builds a Yard on a provider namespace", () => {
		const built = yard(cloudflare, "edge", (y) => {
			y.region("weur");
			y.service(cloudflare.workers({}));
		});
		expect(built.providerId).toBe("cloudflare");
		expect(built.regions).toEqual(["weur"]);
	});

	it("camp() builds an unattached Camp", () => {
		const preview = camp("preview", (c) => c.preview().require("ephemeral"));
		expect(preview.id).toBe("preview");
		expect(preview.envType).toBe("ephemeral");
		expect(preview.derivedProviderId).toBeUndefined();
	});
});
