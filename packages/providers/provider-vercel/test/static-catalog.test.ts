import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";
import {
	createVercelProvider,
	createVercelStaticDeployDefinition,
	semanticsToSelectionCandidate,
	staticDeployment,
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
	vercelResolverRegistry,
	vercelYardSpec,
} from "../src/index.js";
import { isJsonArray, isJsonObject } from "../src/json.js";

describe("executable Vercel static hosting catalog", () => {
	it("publishes the actual immutable deployment product and static capabilities", () => {
		const manifest = createVercelProvider().capabilityManifest();
		if (
			!isJsonObject(manifest.capabilities) ||
			!isJsonArray(manifest.capabilities.capabilities)
		)
			throw new Error("manifest missing capabilities");
		const compute = manifest.capabilities.capabilities.find(
			(c) => isJsonObject(c) && c.port === "compute",
		);
		if (!isJsonObject(compute)) throw new Error("missing compute");
		expect(compute.productId).toBe(VERCEL_STATIC_DEPLOY_PRODUCT_ID);
		expect(compute.features).toContain("static");
		expect(compute.features).not.toContain("ssr");
		expect(
			createVercelProvider()
				.capabilities.find((c) => c.port === "compute")
				?.satisfies({ port: "compute", features: ["ssr"] }),
		).toEqual({ kind: "partial", missing: ["ssr"] });
	});
	it("default web allocation names the runnable deployment rather than a project control record", () => {
		const binding = staticDeployment({ projectId: "prj_owned" });
		expect(binding.productId).toBe(VERCEL_STATIC_DEPLOY_PRODUCT_ID);
		expect(binding.properties).toEqual({ projectId: "prj_owned" });
		expect(
			vercelYardSpec().bindings.find((b) => b.profile === "web.hosted/v1")
				?.productId,
		).toBe(VERCEL_STATIC_DEPLOY_PRODUCT_ID);
		expect(
			vercelResolverRegistry({ resolveCredential: async () => "material" }).get(
				binding.productId ?? "",
			)?.read,
		).toBeDefined();
	});
	it("selects the registered static definition for static hosting and refuses SSR capability inflation", () => {
		const candidate = semanticsToSelectionCandidate(
				createVercelStaticDeployDefinition({ evidenceExpiresAtMs: 2000 }),
			),
			registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES),
			policy = { ...DEFAULT_TRUST_POLICY, requireExportProfile: false };
		const select = (profileId: string) =>
			selectCapabilityImplementation({
				requirement: parseCapabilityRequirement({
					requiredProfiles: [{ profileId }],
				}),
				registry,
				candidates: [candidate],
				policy,
				nowMs: 1000,
			});
		expect(select("web.static/v1").winner?.definitionId).toBe(
			VERCEL_STATIC_DEPLOY_PRODUCT_ID,
		);
		expect(select("web.ssr/v1").winner).toBeUndefined();
	});
});
