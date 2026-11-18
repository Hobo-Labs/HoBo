import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	buildDeploymentRequestFromParts,
	createLocalHostCatalog,
	createYardInventory,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	matchYard,
	parseBindleDeploymentRequest,
	parseYardLayout,
	prepareYardHostingWork,
	resolveBindleDeployment,
	YARD_EVENTS,
	yardEvent,
} from "../src/index.js";
import { cloneAsJson } from "../src/json.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";

const base = buildDeploymentRequestFromParts({
	bindleName: "shop",
	yardId: "yard:main",
	providerId: LOCAL_HOST_PROVIDER_ID,
	resources: [],
});
function input(tag: string) {
	const yard = localYardInstance({
		yardId: "yard:main",
		ownerTenantId: "local",
		providerId: LOCAL_HOST_PROVIDER_ID,
		residency: [tag],
		regions: ["eu-west-1"],
	});
	const request = {
		...base,
		yard: {
			...base.yard,
			requestedLayout: parseYardLayout({
				...base.yard.requestedLayout,
				residency: [tag],
			}),
		},
	};
	const inventory = createYardInventory("broker:test");
	inventory.apply({ type: "yard.Registered", yard });
	return { request, yard, inventory: inventory.snapshot() };
}

describe("Yard residency attestation validation", () => {
	it.each([
		"atlantis",
		"unknown:eu",
		"pii:atlantis",
		":eu",
		"pii:",
	])("rejects invalid %s even if the Yard repeats it", (tag) => {
		const item = input(tag);
		const decision = matchYard(item.request.yard, item.inventory, {
			ownerTenantId: "local",
		});
		expect(decision.outcome).toBe("rejected");
		expect(decision.candidates[0]?.hardFailures).toContain(
			`residency-invalid:${tag}`,
		);
	});

	it("accepts a valid explicit classification and jurisdiction attestation", () => {
		const item = input("pii:eu");
		expect(
			matchYard(item.request.yard, item.inventory, { ownerTenantId: "local" })
				.outcome,
		).toBe("existing-yard");
	});

	it.each([
		"atlantis",
		"unknown:eu",
		"pii:atlantis",
	])("refuses invalid %s before preparing a quote", (tag) => {
		const item = input(tag);
		expect(() =>
			parseBindleDeploymentRequest(cloneAsJson(item.request)),
		).toThrow(/invalid tag/);
		expect(() =>
			prepareYardHostingWork({
				request: item.request,
				brokerId: "broker:test",
				ownerTenantId: "local",
				catalog: createLocalHostCatalog(),
				yardId: item.yard.yardId,
				providerId: LOCAL_HOST_PROVIDER_ID,
			}),
		).toThrow(/invalid tag/);
	});

	it("rejects generated invalid jurisdiction names even when explicitly asserted", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				const tag = `invalid-jurisdiction-${value}`;
				const item = input(tag);
				const decision = matchYard(item.request.yard, item.inventory, {
					ownerTenantId: "local",
				});
				expect(decision.outcome).toBe("rejected");
				expect(decision.candidates[0]?.hardFailures).toContain(
					`residency-invalid:${tag}`,
				);
			}),
			{ seed: 614_583, numRuns: 100 },
		);
	});

	it("does not ask the host to authorize invalid attestation", async () => {
		const item = input("atlantis");
		let approvals = 0;
		const result = await resolveBindleDeployment(item.request, {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			seedLocalYard: false,
			priorEvents: [
				yardEvent(YARD_EVENTS.Registered, { yard: item.yard }),
				yardEvent(YARD_EVENTS.Ready, { yardId: item.yard.yardId }),
			],
			authorizeLocalHosting: (context) => {
				approvals++;
				return approveLocalHosting(context);
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(approvals).toBe(0);
	});
});
