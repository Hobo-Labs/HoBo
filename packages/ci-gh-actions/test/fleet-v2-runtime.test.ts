import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStrictFleetRuntime } from "../src/fleet-v2/runtime.js";

const roots: string[] = [];
const policy = {
	accountId: "account-1",
	engineId: "gh-actions",
	installationId: 10,
	profileId: "trusted-linux-x64",
	runnerGroupId: 7,
	requiredLabels: ["self-hosted", "trusted-linux-x64"],
	repositories: [{ id: 101, name: "owner/repository" }],
};

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hobo-strict-fleet-runtime-"));
	roots.push(root);
	const policies = join(root, "policies.json");
	writeFileSync(policies, JSON.stringify([policy]));
	return { root, policies };
}

describe("strict fleet runtime", () => {
	it("stays disabled without database and policy configuration", async () => {
		expect(
			await createStrictFleetRuntime({}, { requirePostgres: false }),
		).toBeUndefined();
	});

	it("loads policies and initializes a local strict store", async () => {
		const { root, policies } = fixture();
		const runtime = await createStrictFleetRuntime(
			{
				HOBO_CI_STRICT_FLEET_DATABASE: join(root, "fleet.sqlite"),
				HOBO_CI_STRICT_FLEET_POLICIES_FILE: policies,
			},
			{ requirePostgres: false },
		);
		expect(runtime?.policies).toEqual([
			expect.objectContaining({
				accountId: "account-1",
				installationId: 10,
				repositories: [{ id: 101, name: "owner/repository" }],
			}),
		]);
		expect(await runtime?.store.currentIncarnation()).toBeUndefined();
		await runtime?.close();
	});

	it("requires complete configuration and PostgreSQL for hosted mode", async () => {
		const { root, policies } = fixture();
		await expect(
			createStrictFleetRuntime(
				{ HOBO_CI_STRICT_FLEET_POLICIES_FILE: policies },
				{ requirePostgres: false },
			),
		).rejects.toThrow("configured together");
		await expect(
			createStrictFleetRuntime(
				{
					HOBO_CI_STRICT_FLEET_DATABASE: join(root, "fleet.sqlite"),
					HOBO_CI_STRICT_FLEET_POLICIES_FILE: policies,
				},
				{ requirePostgres: true },
			),
		).rejects.toThrow("requires PostgreSQL");
	});

	it("rejects ambiguous policy identities", async () => {
		const { root, policies } = fixture();
		writeFileSync(policies, JSON.stringify([policy, policy]));
		await expect(
			createStrictFleetRuntime(
				{
					HOBO_CI_STRICT_FLEET_DATABASE: join(root, "fleet.sqlite"),
					HOBO_CI_STRICT_FLEET_POLICIES_FILE: policies,
				},
				{ requirePostgres: false },
			),
		).rejects.toThrow("unique identities");
	});
});
