import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	buildDeploymentRequestFromParts,
	createLocalHostCatalog,
	LOCAL_HOST_PROVIDER_ID,
	parseBindleDeploymentRequest,
	resolveBindleDeployment,
} from "../src/index.js";
import { cloneAsJson } from "../src/json.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";

const base = buildDeploymentRequestFromParts({
	bindleName: "shop",
	providerId: LOCAL_HOST_PROVIDER_ID,
	yardId: "yard:local-main",
	resources: [],
});

describe("Yard deployment request validation", () => {
	it("requires a finite, nonnegative explicit estimate and preserves zero", () => {
		const { spendEstimateUsd: _estimate, ...missing } = base;
		for (const amount of [undefined, null, "0", -1, Number.NaN, Infinity]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({ ...missing, spendEstimateUsd: amount }),
				),
			).toThrow(/spendEstimateUsd/);
		}
		expect(
			parseBindleDeploymentRequest(
				cloneAsJson({ ...base, spendEstimateUsd: 0 }),
			).spendEstimateUsd,
		).toBe(0);
		expect(
			parseBindleDeploymentRequest(
				cloneAsJson({ ...base, spendEstimateUsd: 1.25 }),
			).spendEstimateUsd,
		).toBe(1.25);
	});

	it("rejects unrecognized explicit Yard and Camp selection modes", () => {
		for (const mode of ["excat", "", null, 1]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({ ...base, yard: { ...base.yard, selectionMode: mode } }),
				),
			).toThrow(/selectionMode/);
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({ ...base, camp: { selectionMode: mode, layout: {} } }),
				),
			).toThrow(/selectionMode/);
		}
	});

	it("uses compatible only when a selection mode is absent", () => {
		const { selectionMode: _mode, ...yard } = base.yard;
		const request = parseBindleDeploymentRequest(
			cloneAsJson({ ...base, yard, camp: { layout: {} } }),
		);
		expect(request.yard.selectionMode).toBe("compatible");
		expect(request.camp?.selectionMode).toBe("compatible");
	});

	it("refuses malformed constraints instead of dropping them", () => {
		for (const field of [
			"regions",
			"require",
			"prefer",
			"residency",
			"isolation",
			"network",
			"componentHosts",
		]) {
			for (const value of [null, "eu", ["eu", 3], [" "]]) {
				const request = {
					...base,
					yard: {
						...base.yard,
						requestedLayout: { ...base.yard.requestedLayout, [field]: value },
					},
				};
				expect(
					() => parseBindleDeploymentRequest(cloneAsJson(request)),
					`${field} ${JSON.stringify(value)}`,
				).toThrow();
			}
		}
		for (const field of ["require", "prefer", "runtimes"]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({
						...base,
						bindleRequirements: {
							...base.bindleRequirements,
							[field]: "required",
						},
					}),
				),
			).toThrow();
		}
		for (const field of ["require", "prefer", "runtimeRequirements"]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({
						...base,
						camp: { selectionMode: "compatible", layout: { [field]: [3] } },
					}),
				),
			).toThrow();
		}
	});

	it("rejects malformed label maps and nested Camp declarations", () => {
		for (const value of [null, [], { tier: 3 }]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({
						...base,
						yard: {
							...base.yard,
							requestedLayout: { ...base.yard.requestedLayout, labels: value },
						},
					}),
				),
			).toThrow();
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({
						...base,
						bindleRequirements: { ...base.bindleRequirements, labels: value },
					}),
				),
			).toThrow();
		}
		for (const camps of [null, "camp", [null], [{ require: "gpu" }]]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({
						...base,
						yard: {
							...base.yard,
							requestedLayout: { ...base.yard.requestedLayout, camps },
						},
					}),
				),
			).toThrow();
		}
		for (const requirements of [null, [], "database"]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({ ...base, bindleRequirements: requirements }),
				),
			).toThrow(/bindleRequirements/);
		}
		for (const requestedLayout of [null, [], "yard"]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({ ...base, yard: { ...base.yard, requestedLayout } }),
				),
			).toThrow(/requestedLayout/);
		}
		for (const yardId of ["", " ", 1, null]) {
			expect(() =>
				parseBindleDeploymentRequest(
					cloneAsJson({
						...base,
						yard: { ...base.yard, requestedYardId: yardId },
					}),
				),
			).toThrow(/requestedYardId/);
		}
	});

	it("never silently converts a generated unknown mode to compatible", () => {
		fc.assert(
			fc.property(
				fc
					.string()
					.filter(
						(mode) =>
							!["exact", "compatible", "compatible-or-generate"].includes(mode),
					),
				(mode) => {
					expect(() =>
						parseBindleDeploymentRequest(
							cloneAsJson({
								...base,
								yard: { ...base.yard, selectionMode: mode },
							}),
						),
					).toThrow(/selectionMode/);
				},
			),
			{ seed: 614_579, numRuns: 100 },
		);
	});

	it("refuses malformed residency before local host authorization", async () => {
		const input = {
			...base,
			yard: {
				...base.yard,
				requestedLayout: { ...base.yard.requestedLayout, residency: "eu" },
			},
		};
		let authorizations = 0;
		// SAFETY: exercise the untyped boundary with an intentionally invalid request.
		const result = await resolveBindleDeployment(input as never, {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			authorizeLocalHosting: (context) => {
				authorizations++;
				return approveLocalHosting(context);
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(result.reasons?.[0]?.code).toBe("invalid-deployment-request");
		expect(authorizations).toBe(0);
	});
});
