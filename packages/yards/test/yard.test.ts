import { camp } from "@hobo/camps";
import { describe, expect, it } from "vitest";
import {
	YARD_BINDING_CONTRACT,
	YardBindingError,
	YardBoundaryError,
	yard,
	yardToContract,
} from "../src/index.js";

describe("yard() — owns provider; zero camps allowed", () => {
	it("declares provider on the yard with zero camps", () => {
		const azureProd = yard("azure-prod", {
			provider: "azure",
			regions: ["eastus2"],
			require: ["private-network", "managed-container-substrate"],
			properties: {
				"azure.subscriptionRef": "subscriptionref://platform-prod",
			},
			camps: [],
		});

		expect(azureProd.providerId).toBe("azure");
		expect(azureProd.camps).toHaveLength(0);
		expect(azureProd.regions).toContain("eastus2");
	});

	it("attaches camps and derives their provider from the yard", () => {
		const prod = camp("prod", {
			envType: "production",
			require: ["managed-container-substrate"],
		});
		const localYard = yard("local", {
			provider: "local",
			camps: [prod],
		});

		expect(localYard.providerId).toBe("local");
		expect(localYard.camps).toHaveLength(1);
		expect(localYard.camps[0]?.derivedProviderId).toBe("local");
		expect(localYard.camps[0]?.id).toBe("local/prod");
	});
	it("places the same provider-neutral Camp in another Yard without changing its declaration", () => {
		const prod = camp("prod", {
			logicalId: "shop/production",
			envType: "production",
			require: ["managed-container-substrate"],
		});
		const original = yard("aws-prod", { provider: "aws", camps: [prod] });
		const destination = yard("azure-prod", {
			provider: "azure",
			camps: [prod],
		});
		expect(prod.derivedProviderId).toBeUndefined();
		expect(original.camps[0]).toMatchObject({
			id: "aws-prod/prod",
			enclosingYardId: "aws-prod",
			derivedProviderId: "aws",
		});
		expect(destination.camps[0]).toMatchObject({
			id: "azure-prod/prod",
			enclosingYardId: "azure-prod",
			derivedProviderId: "azure",
		});
		expect(yardToContract(original).camps).toEqual(
			yardToContract(destination).camps,
		);
		const source = original.camps[0];
		if (!source) throw new Error("source Camp missing");
		const moved = yard("azure-moved", { provider: "azure", camps: [source] });
		expect(yardToContract(moved).camps[0]?.logicalId).toBe("shop/production");
		expect(moved.camps[0]).toMatchObject({
			id: "azure-moved/prod",
			logicalId: "shop/production",
			enclosingYardId: "azure-moved",
			derivedProviderId: "azure",
		});
		expect(original.camps[0]).toMatchObject({
			id: "aws-prod/prod",
			logicalId: "shop/production",
			enclosingYardId: "aws-prod",
			derivedProviderId: "aws",
		});
		// SAFETY: this round-trip serializes the validated Camp attached above.
		const restored = JSON.parse(
			JSON.stringify(original.camps[0]),
		) as typeof prod;
		expect(
			yard("gcp-moved", { provider: "gcp", camps: [restored] }).camps[0],
		).toMatchObject({
			id: "gcp-moved/prod",
			logicalId: "shop/production",
			enclosingYardId: "gcp-moved",
			derivedProviderId: "gcp",
		});
	});
	it("retains an explicitly named logical Camp across independently declared placements", () => {
		const prod = camp("prod", {
			logicalId: "checkout/production",
			envType: "production",
		});
		const first = yard("aws", { provider: "aws", camps: [prod] });
		const second = yard("azure", { provider: "azure", camps: [prod] });
		expect(first.camps[0]).toMatchObject({
			logicalId: "checkout/production",
			id: "aws/prod",
			derivedProviderId: "aws",
		});
		expect(second.camps[0]).toMatchObject({
			logicalId: "checkout/production",
			id: "azure/prod",
			derivedProviderId: "azure",
		});
	});

	it("rejects camps whose derived provider disagrees", () => {
		const awsCamp = camp("prod", { envType: "production" });
		const attached = {
			...awsCamp,
			derivedProviderId: "aws",
		};
		expect(() =>
			yard("azure-only", {
				provider: "azure",
				// SAFETY: `camps: [attached as typeof awsCamp],` is required at this I/O or test boundary.
				camps: [attached as typeof awsCamp],
			}),
		).toThrow(/disagrees with Yard provider/);
	});

	it("projects yard to its planning contract", () => {
		const y = yard("gcp-edge", {
			provider: { id: "gcp" },
			runtimeId: "gcp-yard-runtime/v1",
			camps: [],
		});
		const contract = yardToContract(y);
		expect(contract.providerId).toBe("gcp");
		expect(contract.runtimeId).toBe("gcp-yard-runtime/v1");
		expect(contract.camps).toEqual([]);
	});

	it("rejects credential-like properties", () => {
		expect(() =>
			yard("bad", {
				provider: "aws",
				properties: { apiKey: "secret" },
			}),
		).toThrow(/credentials/);
	});
});

describe("yard() — capability binding rows", () => {
	it("defaults to an empty frozen row set", () => {
		const y = yard("aws-prod", { provider: "aws" });
		expect(y.bindings).toEqual([]);
		expect(Object.isFrozen(y.bindings)).toBe(true);
	});

	it("canonicalizes authored rows into a sorted set", () => {
		const y = yard("aws-prod", {
			provider: "aws",
			bindings: [
				{ profile: "web.static/v1", productId: "aws:s3-website" },
				{ profile: "data.relational/v1", productId: "aws:rds-postgres" },
			],
		});
		expect(y.bindings.map((b) => b.profile)).toEqual([
			"data.relational/v1",
			"web.static/v1",
		]);
	});

	it("surfaces rows in the planning contract so selection can consume them structurally", () => {
		const y = yard("aws-prod", {
			provider: "aws",
			bindings: [
				{
					profile: "data.relational/v1",
					productId: "aws:rds-postgres",
					require: ["tls"],
				},
			],
		});
		const contract = yardToContract(y);
		expect(contract.bindings).toEqual([
			{
				contract: YARD_BINDING_CONTRACT,
				profile: "data.relational/v1",
				productId: "aws:rds-postgres",
				require: ["tls"],
				properties: {},
			},
		]);
		expect(Object.isFrozen(contract.bindings)).toBe(true);
	});

	it("refuses a row whose profile is already pinned as a resolver slot", () => {
		let code = "no-error";
		try {
			yard("aws-prod", {
				provider: "aws",
				resolverDefaults: {
					pins: [
						{ slot: "data.relational/v1", resolverId: "aws-rds-resolver/v1" },
					],
				},
				bindings: [
					{ profile: "data.relational/v1", productId: "aws:rds-postgres" },
				],
			});
		} catch (error) {
			code = error instanceof YardBindingError ? error.code : String(error);
		}
		expect(code).toBe("YARD_BINDING_PIN_CONFLICT");
	});

	it("refuses a binding another vendor runs: it needs its own Yard and a junction", () => {
		// Domain and provider boundaries (boundaries.ts): nothing in a Yard is
		// external. A product id names its vendor (`<vendor>.<product>/vN` or
		// `<vendor>:<product>`), so a foreign product is refused at parse time.
		expect(() =>
			yard("aws-prod", {
				provider: "aws",
				bindings: [
					{ profile: "kv.key-value/v1", productId: "gcp:memorystore" },
				],
			}),
		).toThrow(YardBoundaryError);
		try {
			yard("aws-prod", {
				provider: "aws",
				bindings: [
					{ profile: "kv.key-value/v1", productId: "gcp:memorystore" },
				],
			});
		} catch (error) {
			expect(error).toMatchObject({
				code: "YARD_EXTERNAL_FORBIDDEN",
				violations: [{ productId: "gcp:memorystore", vendor: "gcp" }],
			});
		}
	});

	it("keeps a service the provider runs on our behalf (Marketplace) internal", () => {
		const y = yard("vercel-prod", {
			provider: "vercel",
			bindings: [
				{
					profile: "kv.redis-compatible/v1",
					productId: "upstash.redis/v1",
					connectivityId: "vercel.marketplace/v1",
				},
				{
					profile: "data.postgres/v1",
					productId: "neon.postgres/v1",
					connectivityId: "vercel.marketplace/v1",
				},
				{
					profile: "data.postgres/v1",
					productId: "supabase.postgres/v1",
					connectivityId: "vercel.marketplace/v1",
				},
				{ profile: "api.http/v1", productId: "vercel.function/v1" },
			],
		});
		expect(y.bindings).toHaveLength(4);
		// The same products held directly (not via the provider) are refused.
		expect(() =>
			yard("vercel-prod", {
				provider: "vercel",
				bindings: [
					{ profile: "data.postgres/v1", productId: "neon.postgres/v1" },
				],
			}),
		).toThrow(/neon\.postgres\/v1 in a Yard whose provider is neon/);
	});

	it("accepts a provider package id as the Yard's provider", () => {
		const y = yard("cf", {
			provider: "@hobo/provider-cloudflare",
			bindings: [{ profile: "data.sql/v1", productId: "cloudflare.d1/v1" }],
		});
		expect(y.bindings).toHaveLength(1);
	});
});
