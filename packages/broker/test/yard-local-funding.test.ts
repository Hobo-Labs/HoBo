import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
	createLocalHostCatalog,
	LOCAL_HOST_PROVIDER_ID,
} from "../src/local-host.js";
import { createLocalYardGenerationConnector } from "../src/yard-placement/connectors.js";
import {
	buildDeploymentRequestFromParts,
	resolveBindleDeployment,
	type YardFirstPlacementDeps,
} from "../src/yard-placement/deploy.js";
import { DEFAULT_YARD_GENERATION_POLICY } from "../src/yard-placement/generation.js";
import { createYardRuntimeCatalog } from "../src/yard-placement/inventory.js";
import { contentHashOf } from "../src/yard-placement/types.js";

const request = () =>
	buildDeploymentRequestFromParts({
		bindleName: "shop",
		providerId: LOCAL_HOST_PROVIDER_ID,
		resources: [{ resourceId: "api", port: "hobo:http-service", features: [] }],
	});
const common = () => ({
	brokerId: "broker:test",
	catalog: createLocalHostCatalog("test"),
});
function approved(
	input: Parameters<
		NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
	>[0],
) {
	return {
		schemaVersion: "hobo.local-hosting-proof/v1" as const,
		bindingDigest: input.bindingDigest,
		effect: "allow" as const,
		obligationsSatisfied: true as const,
		policyHash: `sha256:${"a".repeat(64)}`,
		evidenceRef: "local-policy:test",
		liabilityBoundMicros: 0 as const,
	};
}

describe("explicit local hosting authority", () => {
	it("does not infer free hosting from a local provider name and a caller zero", async () => {
		const result = await resolveBindleDeployment(request(), common());
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
	});
	it("requires bound host policy and zero-liability attestation for the selected local work", async () => {
		const req = request();
		const authorize = vi.fn(
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => {
				expect(input.requestDigest).toBe(contentHashOf(req));
				expect(input.providerId).toBe(LOCAL_HOST_PROVIDER_ID);
				expect(input.placements).toHaveLength(1);
				expect(input.placements[0].resourceId).toBe("api");
				expect(input.placements[0].providerId).toBe(LOCAL_HOST_PROVIDER_ID);
				expect(Object.isFrozen(input.placements)).toBe(true);
				expect(Object.isFrozen(input.placements[0])).toBe(true);
				return approved(input);
			},
		);
		const result = await resolveBindleDeployment(req, {
			...common(),
			authorizeLocalHosting: authorize,
		});
		expect(result.outcome).toBe("resolved");
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(result.receipt?.localHostingProof).toMatchObject({
			bindingDigest: authorize.mock.calls[0][0].bindingDigest,
			liabilityBoundMicros: 0,
		});
	});
	it("refuses absent, denied, stale, unbound or incomplete local proofs", async () => {
		const variants = [
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => ({ ...approved(input), schemaVersion: "unknown" }),
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => ({ ...approved(input), effect: "deny" as const }),
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => ({ ...approved(input), bindingDigest: "sha256:foreign" }),
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => ({ ...approved(input), obligationsSatisfied: false }),
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => ({ ...approved(input), policyHash: "" }),
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => ({ ...approved(input), evidenceRef: "" }),
			(
				input: Parameters<
					NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
				>[0],
			) => ({ ...approved(input), liabilityBoundMicros: 1 }),
			() => undefined,
			() => {
				throw new Error("authority unavailable");
			},
		];
		for (const authorizeLocalHosting of variants) {
			const deps = Object.assign(common(), { authorizeLocalHosting });
			const result = await resolveBindleDeployment(request(), deps);
			expect(result.outcome).toBe("rejected");
			expect(result.receipt).toBeUndefined();
		}
	});
	it("refuses a local policy identifier that is not a SHA-256 digest", async () => {
		const result = await resolveBindleDeployment(request(), {
			...common(),
			authorizeLocalHosting: (input) => ({
				...approved(input),
				policyHash: "not-a-digest",
			}),
		});
		expect(result.outcome).toBe("rejected");
	});
	it("refuses a local authority replaced while authorization waits", async () => {
		const replacement = (
			input: Parameters<
				NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
			>[0],
		) => approved(input);
		const deps: YardFirstPlacementDeps = {
			...common(),
			authorizeLocalHosting: async (input) => {
				Object.assign(deps, { authorizeLocalHosting: replacement });
				return approved(input);
			},
		};
		const result = await resolveBindleDeployment(request(), deps);
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
	});
	it("refuses authority changes between local admission and receipt issuance", async () => {
		const deps: YardFirstPlacementDeps = {
			...common(),
			authorizeLocalHosting: (input) => {
				queueMicrotask(() =>
					queueMicrotask(() =>
						Object.assign(deps, { ownerTenantId: "foreign" }),
					),
				);
				return approved(input);
			},
		};
		const result = await resolveBindleDeployment(request(), deps);
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
	});
	it("refuses catalog changes while local authorization waits", async () => {
		const deps: YardFirstPlacementDeps = {
			...common(),
			authorizeLocalHosting: async (input) => {
				deps.catalog.catalogHash = "sha256:changed";
				return approved(input);
			},
		};
		const result = await resolveBindleDeployment(request(), deps);
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
	});
	it.each([
		"budget",
		"broker",
		"owner",
		"catalog object",
	])("refuses a changed %s while local authorization waits", async (change) => {
		const deps: YardFirstPlacementDeps = {
			...common(),
			ownerTenantId: "local",
			authorizeLocalHosting: async (input) => {
				if (change === "budget") Object.assign(deps, { hostingBudget: {} });
				if (change === "broker")
					Object.assign(deps, { brokerId: "broker:other" });
				if (change === "owner") Object.assign(deps, { ownerTenantId: "other" });
				if (change === "catalog object")
					Object.assign(deps, { catalog: { ...deps.catalog } });
				return approved(input);
			},
		};
		const result = await resolveBindleDeployment(request(), deps);
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
	});

	it("admits only complete bound zero-liability proofs across generated cases", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					installed: fc.boolean(),
					bound: fc.boolean(),
					allowed: fc.boolean(),
					obligations: fc.boolean(),
					policy: fc.boolean(),
					evidence: fc.boolean(),
					zero: fc.boolean(),
				}),
				async (flags) => {
					const deps = common();
					if (flags.installed)
						Object.assign(deps, {
							authorizeLocalHosting: (
								input: Parameters<
									NonNullable<YardFirstPlacementDeps["authorizeLocalHosting"]>
								>[0],
							) => ({
								...approved(input),
								bindingDigest: flags.bound
									? input.bindingDigest
									: "sha256:foreign",
								effect: flags.allowed ? "allow" : "deny",
								obligationsSatisfied: flags.obligations,
								policyHash: flags.policy ? `sha256:${"a".repeat(64)}` : "",
								evidenceRef: flags.evidence ? "evidence:test" : "",
								liabilityBoundMicros: flags.zero ? 0 : 1,
							}),
						});
					const result = await resolveBindleDeployment(request(), deps);
					const expected = Object.values(flags).every(Boolean);
					expect(result.outcome).toBe(expected ? "resolved" : "rejected");
					if (expected)
						expect(
							result.receipt?.localHostingProof?.liabilityBoundMicros,
						).toBe(0);
				},
			),
			{ seed: 614524, numRuns: 160 },
		);
	});

	it("does not use local placement approval to fund generation", async () => {
		const runtimes = createYardRuntimeCatalog();
		const connector = createLocalYardGenerationConnector();
		const provision = vi.spyOn(connector, "provision");
		runtimes.register({
			schemaVersion: "hobo.yard-runtime/v1",
			runtimeId: "local-yard/v1",
			providerId: "local",
			version: "1",
			supportedLayout: { regions: [], capabilities: [], requireProperties: [] },
			resolverCatalogHash: contentHashOf("r"),
			generatorConnectorId: connector.id,
			default: true,
			priority: 1,
			requiredPermissions: [],
			conformanceRef: "ref",
			conformanceHash: contentHashOf("c"),
			status: "approved",
		});
		const generationPolicy = {
			...DEFAULT_YARD_GENERATION_POLICY,
			id: "allow-local",
			effect: "allow-if-no-match" as const,
			allowedProviderIds: ["local"],
			allowedRuntimeIds: ["local-yard/v1"],
			allowedConnectorIds: [connector.id],
			maxConcurrentGenerations: 1,
			maxYardsPerTenant: 1,
			requireApproval: false,
			requireAttestation: false,
		};
		const req = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: "local",
			selectionMode: "compatible-or-generate",
			allowGeneration: true,
			resources: [],
		});
		const authorize = vi.fn(approved);
		const result = await resolveBindleDeployment(req, {
			...common(),
			seedLocalYard: false,
			runtimeCatalog: runtimes,
			generationPolicy,
			connectors: new Map([[connector.id, connector]]),
			authorizeLocalHosting: authorize,
		});
		expect(result.outcome).toBe("rejected");
		expect(result.reasons?.[0]?.code).toBe("hosting-budget-admission-denied");
		expect(authorize).not.toHaveBeenCalled();
		expect(provision).not.toHaveBeenCalled();
	});
});
