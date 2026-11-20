import { describe, expect, it } from "vitest";

import { createVercelProvider } from "../src/index.js";

describe("Vercel schedule port", () => {
	it("advertises Cron Jobs for a schedule and realizes one with the deployment", () => {
		const provider = createVercelProvider();
		const schedule = provider.capabilities.find((c) => c.port === "schedule");
		expect(schedule?.satisfies({ port: "schedule", features: [] })).toEqual({
			kind: "full",
		});
		const realized = provider.realize({
			name: "hobo-ci-repair",
			port: "schedule",
		});
		expect(JSON.stringify(realized)).toContain("vercel:cron-job");
		expect(provider.client("schedule", {}).providerService).toBe(
			"Vercel Cron Jobs",
		);
	});
});
