import { describe, expect, it } from "vitest";

import {
	buildDeploymentRequestFromParts,
	parseBindleDeploymentRequest,
} from "../src/index.js";

const SCHEMA = "hobo.bindle-deployment-request/v1";

const resources = [
	{ resourceId: "api", port: "api", features: ["http"] },
] as never;

type RequestOverrides = Partial<{
	schemaVersion: string;
	requestId: string | undefined;
	bindleName: string | undefined;
	yard: object | undefined;
	resources: object | undefined;
	provider: string;
	providerId: string;
	bindleRequirements: object;
}>;

const request = (overrides: RequestOverrides = {}) => ({
	schemaVersion: SCHEMA,
	requestId: "req-1",
	bindleName: "shop",
	yard: { selectionMode: "compatible" },
	resources,
	...overrides,
});

const build = (
	overrides: Partial<
		Parameters<typeof buildDeploymentRequestFromParts>[0]
	> = {},
) =>
	buildDeploymentRequestFromParts({
		bindleName: "shop",
		resources,
		...overrides,
	} as never);

describe("the provider-selection refusal", () => {
	it("refuses a bindle-level provider", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ provider: "aws" })),
		).toThrow(/bindle-provider-selection-forbidden/u);
	});

	it("refuses the providerId spelling too", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ providerId: "aws" })),
		).toThrow(/bindle-provider-selection-forbidden/u);
	});

	it("refuses it even when the value is empty", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ provider: "" })),
		).toThrow(/bindle-provider-selection-forbidden/u);
	});

	it("tags the refusal with its own code", () => {
		const error = (() => {
			try {
				parseBindleDeploymentRequest(request({ provider: "aws" }));
			} catch (err) {
				return err as { code?: string };
			}
			return null;
		})();
		expect(error?.code).toBe("bindle-provider-selection-forbidden");
	});

	it("says where the provider does belong", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ provider: "aws" })),
		).toThrow(/Yard placement request/u);
	});

	it("allows a provider inside the yard placement request", () => {
		expect(() =>
			parseBindleDeploymentRequest(
				request({
					yard: {
						selectionMode: "compatible",
						requestedLayout: { providerId: "aws" },
					},
				}),
			),
		).not.toThrow();
	});
});

describe("structural refusals", () => {
	it.each([
		null,
		undefined,
		7,
		"request",
		true,
	])("refuses the non-object input %s", (input) => {
		expect(() => parseBindleDeploymentRequest(input)).toThrow(TypeError);
	});

	it("refuses an array", () => {
		expect(() => parseBindleDeploymentRequest([])).toThrow(
			/must be an object/u,
		);
	});

	it("refuses an unknown schema version rather than migrating it", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ schemaVersion: `${SCHEMA}x` })),
		).toThrow(/schemaVersion must be/u);
	});

	it("refuses a missing request id", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ requestId: undefined })),
		).toThrow(/requestId required/u);
	});

	it("refuses an empty request id", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ requestId: "" })),
		).toThrow(/requestId required/u);
	});

	it("refuses a missing bindle name", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ bindleName: undefined })),
		).toThrow(/bindleName required/u);
	});

	it("refuses a request with no yard placement", () => {
		expect(() =>
			parseBindleDeploymentRequest(request({ yard: undefined })),
		).toThrow(/yard placement request required/u);
	});
});

describe("what the parse fills in", () => {
	it("derives a yard request id from the bindle request id", () => {
		const parsed = parseBindleDeploymentRequest(request());
		expect(parsed.yard.requestId).toContain("req-1");
	});

	it("keeps an explicit yard request id", () => {
		const parsed = parseBindleDeploymentRequest(
			request({ yard: { selectionMode: "compatible", requestId: "yard-9" } }),
		);
		expect(parsed.yard.requestId).toBe("yard-9");
	});

	it("defaults generation to refused rather than permitted", () => {
		expect(
			parseBindleDeploymentRequest(request()).yard.allowGenerationRequested,
		).toBe(false);
	});

	it("requires an exact true to permit generation", () => {
		const truthy = parseBindleDeploymentRequest(
			request({
				yard: { selectionMode: "compatible", allowGenerationRequested: "yes" },
			}),
		);
		expect(truthy.yard.allowGenerationRequested).toBe(false);
	});

	it("permits generation when asked explicitly", () => {
		const parsed = parseBindleDeploymentRequest(
			request({
				yard: { selectionMode: "compatible", allowGenerationRequested: true },
			}),
		);
		expect(parsed.yard.allowGenerationRequested).toBe(true);
	});

	it("defaults empty requirement lists rather than leaving them undefined", () => {
		const parsed = parseBindleDeploymentRequest(request());
		expect(parsed.bindleRequirements.require).toEqual([]);
		expect(parsed.bindleRequirements.prefer).toEqual([]);
		expect(parsed.bindleRequirements.runtimes).toEqual([]);
	});

	it("keeps the requirements it was given", () => {
		const parsed = parseBindleDeploymentRequest(
			request({
				bindleRequirements: {
					require: ["managed-postgres"],
					prefer: ["eu-region"],
					runtimes: ["wasm"],
					labels: { tier: "prod" },
				},
			}),
		);
		expect(parsed.bindleRequirements.require).toEqual(["managed-postgres"]);
		expect(parsed.bindleRequirements.labels).toEqual({ tier: "prod" });
	});

	it("defaults resources to an empty list rather than throwing", () => {
		expect(
			parseBindleDeploymentRequest(request({ resources: undefined })).resources,
		).toEqual([]);
	});

	it("keeps a resource's declared features", () => {
		const parsed = parseBindleDeploymentRequest(request());
		expect(parsed.resources[0]?.features).toEqual(["http"]);
	});

	it("defaults a resource's features to empty", () => {
		const parsed = parseBindleDeploymentRequest(
			request({ resources: [{ resourceId: "api", port: "api" }] }),
		);
		expect(parsed.resources[0]?.features).toEqual([]);
	});

	it("omits a region a resource did not state", () => {
		// An empty region string would be matched against, and match nothing.
		const parsed = parseBindleDeploymentRequest(request());
		expect(parsed.resources[0]).not.toHaveProperty("region");
	});

	it("keeps a resource's region when stated", () => {
		const parsed = parseBindleDeploymentRequest(
			request({
				resources: [{ resourceId: "api", port: "api", region: "eu-west-1" }],
			}),
		);
		expect(parsed.resources[0]?.region).toBe("eu-west-1");
	});

	it("freezes the parsed request", () => {
		expect(Object.isFrozen(parseBindleDeploymentRequest(request()))).toBe(true);
	});

	it("freezes the yard placement inside it", () => {
		expect(Object.isFrozen(parseBindleDeploymentRequest(request()).yard)).toBe(
			true,
		);
	});
});

describe("buildDeploymentRequestFromParts", () => {
	it("produces a request the parser accepts", () => {
		expect(() => parseBindleDeploymentRequest(build())).not.toThrow();
	});

	it("gives every build a distinct request id", () => {
		expect(build().requestId).not.toBe(build().requestId);
	});

	it("correlates the yard request id with the bindle one", () => {
		const built = build();
		expect(built.yard.requestId).toContain(built.requestId);
	});

	it("asks for an exact yard when one is named", () => {
		expect(build({ yardId: "yard:a" }).yard.selectionMode).toBe("exact");
	});

	it("allows generation-or-compatible when no yard is named", () => {
		expect(build().yard.selectionMode).toBe("compatible-or-generate");
	});

	it("honours an explicit selection mode over both defaults", () => {
		expect(
			build({ yardId: "yard:a", selectionMode: "compatible" }).yard
				.selectionMode,
		).toBe("compatible");
	});

	it("carries a named yard through as the requested one", () => {
		expect(build({ yardId: "yard:a" }).yard.requestedYardId).toBe("yard:a");
	});

	it("declares local component hosts for a local deploy", () => {
		expect([...build().yard["requestedLayout"].componentHosts].sort()).toEqual([
			"local",
			"oci",
			"wasm",
		]);
	});

	it("sorts the component hosts, so the shape hashes deterministically", () => {
		const hosts = [...build().yard["requestedLayout"].componentHosts];
		expect(hosts).toEqual([...hosts].sort());
	});

	it.each([
		"local",
		"@hobo/provider-local-host",
	])("treats %s as local", (providerId) => {
		expect(
			build({ providerId }).yard["requestedLayout"].componentHosts.length,
		).toBeGreaterThan(0);
	});

	it("declares no component hosts for a cloud provider", () => {
		expect(
			build({ providerId: "aws" }).yard["requestedLayout"].componentHosts,
		).toEqual([]);
	});

	it("puts the provider on the yard shape, not on the bindle", () => {
		const built = build({ providerId: "aws" }) as { yard: object };
		expect(built).not.toHaveProperty("provider");
		expect(built).not.toHaveProperty("providerId");
		expect(built.yard).toHaveProperty("requestedLayout");
	});

	it("defaults generation to refused", () => {
		expect(build().yard.allowGenerationRequested).toBe(false);
	});

	it("permits generation when asked", () => {
		expect(build({ allowGeneration: true }).yard.allowGenerationRequested).toBe(
			true,
		);
	});

	it("defaults the objective to minimum cost", () => {
		expect((build() as { objective?: string }).objective).toBe("min-cost");
	});

	it("honours a stated objective", () => {
		expect(
			(build({ objective: "min-latency" }) as { objective?: string }).objective,
		).toBe("min-latency");
	});

	it("defaults the owner tenant to local", () => {
		expect((build() as { ownerTenantId?: string }).ownerTenantId).toBe("local");
	});

	it("honours a stated owner tenant", () => {
		expect(
			(
				build({ ownerTenantId: "acme" }) as {
					ownerTenantId?: string;
				}
			).ownerTenantId,
		).toBe("acme");
	});

	it("derives a manifest hash from the bindle name when none is given", () => {
		expect(build().manifestHash).toMatch(/^sha256:/u);
	});

	it("gives two differently named bindles different manifest hashes", () => {
		expect(build({ bindleName: "a" }).manifestHash).not.toBe(
			build({ bindleName: "b" }).manifestHash,
		);
	});

	it("carries the resources it was given", () => {
		expect(build().resources[0]?.resourceId).toBe("api");
	});
});
