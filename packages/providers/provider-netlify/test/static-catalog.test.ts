import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";
import {
	createNetlifyProvider,
	createNetlifyStaticDeployDefinition,
	NETLIFY_DEFAULT_BINDINGS,
	NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
	netlifyResolverRegistry,
	semanticsToSelectionCandidate,
	staticDeployment,
} from "../src/index.js";
import { isJsonArray, isJsonObject } from "../src/json.js";

describe("executable Netlify static hosting catalog", () => {
	it("publishes the immutable deployment product rather than site-control readiness", () => {
		const manifest = createNetlifyProvider().capabilityManifest();
		if (
			!isJsonObject(manifest.capabilities) ||
			!isJsonArray(manifest.capabilities.capabilities)
		)
			throw new Error("manifest missing capabilities");
		const compute = manifest.capabilities.capabilities.find(
			(c) => isJsonObject(c) && c.port === "compute",
		);
		if (!isJsonObject(compute)) throw new Error("compute missing");
		expect(compute.productId).toBe(NETLIFY_STATIC_DEPLOY_PRODUCT_ID);
		expect(compute.features).toContain("static");
		expect(compute.profiles).toEqual(["web.static/v1", "web.hosted/v1"]);
	});
	it("default hosted slot resolves to an actual deployment resolver", () => {
		expect(NETLIFY_DEFAULT_BINDINGS.web[0]?.productId).toBe(
			NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
		);
		const binding = staticDeployment({ siteId: "site_owned" });
		expect(binding.properties).toEqual({ siteId: "site_owned" });
		expect(
			netlifyResolverRegistry({
				accountId: "account",
				accountSlug: "team",
				resolveCredential: async () => "material",
			}).get(binding.productId ?? "")?.read,
		).toBeDefined();
	});
	it("selects a registered static driver and refuses server-rendered/functions requirements", () => {
		const candidate = semanticsToSelectionCandidate(
				createNetlifyStaticDeployDefinition({ evidenceExpiresAtMs: 2000 }),
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
			NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
		);
		expect(select("web.ssr/v1").winner).toBeUndefined();
		expect(select("api.http/v1").winner).toBeUndefined();
	});
});
