import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LOCAL_HOST_PROVIDER_ID } from "../src/local-host.js";
import type { BrokerCatalogDefinition } from "../src/types.js";
import {
	buildDeploymentRequestFromParts,
	resolveBindleDeployment,
} from "../src/yard-placement/deploy.js";

const definition = (id: string, price = "0"): BrokerCatalogDefinition => ({
	id,
	providerId: LOCAL_HOST_PROVIDER_ID,
	port: "service",
	features: [],
	regions: ["local"],
	cost: { sku: id, unit: "hour", marginalPrice: price },
	satisfies: () => ({ kind: "full" }),
});
async function resolve(
	definitions: BrokerCatalogDefinition[],
	region?: string,
) {
	const resource = {
		resourceId: "api",
		port: "service",
		features: ["required"],
	};
	const resources = region ? [{ ...resource, region }] : [resource];
	const request = buildDeploymentRequestFromParts({
		bindleName: "shop",
		providerId: LOCAL_HOST_PROVIDER_ID,
		resources,
	});
	return resolveBindleDeployment(request, {
		brokerId: "broker:test",
		catalog: { catalogHash: "sha256:catalog", definitions: () => definitions },
	});
}

describe("Yard residual placement evidence", () => {
	it("rejects a partial capability verdict", async () => {
		const result = await resolve([
			{
				...definition("partial"),
				satisfies: () => ({ kind: "partial", missing: ["required"] }),
			},
		]);
		expect(result.outcome).toBe("rejected");
	});
	it("does not force a wildcard whose capability verdict is none", async () => {
		const result = await resolve([
			{
				...definition("wildcard"),
				port: "*",
				satisfies: () => ({ kind: "none" }),
			},
		]);
		expect(result.outcome).toBe("rejected");
	});
	it("rejects a region unsupported by the chosen definition", async () => {
		const result = await resolve([definition("local")], "another-region");
		expect(result.outcome).toBe("rejected");
	});
	it("rejects malformed region metadata instead of treating characters as regions", async () => {
		const malformed = definition("malformed");
		Object.assign(malformed, JSON.parse('{"regions":"local"}'));
		expect((await resolve([malformed])).outcome).toBe("rejected");
	});
	it("rejects a definition changed by its capability callback", async () => {
		const changed = definition("changed");
		changed.satisfies = () => {
			changed.cost.marginalPrice = "9";
			return { kind: "full" };
		};
		expect((await resolve([changed])).outcome).toBe("rejected");
	});
	it("turns a failing capability callback into a rejection", async () => {
		const result = await resolve([
			{
				...definition("throw"),
				satisfies: () => {
					throw new Error("broken catalog");
				},
			},
		]);
		expect(result.outcome).toBe("rejected");
	});
	it("compares marginal decimals without losing precision", async () => {
		const result = await resolve([
			definition("a", "0.10000000000000001"),
			definition("z", "0.10000000000000000"),
		]);
		expect(result.placements[0]?.definitionId).toBe("z");
	});
	it("rejects malformed, negative and incomparable candidate prices", async () => {
		for (const price of ["bad", "-1", "1e2"]) {
			expect(
				(await resolve([definition("bad", price), definition("good", "1")]))
					.outcome,
			).toBe("rejected");
		}
		expect(
			(
				await resolve([
					definition("a", "1"),
					{
						...definition("b", "1"),
						cost: { sku: "b", unit: "request", marginalPrice: "1" },
					},
				])
			).outcome,
		).toBe("rejected");
	});
	it("rejects conflicting definition identities", async () => {
		expect(
			(await resolve([definition("same", "0"), definition("same", "1")]))
				.outcome,
		).toBe("rejected");
	});
	it("rejects a definition that changes provider during capability checks", async () => {
		const target = definition("target");
		const mutator = {
			...definition("mutator"),
			satisfies: () => {
				target.providerId = "external";
				return { kind: "none" };
			},
		};
		expect((await resolve([mutator, target])).outcome).toBe("rejected");
	});
	it("rejects a previous resource definition changed by a later capability check", async () => {
		const first = {
			...definition("first"),
			satisfies: ({ port }: { port: string }) => ({
				kind: port === "service" ? "full" : "none",
			}),
		};
		const second = {
			...definition("second"),
			satisfies: ({ port }: { port: string }) => {
				if (port !== "storage") return { kind: "none" };
				first.cost.marginalPrice = "9";
				return { kind: "full" };
			},
		};
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [
				{ resourceId: "api", port: "service", features: [] },
				{ resourceId: "data", port: "storage", features: [] },
			],
		});
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => [first, second],
			},
		});
		expect(result.outcome).toBe("rejected");
	});
	it("selects the minimum exact decimal in either catalog order", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.bigInt({ min: 0n, max: (1n << 52n) - 1n }), {
					minLength: 2,
					maxLength: 8,
				}),
				async (values) => {
					const defs = values.map((value, index) =>
						definition(
							`id-${index}`,
							`0.${value.toString().padStart(16, "0")}`,
						),
					);
					const expected = values.reduce(
						(best, value, index) => (value < values[best] ? index : best),
						0,
					);
					for (const order of [defs, [...defs].reverse()]) {
						const result = await resolve(order);
						expect(result.placements[0]?.definitionId).toBe(`id-${expected}`);
					}
				},
			),
			{ seed: 614522, numRuns: 80 },
		);
	});
});
