import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	buildDeploymentRequestFromParts,
	createLocalHostCatalog,
	LOCAL_HOST_PROVIDER_ID,
	parseBindleDeploymentRequest,
	prepareYardHostingWork,
	resolveBindleDeployment,
} from "../src/index.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";

const yardId = "yard:local-main";
function input(mode: "exact" | "compatible", campId?: string) {
	const base = buildDeploymentRequestFromParts({
		bindleName: "shop",
		providerId: LOCAL_HOST_PROVIDER_ID,
		yardId,
		resources: [],
	});
	const camp = {
		selectionMode: mode,
		layout: {
			require: [],
			prefer: [],
			labels: {},
			runtimeRequirements: [],
			envType: "production",
		},
	};
	return campId === undefined
		? { ...base, camp }
		: { ...base, camp: { ...camp, campId } };
}

describe("exact Camp selection", () => {
	it("refuses an exact selection without a Camp ID during parsing", () => {
		const request = input("exact");
		expect(() => parseBindleDeploymentRequest(request)).toThrow(
			/exact.*campId/i,
		);
	});

	it("does not quote a default Camp for an exact selection without an ID", () => {
		const request = input("exact");
		expect(() =>
			prepareYardHostingWork({
				request,
				brokerId: "broker:test",
				ownerTenantId: "local",
				catalog: createLocalHostCatalog(),
				yardId,
				providerId: LOCAL_HOST_PROVIDER_ID,
			}),
		).toThrow(/exact.*campId/i);
	});

	it("does not authorize a default Camp for an exact selection without an ID", async () => {
		const request = input("exact");
		let approvals = 0;
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			authorizeLocalHosting: (context) => {
				approvals++;
				return approveLocalHosting(context);
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(approvals).toBe(0);
		expect(result.receipt).toBeUndefined();
	});

	it("retains an explicitly identified exact Camp", async () => {
		const result = await resolveBindleDeployment(input("exact", "camp:blue"), {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			authorizeLocalHosting: approveLocalHosting,
		});
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.selectedCampId).toBe(`${yardId}/camp:blue`);
	});

	it("retains compatible defaulting", () => {
		expect(
			parseBindleDeploymentRequest(input("compatible")).camp?.selectionMode,
		).toBe("compatible");
	});

	it("does not treat an arbitrary layout ID as the exact Camp ID", () => {
		fc.assert(
			fc.property(fc.string(), (id) => {
				const base = input("exact");
				const request = {
					...base,
					camp: { ...base.camp, layout: { ...base.camp.layout, id } },
				};
				expect(() => parseBindleDeploymentRequest(request)).toThrow(
					/exact.*campId/i,
				);
			}),
			{ seed: 614_585, numRuns: 100 },
		);
	});
});
