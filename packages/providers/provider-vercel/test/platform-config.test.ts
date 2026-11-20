import { describe, expect, it } from "vitest";

import { vercelPlatformDrift } from "../src/index.js";

// A schedule or a queue placed on Vercel is executed by the deployment's
// vercel.json; the plan says what that file must hold.

const planned = [
	{ name: "hobo-ci", port: "queue", deps: [] },
	{
		name: "hobo-ci-repair",
		port: "schedule",
		deps: ["hobo-ci"],
		cadence: "*/15 * * * *",
	},
] as const;

const config = {
	functions: {
		"api/queue.ts": {
			experimentalTriggers: [{ type: "queue/v2beta", topic: "hobo-ci" }],
		},
	},
	schedules: {
		"hobo-ci-repair": { schedule: "*/15 * * * *", topic: "hobo-ci" },
	},
};

describe("vercelPlatformDrift", () => {
	it("is empty when vercel.json holds what the plan asks", () => {
		expect(vercelPlatformDrift(config, planned)).toEqual([]);
	});

	it("names a changed cadence, a missing consumer, and a stray schedule", () => {
		const drift = vercelPlatformDrift(
			{
				functions: {},
				schedules: {
					"hobo-ci-repair": { schedule: "0 * * * *", topic: "hobo-ci" },
					"old-tick": { schedule: "* * * * *", topic: "hobo-ci" },
				},
			},
			planned,
		);
		expect(drift).toEqual([
			"queue hobo-ci has no consumer: no function in vercel.json has a queue/v2beta trigger on topic hobo-ci",
			'vercel.json schedules.hobo-ci-repair must be { "schedule": "*/15 * * * *", "topic": "hobo-ci" }',
			"vercel.json schedules.old-tick is not in the plan; remove it or declare the schedule",
		]);
	});

	it("refuses to guess a schedule without a cadence or on a non-queue", () => {
		expect(
			vercelPlatformDrift(config, [
				planned[0],
				{ name: "hobo-ci-repair", port: "schedule", deps: ["hobo-ci"] },
				{
					name: "tick",
					port: "schedule",
					deps: ["relay"],
					cadence: "0 * * * *",
				},
			]),
		).toEqual([
			"schedule hobo-ci-repair declares no cadence; add the cadence trait",
			"schedule tick must run exactly one queue on Vercel; it runs relay",
		]);
	});
});
