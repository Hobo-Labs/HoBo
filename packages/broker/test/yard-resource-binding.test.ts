import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LOCAL_HOST_PROVIDER_ID } from "../src/local-host.js";
import type { BrokerCatalogDefinition } from "../src/types.js";
import {
	buildDeploymentRequestFromParts,
	parseBindleDeploymentRequest,
	resolveBindleDeployment,
} from "../src/yard-placement/deploy.js";
import { buildExecutionUnits } from "../src/yard-placement/resolvers.js";

const base = {
	yardId: "yard:local",
	providerId: LOCAL_HOST_PROVIDER_ID,
	campId: "yard:local/camp:dev",
	bindleName: "shop",
};
const catalogDefinition = (
	id: string,
	port: string,
): BrokerCatalogDefinition => ({
	id,
	providerId: LOCAL_HOST_PROVIDER_ID,
	port,
	features: [],
	regions: ["local"],
	cost: { sku: id, unit: "hour", marginalPrice: "0" },
	satisfies: (req) => ({ kind: req.port === port ? "full" : "none" }),
});

describe("Yard resource-to-definition binding", () => {
	it("binds each execution unit to its actual selected definition, not a substring match", async () => {
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [
				{ resourceId: "api", port: "service", features: [] },
				{ resourceId: "db", port: "storage", features: [] },
			],
		});
		const defs = [
			catalogDefinition("compute-primary", "service"),
			catalogDefinition("storage-for-api", "storage"),
		];
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			catalog: { catalogHash: "sha256:catalog", definitions: () => defs },
		});
		expect(result.outcome).toBe("resolved");
		const units = result.receipt?.executionUnits ?? [];
		expect(
			units.find((unit) => unit.unitId === "unit:resource:api")
				?.residualDefinitions,
		).toEqual(["compute-primary"]);
		expect(
			units.find((unit) => unit.unitId === "unit:resource:db")
				?.residualDefinitions,
		).toEqual(["storage-for-api"]);
	});
	it("preserves exact resource associations for generated definition identifiers", () => {
		fc.assert(
			fc.property(
				fc.array(fc.stringMatching(/^[a-z]{1,8}$/), {
					minLength: 1,
					maxLength: 8,
				}),
				(names) => {
					const placements = names.map((name, index) => ({
						resourceId: `resource-${index}`,
						definitionId: `definition-${name}`,
					}));
					const units = buildExecutionUnits({
						...base,
						resourcePlacements: placements,
					});
					for (const item of placements) {
						expect(
							units.find(
								(unit) => unit.unitId === `unit:resource:${item.resourceId}`,
							)?.residualDefinitions,
						).toEqual([item.definitionId]);
					}
					expect(
						units
							.filter((unit) => unit.kind !== "resource")
							.every((unit) => unit.residualDefinitions.length === 0),
					).toBe(true);
				},
			),
			{ seed: 614523, numRuns: 100 },
		);
	});
	it("rejects duplicate resource units and missing definition identities", () => {
		expect(() =>
			buildExecutionUnits({
				...base,
				resourcePlacements: [
					{ resourceId: "api", definitionId: "first" },
					{ resourceId: "api", definitionId: "second" },
				],
			}),
		).toThrow(/duplicate resource identity/u);
		expect(() =>
			buildExecutionUnits({
				...base,
				resourcePlacements: [{ resourceId: "api", definitionId: "" }],
			}),
		).toThrow(/identities are required/u);
	});
	it("rejects duplicate resource identities before resolving", async () => {
		const valid = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [{ resourceId: "same", port: "service", features: [] }],
		});
		const result = await resolveBindleDeployment(
			{ ...valid, resources: [...valid.resources, ...valid.resources] },
			{
				brokerId: "broker:test",
				catalog: {
					catalogHash: "sha256:catalog",
					definitions: () => [catalogDefinition("service", "service")],
				},
			},
		);
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
	});
	it("binds the original request even if a callback mutates the caller's copy", async () => {
		const original = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [{ resourceId: "api", port: "service", features: [] }],
		});
		const mutable = JSON.parse(JSON.stringify(original));
		const definition = catalogDefinition("compute", "service");
		definition.satisfies = () => {
			mutable.resources[0].resourceId = "changed";
			return { kind: "full" };
		};
		const result = await resolveBindleDeployment(mutable, {
			brokerId: "broker:test",
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => [definition],
			},
		});
		expect(result.outcome).toBe("resolved");
		expect(result.placements[0]?.resourceId).toBe("api");
		expect(
			result.receipt?.executionUnits.some(
				(unit) => unit.unitId === "unit:resource:api",
			),
		).toBe(true);
	});
	it("rejects missing, blank and duplicate resource identities while parsing", () => {
		const valid = buildDeploymentRequestFromParts({
			bindleName: "shop",
			resources: [{ resourceId: "api", port: "service", features: [] }],
		});
		for (const resources of [
			[{ port: "service" }],
			[{ resourceId: "", port: "service" }],
			[{ resourceId: "  ", port: "service" }],
			[
				{ resourceId: "same", port: "service" },
				{ resourceId: "same", port: "storage" },
			],
			[{ resourceId: "api" }],
			[{ resourceId: "api", port: "service", features: [""] }],
			[{ resourceId: "api", port: "service", region: "" }],
		]) {
			const raw = JSON.parse(JSON.stringify({ ...valid, resources }));
			expect(() => parseBindleDeploymentRequest(raw)).toThrow();
		}
	});
});
