import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	type OpenedSecretStore,
	ownerStore,
	ownerStoreSessionEnvironment,
} from "../src/index.js";

describe("owner store continuity", () => {
	it("strips inherited store env once the session is marked chosen", async () => {
		let chosen = false;
		const locator = {
			hasSessionChoice: () => chosen,
			markSessionChosen: () => {
				chosen = true;
			},
			read: async () => ({ HOBO_SECRET_STORE: "infisical" }),
			write: async () => undefined,
		};
		locator.markSessionChosen();
		const inheritedStore = "HOBO_SECRET_STORE";
		const inheritedProject = "BWS_PROJECT_ID";
		const env = await ownerStoreSessionEnvironment(
			{ locator },
			{
				[inheritedStore]: "bitwarden",
				BWS_ACCESS_TOKEN: "ambient-credential",
				[inheritedProject]: "inherited-bitwarden-project",
			},
		);
		expect(env).toEqual({});
	});

	it("re-checks the owner selection after reading its settings", async () => {
		let current = true;
		await expect(
			ownerStoreSessionEnvironment(
				{
					locator: {
						hasSessionChoice: () => true,
						assertCurrent: () => {
							if (!current) throw new Error("owner selection changed");
						},
						read: async () => {
							current = false;
							return {};
						},
						write: async () => undefined,
					},
				},
				{ BWS_ACCESS_TOKEN: "ambient-credential" },
			),
		).rejects.toThrow("owner selection changed");
	});

	it("marks a committed write uncertain when the post-write selection check fails", async () => {
		let current = true;
		let uncertain = false;
		const port = createMemorySecretsPort({ id: "memory" });
		const store: OpenedSecretStore = {
			id: "infisical",
			port: {
				...port,
				put: async (name, value) => {
					await port.put(name, value);
					current = false;
				},
			},
			reference: (name) => `infisical://project/prod/hobo-cd/${name}`,
		};
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "synthetic-infisical-token");
		const opened = await ownerStore("cd", vault, {
			locator: {
				hasSessionChoice: () => true,
				assertCurrent: () => {
					if (!current) throw new Error("owner selection changed");
				},
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "project",
				}),
				write: async () => undefined,
				runStoreWrite: async <T>(operation: () => Promise<T>): Promise<T> =>
					operation(),
				markUncertainWrite: () => {
					uncertain = true;
				},
			},
			openStore: async () => ({ ok: true, store }),
		});
		await expect(opened.opened?.port.put("NAME", "value")).rejects.toThrow(
			"owner selection changed",
		);
		expect(uncertain).toBe(true);
		expect((await port.access("NAME")).material).toBe("value");
	});
});
