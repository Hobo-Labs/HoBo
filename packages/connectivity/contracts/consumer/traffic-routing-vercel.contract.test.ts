import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory } from "@hobo/contract-harness";
import { parseRoutingPlan } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createVercelTrafficRouting } from "../../src/index.js";
import { createPactFetch } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("VercelTrafficRoutingApi consumer contract", () => {
	it("applies rolling release, observes, and revokes through the Pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find(
			({ provider }) => provider.name === "VercelTrafficRoutingApi",
		);
		expect(pact).toBeDefined();
		if (!pact) throw new Error("Vercel TrafficRouting Pact is missing");

		const plan = parseRoutingPlan({
			planId: "plan:checkout:rr",
			intent: {
				service: "checkout",
				tenantId: "tenant-a",
				rules: [
					{
						backends: [
							{
								id: "backend:stable",
								service: "checkout",
								weight: 75,
								endpoint: "https://stable.example.test",
							},
							{
								id: "backend:canary",
								service: "checkout",
								weight: 25,
								endpoint: "https://canary.example.test",
							},
						],
						weightStrategy: "static",
					},
				],
			},
			backends: [
				{
					id: "backend:stable",
					service: "checkout",
					weight: 75,
					endpoint: "https://stable.example.test",
				},
				{
					id: "backend:canary",
					service: "checkout",
					weight: 25,
					endpoint: "https://canary.example.test",
				},
			],
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const routing = createVercelTrafficRouting({
			token: "test-token",
			projectIdOrName: "prj_checkout",
			deploymentIdsByBackend: {
				"backend:stable": "dpl_stable",
				"backend:canary": "dpl_canary",
			},
			mode: "rolling-release",
			fetchImpl: createPactFetch(pact),
		});

		await expect(routing.apply(plan)).resolves.toMatchObject({
			provider: "vercel",
			realized: "full",
			appliedRules: 1,
		});
		await expect(routing.status(plan.planId)).resolves.toMatchObject({
			active: true,
			realized: "partial",
		});
		await expect(routing.revoke(plan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
	});

	it("applies path rewrites, observes, and revokes through the Pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find(
			({ provider }) => provider.name === "VercelTrafficRoutingApi",
		);
		expect(pact).toBeDefined();
		if (!pact) throw new Error("Vercel TrafficRouting Pact is missing");

		const plan = parseRoutingPlan({
			planId: "plan:checkout:rewrites",
			intent: {
				service: "checkout",
				tenantId: "tenant-a",
				rules: [
					{
						match: { pathPrefix: "/api" },
						backends: [
							{
								id: "backend:api",
								service: "checkout-api",
								weight: 100,
								endpoint: "https://api.example.test",
							},
						],
						weightStrategy: "static",
					},
				],
			},
			backends: [
				{
					id: "backend:api",
					service: "checkout-api",
					weight: 100,
					endpoint: "https://api.example.test",
				},
			],
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const routing = createVercelTrafficRouting({
			token: "test-token",
			projectIdOrName: "prj_checkout",
			mode: "rewrites",
			fetchImpl: createPactFetch(pact),
		});

		await expect(routing.apply(plan)).resolves.toMatchObject({
			provider: "vercel",
			realized: "full",
			appliedRules: 1,
			capabilities: expect.arrayContaining([
				"path-prefix",
				"weighted-backends",
			]),
		});
		await expect(routing.status(plan.planId)).resolves.toMatchObject({
			active: true,
			realized: "full",
		});
		await expect(routing.revoke(plan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
	});
});
