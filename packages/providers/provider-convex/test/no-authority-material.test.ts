/**
 * An admin key cannot be rotated, so a single leak into a serialized event,
 * receipt, plan, fixture, or snapshot permanently compromises that
 * deployment. This suite is the guard: it drives real sagas (happy path and
 * failure paths) and scans everything they produce.
 */
import { describe, expect, it } from "vitest";

import {
	CONVEX_HOSTING_FORMS,
	selfHostedConfigRefs,
} from "../src/hosting-forms.js";
import {
	assertNoAuthorityMaterial,
	type BackendRef,
	type ConvexMigrationDriver,
	looksLikeAuthorityMaterial,
	parseAuthorityRef,
	runStrongClaim,
	StrongClaimSecretLeakError,
	type VerificationSummary,
} from "../src/strong-claim.js";

/** Shapes taken from the official deploy-key documentation. */
const ADMIN_KEY_SAMPLE = "bold-hyena-681|01c2aaaabbbbccccdddd0c09c";
const PROD_DEPLOY_KEY_SAMPLE = "prod:qualified-jaguar-123|eyJ2MTIzNDU2Nzg5MD0=";
const PREVIEW_DEPLOY_KEY_SAMPLE =
	"preview:team-slug:project-slug|eyJ2MTIzNDU2Nz0=";

const K0 = parseAuthorityRef("secretref://hobo/convex/b0/k0");
const K1 = parseAuthorityRef("secretref://hobo/convex/b1/k1");

const B0: BackendRef = {
	backendId: "b0-temporary",
	hostingFormId: "convex.local-accountless/v1",
	url: "http://127.0.0.1:3210",
	authorityRef: K0,
};

const B1: BackendRef = {
	backendId: "b1-owned",
	hostingFormId: "convex.selfhosted-oci/v1",
	url: "https://convex.example.hobo.test",
	authorityRef: K1,
};

const ALL_GREEN: VerificationSummary = {
	documentCountsMatch: true,
	sampledHashesMatch: true,
	filesMatch: true,
	indexesReady: true,
	httpActionsRouting: true,
	websocketHealthy: true,
	authConfigMatches: true,
	appHealthy: true,
};

function driver(
	overrides: Partial<ConvexMigrationDriver> = {},
): ConvexMigrationDriver {
	return {
		provisionDestination: async () => B1,
		deployCodeAndConfig: async () => ({ configKeys: ["CONVEX_SITE_ORIGIN"] }),
		quiesceSource: async () => ({ fenceToken: "fence-7" }),
		export: async () => ({
			artifactRef: "artifact://snapshot_1",
			documentCount: 1,
			fileCount: 1,
		}),
		import: async () => ({ ok: true }),
		verify: async () => ALL_GREEN,
		cutover: async () => ({ ok: true, connectorId: "connector-app" }),
		awaitRollbackWindow: async () => ({ rollback: false }),
		destroy: async () => ({ ok: true, destroyedBackendId: B0.backendId }),
		...overrides,
	};
}

describe("no admin key material anywhere", () => {
	it("recognizes the documented Convex key shapes", () => {
		expect(looksLikeAuthorityMaterial(ADMIN_KEY_SAMPLE)).toBe(true);
		expect(looksLikeAuthorityMaterial(PROD_DEPLOY_KEY_SAMPLE)).toBe(true);
		expect(looksLikeAuthorityMaterial(PREVIEW_DEPLOY_KEY_SAMPLE)).toBe(true);
		expect(looksLikeAuthorityMaterial("secretref://hobo/convex/b1/k1")).toBe(
			false,
		);
		expect(looksLikeAuthorityMaterial("CONVEX_SELF_HOSTED_ADMIN_KEY")).toBe(
			false,
		);
	});

	it("throws when a leak is nested anywhere in a payload", () => {
		expect(() =>
			assertNoAuthorityMaterial(
				{ receipt: { notes: [{ detail: ADMIN_KEY_SAMPLE }] } },
				"a test payload",
			),
		).toThrow(StrongClaimSecretLeakError);
		expect(() =>
			assertNoAuthorityMaterial(
				{ ok: true, refs: [K0, K1] },
				"a clean payload",
			),
		).not.toThrow();
	});

	it("emits no key material across the happy path", async () => {
		const result = await runStrongClaim({
			claimId: "claim-clean",
			source: B0,
			destinationHostingFormId: "convex.selfhosted-oci/v1",
			rollbackWindowMs: 1,
			driver: driver(),
		});
		expect(result.ok).toBe(true);

		for (const event of result.events) {
			expect(looksLikeAuthorityMaterial(JSON.stringify(event))).toBe(false);
		}
		expect(looksLikeAuthorityMaterial(JSON.stringify(result.receipt))).toBe(
			false,
		);
		expect(looksLikeAuthorityMaterial(JSON.stringify(result.state))).toBe(
			false,
		);
	});

	it("emits no key material across failure paths either", async () => {
		const results = await Promise.all([
			runStrongClaim({
				claimId: "claim-import-fail",
				source: B0,
				destinationHostingFormId: "convex.selfhosted-oci/v1",
				rollbackWindowMs: 1,
				driver: driver({
					import: async () => ({
						ok: false,
						reason: `import rejected for deployment ${B0.backendId}`,
					}),
				}),
			}),
			runStrongClaim({
				claimId: "claim-throw",
				source: B0,
				destinationHostingFormId: "convex.selfhosted-oci/v1",
				rollbackWindowMs: 1,
				driver: driver({
					cutover: async () => {
						throw new Error("connector write refused");
					},
				}),
			}),
		]);

		for (const result of results) {
			expect(result.ok).toBe(false);
			expect(looksLikeAuthorityMaterial(JSON.stringify(result.events))).toBe(
				false,
			);
			expect(looksLikeAuthorityMaterial(JSON.stringify(result.receipt))).toBe(
				false,
			);
		}
	});

	it("refuses to accept a driver-supplied destination carrying key material", () => {
		expect(() => parseAuthorityRef(ADMIN_KEY_SAMPLE)).toThrow(
			StrongClaimSecretLeakError,
		);
	});

	it("keeps the hosting-form descriptors free of secrets", () => {
		expect(
			looksLikeAuthorityMaterial(JSON.stringify(CONVEX_HOSTING_FORMS)),
		).toBe(false);
		for (const ref of selfHostedConfigRefs()) {
			expect(Object.keys(ref)).not.toContain("value");
		}
	});
});
