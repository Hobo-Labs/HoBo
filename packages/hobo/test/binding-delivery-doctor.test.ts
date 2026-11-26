import { describe, expect, it } from "vitest";

import { buildBindingDeliveryDoctorSection } from "../src/binding-delivery-doctor.js";

describe("binding-delivery doctor (ADR-0141)", () => {
	it("passes when no secret-shaped env is present", () => {
		const { report, remediation } = buildBindingDeliveryDoctorSection({
			LOG_LEVEL: "info",
			PATH: "/usr/bin",
		});
		expect(report.gateOk).toBe(true);
		expect(report.membrane).toBe("wit-link-provider");
		expect(report.forbiddenEnvKeysInProcess).toEqual([]);
		expect(remediation).toEqual([]);
	});

	it("fails closed and remediates ConnectionStrings env", () => {
		const { report, remediation } = buildBindingDeliveryDoctorSection({
			ConnectionStrings__db: "postgres://u:p@host/db",
		});
		expect(report.gateOk).toBe(false);
		expect(report.forbiddenEnvKeysInProcess).toContain("ConnectionStrings__db");
		expect(remediation.some((r) => /ADR-0141/.test(r))).toBe(true);
	});
});
