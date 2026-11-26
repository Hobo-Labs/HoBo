import { describe, expect, it } from "vitest";
import * as integration from "../src/index.js";

describe("HoBo CI Cf readiness", () => {
	it("advertises implemented execution only with a supplied native context", () => {
		expect(integration.INTEGRATION_STATUS).toBe("implemented");
		expect(integration.EXECUTION_AVAILABLE).toBe(true);
		expect(integration.createCloudflareBackend).toBeTypeOf("function");
		expect(integration).not.toHaveProperty("run");
		expect(integration.getReadiness().executionAvailable).toBe(true);
	});

	it("keeps pending acceptance gates immutable for consumers", () => {
		expect(Object.isFrozen(integration.PENDING_GATES)).toBe(true);
		expect(Reflect.set(integration.PENDING_GATES, "0", "complete")).toBe(false);
		expect(integration.PENDING_GATES.join(" ")).toContain(
			"budget reservations",
		);
		expect(integration.PENDING_GATES.join(" ")).toContain("PACT");
	});

	it("returns a deeply frozen generated readiness view", () => {
		const view = integration.getReadiness();
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.pendingGates)).toBe(true);
		expect(Reflect.set(view, "executionAvailable", false)).toBe(false);
		expect(Reflect.set(view.pendingGates, "0", "complete")).toBe(false);
	});
});
