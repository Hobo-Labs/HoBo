import { describe, expect, it } from "vitest";

import {
	ContractIrValidationError,
	checkCompatibility,
	createBoundaryContract,
	isCompatible,
	parseBoundaryContract,
} from "../src/contract-ir.js";

describe("Contract IR", () => {
	it("parses a boundary contract and content-addresses it", () => {
		const contract = createBoundaryContract();
		expect(contract.schemaVersion).toBe("hobo.contract-ir/v1");
		expect(contract.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		// deterministic hash for identical content
		expect(createBoundaryContract().contractHash).toBe(contract.contractHash);
	});

	it("rejects a malformed contract with a typed error", () => {
		expect(() =>
			parseBoundaryContract({
				id: "",
				version: "1.0.0",
				edge: {},
				requiredLayout: {},
			}),
		).toThrow(ContractIrValidationError);
		expect(() =>
			parseBoundaryContract({
				id: "c",
				version: "not-semver",
				edge: {
					kind: "event",
					producer: "a",
					consumer: "b",
					channel: "ch",
					operation: "op",
				},
				requiredLayout: { format: "json", requiredFields: ["id"] },
			}),
		).toThrow(/invalid-semver/);
	});

	it("reports two revisions with an added field as COMPATIBLE", () => {
		const prev = createBoundaryContract({ version: "1.0.0" });
		const next = createBoundaryContract({
			version: "1.1.0",
			requiredLayout: {
				format: "json-schema",
				requiredFields: ["id", "tenantId"],
				providedFields: ["id", "tenantId", "currency"],
			},
		});
		const result = checkCompatibility(prev, next);
		expect(isCompatible(result)).toBe(true);
		expect(result.kind).toBe("compatible");
	});

	it("detects a removed required field as a BREAKING change with reasons", () => {
		const prev = createBoundaryContract({
			version: "1.0.0",
			requiredLayout: {
				format: "json-schema",
				requiredFields: ["id", "tenantId"],
				providedFields: ["id", "tenantId"],
			},
		});
		// api@v3 removed tenantId — the exact skew the design calls out.
		const next = createBoundaryContract({
			version: "3.0.0",
			requiredLayout: {
				format: "json-schema",
				requiredFields: ["id"],
				providedFields: ["id"],
			},
		});
		const result = checkCompatibility(prev, next);
		expect(result.kind).toBe("breaking");
		if (result.kind !== "breaking") throw new Error("expected breaking");
		expect(result.reasons[0]?.code).toBe("required-field-removed");
		expect(result.reasons[0]?.fields).toContain("tenantId");
		expect(result.reasons[0]?.message).toMatch(/tenantId/);
	});

	it("flags a major-version regression", () => {
		const prev = createBoundaryContract({ version: "2.0.0" });
		const next = createBoundaryContract({ version: "1.0.0" });
		const result = checkCompatibility(prev, next);
		expect(result.kind).toBe("breaking");
		if (result.kind !== "breaking") throw new Error("expected breaking");
		expect(
			result.reasons.some((reason) => reason.code === "version-regressed"),
		).toBe(true);
	});
});
