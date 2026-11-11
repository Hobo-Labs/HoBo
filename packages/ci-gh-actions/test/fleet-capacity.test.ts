import { fleetCapacityVariableValue } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { createFleetCapacityPublisher } from "../src/fleet-capacity.js";

describe("fleet capacity publisher", () => {
	it("writes a compact JSON snapshot when the value changes", async () => {
		const writes: { method: string; path: string; body?: string }[] = [];
		const publisher = createFleetCapacityPublisher({
			github: {
				request: async (_installationId, path, method, body) => {
					writes.push({ method: method ?? "GET", path, body });
					return new Response(
						method === "POST" || method === "PATCH" ? "" : "{}",
						{ status: method === "PATCH" ? 404 : 201 },
					);
				},
			},
		});
		const outcome = await publisher.publish({
			installationId: 1,
			repository: "Hobo-Labs/HoBo",
			hoboFreeSlots: 2,
			arcFreeSlots: 1,
			at: "2026-11-11T02:00:00.000Z",
		});
		expect(outcome).toBe("published");
		expect(writes.some((entry) => entry.method === "POST")).toBe(true);
		const body = writes.find((entry) => entry.body)?.body;
		expect(body).toBeDefined();
		// SAFETY: test asserts the publisher POST body is JSON with a string value field.
		const payload = JSON.parse(body ?? "{}") as { value: string };
		expect(JSON.parse(payload.value).admittedParallel).toBe(3);
		expect(fleetCapacityVariableValue(JSON.parse(payload.value))).toBe(
			payload.value,
		);
	});
});
