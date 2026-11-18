import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	buildDeploymentRequestFromParts,
	createLocalHostCatalog,
	LOCAL_HOST_PROVIDER_ID,
	prepareYardHostingWork,
} from "../src/index.js";

function quote(requestedYardId: string | undefined, yardId: string) {
	const options = {
		bindleName: "shop",
		providerId: LOCAL_HOST_PROVIDER_ID,
		selectionMode: "exact" as const,
		resources: [],
	};
	const request = buildDeploymentRequestFromParts(
		requestedYardId === undefined
			? options
			: { ...options, yardId: requestedYardId },
	);
	return prepareYardHostingWork({
		request,
		brokerId: "broker:test",
		ownerTenantId: "local",
		catalog: createLocalHostCatalog(),
		yardId,
		providerId: LOCAL_HOST_PROVIDER_ID,
	});
}

describe("exact Yard quote binding", () => {
	it("refuses to quote a different Yard or a missing exact ID", () => {
		expect(quote("yard:requested", "yard:other")).toMatchObject({
			code: "yard-exact-id-mismatch",
		});
		expect(quote(undefined, "yard:other")).toMatchObject({
			code: "yard-exact-id-mismatch",
		});
	});

	it("allows a quote for the exact requested Yard", () => {
		expect(quote("yard:requested", "yard:requested")).toHaveProperty(
			"workDigest",
		);
	});

	it("never quotes a different generated ID as the exact request", () => {
		fc.assert(
			fc.property(fc.string(), (suffix) => {
				const requested = `yard:${suffix}`;
				const other = `yard:other-${suffix}`;
				expect(quote(requested, other)).toMatchObject({
					code: "yard-exact-id-mismatch",
				});
			}),
			{ seed: 614_589, numRuns: 100 },
		);
	});
});
