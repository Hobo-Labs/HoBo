import { describe, expect, it } from "vitest";
import { runDurableMessagingConformance } from "../src/durable-messaging-conformance.js";

describe("durable messaging conformance runner", () => {
	it("fails every case when the provider is unavailable and closes each harness", async () => {
		let created = 0;
		let closed = 0;
		const report = await runDurableMessagingConformance(async () => {
			created++;
			return {
				connect: async () => {
					throw new Error("private-provider-diagnostic");
				},
				restart: async () => {},
				close: async () => {
					closed++;
				},
				nowMs: () => 1000,
				advanceMs: async () => {},
				loseNextMutationResponse: async () => {},
				rejectNextDeadLetterWrite: async () => {},
				blockNextReceiptLookup: async () => {},
			};
		});
		const cases = Object.values(report.cases);
		expect(cases.length).toBeGreaterThanOrEqual(14);
		expect(cases.every((entry) => entry.status === "fail")).toBe(true);
		expect(
			cases.every(
				(entry) => entry.detail === "provider threw or returned malformed data",
			),
		).toBe(true);
		expect(closed).toBe(created);
		expect(created).toBe(cases.length);
		expect(JSON.stringify(report)).not.toContain("private-provider-diagnostic");
	});
});
