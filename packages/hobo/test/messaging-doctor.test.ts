import { describe, expect, it } from "vitest";

import { buildMessagingDoctorSection } from "../src/messaging-doctor.js";

describe("buildMessagingDoctorSection", () => {
	it("reports kafka + dapr readiness with ADR-0138 defaults", () => {
		const { report, remediation } = buildMessagingDoctorSection({});
		expect(report.adr).toBe("ADR-0138");
		expect(report.defaultRuntime).toBe("in-process-wasm");
		expect(report.daprOptional).toBe(true);
		expect(report.kafka.fidelity).toBe("simulated");
		expect(report.dapr.fidelity).toBe("simulated");
		expect(remediation.length).toBeGreaterThan(0);
		expect(remediation.some((r) => r.includes("optional dapr"))).toBe(true);
	});
});
