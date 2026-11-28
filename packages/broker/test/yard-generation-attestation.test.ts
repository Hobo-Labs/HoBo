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
	requireAttestation: boolean | string | number | null | undefined,
	lockedProperties: readonly string[] | string | null | undefined,
) {
	const policy = {
		...DEFAULT_YARD_GENERATION_POLICY,
		effect: "allow-if-no-match",
		requireApproval: false,
		requireAttestation,
		lockedProperties,
	};
	return planYardGeneration({
		ownerTenantId: "tenant",
		requestedLayout: parseYardLayout({ providerId: "local" }),
		runtimeCatalog: runtimes.snapshot(),
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exercise malformed policy values at the public runtime boundary.
		policy: policy as never,
		allowGenerationRequested: true,
		attemptId: "attempt:attestation",
	});
}

describe("Yard generation attestation and locked properties", () => {
	it("refuses generation requiring unavailable attestation", () => {
		const result = decide(true, []);
		expect(result.allowed).toBe(false);
		if (result.allowed) throw new Error("unattested generation was planned");
		expect(result.reason).toMatch(/attestation/i);
	});

	it("requires an explicit false attestation setting", () => {
		for (const value of [undefined, null, "false", 0]) {
			expect(decide(value, []).allowed, String(value)).toBe(false);
		}
	});

	it("refuses unverified locked properties", () => {
		for (const value of [["region"], ["__proto__"], undefined, null, ""]) {
			expect(decide(false, value).allowed, String(value)).toBe(false);
		}
	});

	it("accepts an otherwise eligible explicitly unconstrained policy", () => {
		expect(decide(false, []).allowed).toBe(true);
	});

	it("rejects generated nonempty locked-property lists", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string(), { minLength: 1, maxLength: 4 }),
				(properties) => {
					expect(decide(false, properties).allowed).toBe(false);
				},
			),
			{ seed: 614_595, numRuns: 40 },
		);
	});
});
