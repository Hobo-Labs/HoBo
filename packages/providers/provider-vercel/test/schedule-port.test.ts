import { describe, expect, it } from "vitest";

import { createVercelProvider } from "../src/index.js";

describe("Vercel schedule port", () => {
	it("advertises deployment-owned schedules and refuses bare realize", () => {
		const provider = createVercelProvider();
		const schedule = provider.capabilities.find((c) => c.port === "schedule");
		expect(schedule?.satisfies({ port: "schedule", features: [] })).toEqual({
			kind: "full",
		});
		expect(() => provider.realize({ name: "tick", port: "schedule" })).toThrow(
			/deployment-component resolver/u,
		);
		expect(provider.client("schedule", {}).providerService).toBe(
			"Vercel Schedules",
		);
	});
});