import { describe, expect, it } from "vitest";
import {
	createUsageEvent,
	parseTenantId,
	type UsageEventType,
} from "../src/index.js";

describe("metering: HoBo Fleet usage types (ADR-0182)", () => {
	const fleetTypes: readonly UsageEventType[] = [
		"fleet.member.active",
		"fleet.work.sandbox",
		"fleet.transport.relay",
		"fleet.transport.direct",
	];

	it("builds a usage event for each fleet type", () => {
		const tenantId = parseTenantId("tenant-a");
		for (const eventType of fleetTypes) {
			const event = createUsageEvent({
				tenantId,
				eventType,
				resource: `dev_${"0".repeat(32)}`,
				quantity: 3,
				unit: "seconds",
				timestamp: "2026-11-12T00:00:00.000Z",
			});
			expect(event.eventType).toBe(eventType);
			expect(event.quantity).toBe(3);
		}
	});
});
