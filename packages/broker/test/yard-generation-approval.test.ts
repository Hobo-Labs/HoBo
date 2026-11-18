import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	contentHashOf,
	createLocalYardGenerationConnector,
	createYardRuntimeCatalog,
	DEFAULT_YARD_GENERATION_POLICY,
	parseYardLayout,
	planYardGeneration,
} from "../src/index.js";
import { rejectionMatrixRow } from "../src/rejections.js";

const connector = createLocalYardGenerationConnector();
const runtimes = createYardRuntimeCatalog();
runtimes.register({
	schemaVersion: "hobo.yard-runtime/v1",
	runtimeId: "local-yard/v1",
	providerId: "local",
	version: "1",
	supportedLayout: { regions: [], capabilities: [], requireProperties: [] },
	resolverCatalogHash: contentHashOf("resolvers"),
	generatorConnectorId: connector.id,
	default: true,
	priority: 1,
	requiredPermissions: [],
	conformanceRef: "ref",
	conformanceHash: contentHashOf("conformance"),
	status: "approved",
});

function decide(
	requireApproval: boolean | string | number | null | undefined,
	effect: string | null | undefined,
) {
	const policy = {
		...DEFAULT_YARD_GENERATION_POLICY,
		effect,
		requireApproval,
		requireAttestation: false,
	};
	return planYardGeneration({
		ownerTenantId: "tenant",
		requestedLayout: parseYardLayout({ providerId: "local" }),
		runtimeCatalog: runtimes.snapshot(),
		// SAFETY: exercise malformed policy values at the public runtime boundary.
		policy: policy as never,
		allowGenerationRequested: true,
		attemptId: "attempt:1",
	});
}

describe("Yard generation approval policy", () => {
	it("refuses to plan while approval is required but unavailable", () => {
		const result = decide(true, "allow-if-no-match");
		expect(result.allowed).toBe(false);
		if (result.allowed) throw new Error("unapproved generation was planned");
		expect(result.reason).toMatch(/approval/i);
		expect(rejectionMatrixRow("yard-generation-denied")).toMatchObject({
			plane: "policy",
		});
	});

	it("accepts an otherwise eligible policy that explicitly requires no approval", () => {
		expect(decide(false, "allow-if-no-match").allowed).toBe(true);
	});

	it("does not treat missing or malformed approval settings as permission", () => {
		for (const value of [undefined, null, "false", 0]) {
			expect(decide(value, "allow-if-no-match").allowed, String(value)).toBe(
				false,
			);
		}
	});

	it("refuses unknown effects and unsupported dedicated-Yard policies", () => {
		for (const effect of [
			undefined,
			null,
			"allow",
			"typo",
			"require-dedicated",
		]) {
			expect(decide(false, effect).allowed, String(effect)).toBe(false);
		}
	});

	it("respects generated approval settings", () => {
		fc.assert(
			fc.property(fc.boolean(), (required) => {
				expect(decide(required, "allow-if-no-match").allowed).toBe(!required);
			}),
			{ seed: 614_594, numRuns: 40 },
		);
	});
});
