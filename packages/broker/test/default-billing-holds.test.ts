import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createBroker } from "../src/broker.js";
import {
	createLocalHostCatalog,
	defaultLocalPolicySet,
} from "../src/local-host.js";
import { createBillingPlane } from "../src/planes.js";

const billing = {
	quota: "deploy",
	quotaUsed: 0,
	quotaLimit: 100,
	budgetUsd: 10,
	spendCapUsd: 10,
};

describe("default billing holds", () => {
	it("requires a request identity before creating a hold", () => {
		const result = createBillingPlane().authorize({
			spendEstimateUsd: 1,
			billing,
		});
		expect(result.ok).toBe(false);
		expect(result.reasons[0]?.code).toBe("invalid-spend-estimate");
	});
	it("holds earlier estimates against later requests and releases only confirmed unused funds", () => {
		const plane = createBillingPlane();
		const authorize = (requestId: string, spendEstimateUsd: number) =>
			plane.authorize({ requestId, spendEstimateUsd, billing });
		expect(authorize("a", 7).ok).toBe(true);
		expect(authorize("b", 7).ok).toBe(false);
		expect(authorize("a", 7).reservationCreated).toBe(false);
		// SAFETY: Deliberately exercise the runtime boundary with an invalid caller.
		expect(() => plane.release?.("a", false as true)).toThrow();
		expect(authorize("b", 7).ok).toBe(false);
		plane.release?.("a", true);
		expect(authorize("b", 7).ok).toBe(true);
	});
	it("enforces the aggregate budget in the default broker resolution path", async () => {
		const broker = createBroker({
			policies: { ...defaultLocalPolicySet("broker:test"), billing },
			catalog: createLocalHostCatalog("test"),
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const request = {
			schemaVersion: "hobo.broker/v1",
			requestId: "a",
			scope: { bindleId: "app" },
			requirements: [{ resourceId: "api", port: "hobo:http-service" }],
			spendEstimateUsd: 7,
		};
		expect((await broker.resolve(request)).outcome).toBe("resolved");
		const second = await broker.resolve({ ...request, requestId: "b" });
		expect(second.outcome).toBe("rejected");
		expect(second.rejection?.reasons[0]?.code).toBe("budget-exceeded");
	});
	it("matches an integer-cent reference for generated request histories", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 12 }),
				fc.integer({ min: 0, max: 800 }),
				fc.integer({ min: 0, max: 200 }),
				(requests, budget, cap) => {
					const plane = createBillingPlane();
					const limits = {
						...billing,
						budgetUsd: budget / 100,
						spendCapUsd: cap / 100,
					};
					let held = 0;
					for (const [index, cents] of requests.entries()) {
						const expected = cents <= cap && held + cents <= budget;
						const result = plane.authorize({
							requestId: String(index),
							spendEstimateUsd: cents / 100,
							billing: limits,
						});
						expect(result.ok).toBe(expected);
						if (expected) held += cents;
					}
				},
			),
			{ seed: 614505, numRuns: 1000 },
		);
	});
});
