import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cloneAsJson } from "../src/json.js";
import {
	createLocalHostCatalog,
	LOCAL_HOST_PROVIDER_ID,
} from "../src/local-host.js";
import {
	buildDeploymentRequestFromParts,
	parseBindleDeploymentRequest,
	resolveBindleDeployment,
} from "../src/yard-placement/deploy.js";
import {
	type BindleDeploymentRequest,
	type CampPlacementRequest,
	contentHashOf,
} from "../src/yard-placement/types.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";

const yardId = "yard:local-main";
const camp = (
	overrides: Partial<CampPlacementRequest> = {},
): CampPlacementRequest => ({
	selectionMode: "compatible",
	layout: {
		require: [],
		prefer: [],
		labels: {},
		runtimeRequirements: [],
		envType: "production",
	},
	...overrides,
});
const request = (
	requestedCamp?: CampPlacementRequest,
): BindleDeploymentRequest => {
	const base = buildDeploymentRequestFromParts({
		bindleName: "shop",
		providerId: LOCAL_HOST_PROVIDER_ID,
		yardId,
		resources: [],
	});
	if (requestedCamp) return { ...base, camp: requestedCamp };
	return base;
};

describe("Yard Camp binding", () => {
	it("preserves the Camp layout before its request digest is authorized", async () => {
		const input = request(
			camp({
				layout: {
					id: "payments",
					env: "blue",
					envType: "production",
					require: ["secure"],
					prefer: ["fast"],
					labels: { team: "billing" },
					runtimeRequirements: ["node"],
				},
			}),
		);
		const parsed = parseBindleDeploymentRequest(input);
		expect(parsed.camp?.layout).toEqual(input.camp?.layout);
		let approvedDigest = "";
		const result = await resolveBindleDeployment(input, {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			authorizeLocalHosting: (context) => {
				approvedDigest = context.requestDigest;
				return approveLocalHosting(context);
			},
		});
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.selectedCampId).toBe(`${yardId}/camp:production`);
		expect(approvedDigest).toBe(contentHashOf(parsed));
	});

	it("keeps an explicit Camp inside the selected Yard and honors its precedence", async () => {
		for (const campId of ["camp:blue", `${yardId}/camp:blue`]) {
			const result = await resolveBindleDeployment(request(camp({ campId })), {
				brokerId: "broker:test",
				catalog: createLocalHostCatalog(),
				authorizeLocalHosting: approveLocalHosting,
			});
			expect(result.outcome).toBe("resolved");
			expect(result.receipt?.selectedCampId).toBe(`${yardId}/camp:blue`);
		}
	});

	it("refuses a foreign or malformed qualified Camp before local authorization", async () => {
		for (const campId of [
			"yard:other/camp:prod",
			`${yardId}-other/camp:prod`,
			`${yardId}/`,
			`${yardId}/camp:prod/nested`,
			"../camp:prod",
			".",
			`${yardId}/..`,
		]) {
			let approvals = 0;
			const result = await resolveBindleDeployment(request(camp({ campId })), {
				brokerId: "broker:test",
				catalog: createLocalHostCatalog(),
				authorizeLocalHosting: (context) => {
					approvals++;
					return approveLocalHosting(context);
				},
			});
			expect(result.outcome, campId).toBe("rejected");
			expect(result.reasons?.[0]?.code).toBe("camp-yard-mismatch");
			expect(result.receipt).toBeUndefined();
			expect(approvals).toBe(0);
		}
	});

	it("keeps the captured environment when the caller edits its Camp during authorization", async () => {
		const layout = {
			require: [],
			prefer: [],
			labels: {},
			runtimeRequirements: [],
			envType: "production",
		};
		const input = request(camp({ layout }));
		const result = await resolveBindleDeployment(input, {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			authorizeLocalHosting: (context) => {
				layout.envType = "staging";
				expect(context.request.camp?.layout.envType).toBe("production");
				return approveLocalHosting(context);
			},
		});
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.selectedCampId).toBe(`${yardId}/camp:production`);
	});

	it("refuses malformed Camp and environment values instead of defaulting them", () => {
		for (const requestedCamp of [
			{ campId: "" },
			{ campId: "  " },
			{ campId: 42 },
			{ layout: { envType: "" } },
			{ layout: { envType: 42 } },
			{ layout: { envType: "production/nested" } },
			{ layout: [] },
		]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({
						...request(),
						camp: requestedCamp,
					}),
				),
			).toThrow();
		}
	});

	it("uses the requested environment for generated Camp IDs", async () => {
		await fc.assert(
			fc.asyncProperty(fc.stringMatching(/^[a-z]{1,8}$/), async (envType) => {
				const result = await resolveBindleDeployment(
					request(
						camp({
							layout: {
								require: [],
								prefer: [],
								labels: {},
								runtimeRequirements: [],
								envType,
							},
						}),
					),
					{
						brokerId: "broker:test",
						catalog: createLocalHostCatalog(),
						authorizeLocalHosting: approveLocalHosting,
					},
				);
				expect(result.outcome).toBe("resolved");
				expect(result.receipt?.selectedCampId).toBe(
					`${yardId}/camp:${envType}`,
				);
			}),
			{ seed: 614534, numRuns: 30 },
		);
	});

	it("retains the development default only when no environment was requested", async () => {
		const result = await resolveBindleDeployment(request(), {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			authorizeLocalHosting: approveLocalHosting,
		});
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.selectedCampId).toBe(`${yardId}/camp:dev`);
	});
});
