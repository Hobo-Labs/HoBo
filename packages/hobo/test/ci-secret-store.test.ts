import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSecretStoreBinding } from "@hobo/secret-store-claim";
import { describe, expect, it, vi } from "vitest";
import {
	loadSecretStoreBinding,
	runCiSecretStore,
	secretStoreDeployInputs,
	writeSecretStoreBinding,
} from "../src/ci-secret-store.js";

const binding = readSecretStoreBinding(
	JSON.stringify({
		kind: "infisical-cloud-attach",
		endpoint: "https://fixture.invalid",
		projectId: "fixture-project",
		environment: "prod",
		secretPath: "/fixture",
		relayIdentityId: "fixture-relay",
		deployIdentityId: "fixture-writer",
		vercelTeamId: "team_fixture",
		claimBundleId: "fixture-claim",
		claimState: "claimed",
	}),
);

describe("hobo ci secret-store", () => {
	it("plans without provider I/O and directs the owner to private setup", async () => {
		const send = vi.fn<typeof fetch>(async () => {
			throw new Error("unexpected provider I/O");
		});
		const result = await runCiSecretStore({
			subcommand: "plan",
			cwd: "/fixture",
			values: {},
			env: {},
			interactive: false,
			prompt: async () => "",
			fetch: send,
		});
		expect(result.ok).toBe(true);
		expect(JSON.stringify(result)).toContain("HoBo setup ceremony");
		expect(JSON.stringify(result)).not.toContain("commit");
		expect(send).not.toHaveBeenCalled();
	});

	it("does not read or write a repository binding", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "hobo-secret-store-"));
		try {
			expect(loadSecretStoreBinding(cwd)).toBeUndefined();
			await expect(writeSecretStoreBinding(cwd, binding)).rejects.toMatchObject(
				{ code: "HOBO_CI_SECRET_STORE_PRIVATE_SETUP_REQUIRED" },
			);
			expect(
				existsSync(path.join(cwd, "deploy", "secret-store.binding.json")),
			).toBe(false);
			expect(Object.fromEntries(secretStoreDeployInputs(binding))).toEqual({
				INFISICAL_SITE_URL: "https://fixture.invalid",
				INFISICAL_IDENTITY_ID: "fixture-relay",
				INFISICAL_PROJECT_ID: "fixture-project",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
