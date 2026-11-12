// Recorded compliance → OSCAL assessment results (plan 0024 D25). The OSCAL
// document itself is validated against the pinned OSCAL 1.1.2 schema in
// packages/policy/test/posture; here the mapping from the journal is checked.
import { describe, expect, it } from "vitest";
import { RemediationMode } from "../../src/_generated/cd_pb.js";
import {
	complianceOscal,
	toPostureComplianceInput,
} from "../../src/posture/index.js";
import { camp, digest, observe, railDelivery } from "./fakes.js";
import { postureHarness } from "./harness.js";

describe("OSCAL from recorded compliance", () => {
	it("maps every recorded compliance record to one OSCAL result with control findings", async () => {
		const h = postureHarness();
		const prod = camp("prod-1");
		h.inventory.add(prod);
		h.rails.byCamp.set(
			prod,
			railDelivery(digest("a"), [
				{ pack: "tls-baseline", remediation: RemediationMode.INFORM },
			]),
		);
		await observe(h.store, prod, [
			{
				resource: "api",
				kind: "http-route",
				classification: "pii",
				attributes: { "tls.min_version": "1.0" },
			},
		]);
		await h.service.tick(h.ctx());
		const records = await h.service.compliance(prod);
		const document = complianceOscal(records);
		const results = document["assessment-results"].results;
		expect(results).toHaveLength(1);
		expect(results[0]?.props).toContainEqual({
			name: "hobo-compliance-state",
			value: "noncompliant",
		});
		const sc8 = results[0]?.findings.find(
			(f) => f.target["target-id"] === "sc-8",
		);
		expect(sc8?.target.status.state).toBe("not-satisfied");
		const ac3 = results[0]?.findings.find(
			(f) => f.target["target-id"] === "ac-3",
		);
		expect(ac3?.target.status.state).toBe("satisfied");
		const [first] = records;
		if (!first) throw new Error("no compliance record");
		expect(toPostureComplianceInput(first).findings[1]?.state).toBe(
			"noncompliant",
		);
	});

	it("refuses an empty export with a typed error", () => {
		expect(() => complianceOscal([])).toThrowError(
			expect.objectContaining({ code: "posture-oscal-empty" }),
		);
	});
});
