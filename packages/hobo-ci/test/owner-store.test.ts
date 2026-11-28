import { OnePasswordError } from "@hobo/adapter-1password";
import { BitwardenError } from "@hobo/adapter-bitwarden";
import { InfisicalError } from "@hobo/adapter-infisical";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	InfisicalReadOnlyError,
	type OpenedSecretStore,
	ownerStore,
	ownerStoreSessionEnvironment,
	storeWriteUncertain,
} from "../src/index.js";

const UNCERTAIN_WRITES = [
	[
		"an Infisical write the provider may have taken",
		new InfisicalError("write secret", "write-uncertain"),
		true,
	],
	[
		"an Infisical write the provider refused",
		new InfisicalError("write secret", "forbidden", { status: 403 }),
		false,
	],
	[
		"an Infisical write the provider rejected",
		new InfisicalError("write secret", "rejected", { status: 400 }),
		false,
	],
	[
		"a sign-in Infisical refused before the write was sent",
		new InfisicalError("login", "login-denied", { status: 401 }),
		false,
	],
	["a write a read-only sign-in refuses", new InfisicalReadOnlyError(), false],
	[
		"a Bitwarden name refused before any request",
		new BitwardenError("secret name", "invalid-input"),
		false,
	],
	[
		"a Bitwarden write the SDK could not confirm",
		new BitwardenError("create secret", "unavailable"),
		true,
	],
	[
		"a 1Password write the SDK could not confirm",
		new OnePasswordError("create secret", "unavailable"),
		true,
	],
	["an error no store names", new TypeError("fetch failed"), true],
] as const;

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

	it.each(UNCERTAIN_WRITES)("classifies %s", (_case, error, uncertain) => {
		expect(storeWriteUncertain(error)).toBe(uncertain);
	});

	it.each(
		UNCERTAIN_WRITES,
	)("latches the owner session for %s only when the provider may have taken it", async (_case, error, uncertain) => {
		let marked = false;
		const store: OpenedSecretStore = {
			id: "infisical",
			port: {
				...createMemorySecretsPort({ id: "memory" }),
				put: async () => {
					throw error;
				},
			},
			reference: (name) => `infisical://project/prod/hobo-cd/${name}`,
		};
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "synthetic-infisical-token");
		const opened = await ownerStore("cd", vault, {
			locator: {
				hasSessionChoice: () => true,
				assertCurrent: () => undefined,
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "project",
				}),
				write: async () => undefined,
				markUncertainWrite: () => {
					marked = true;
				},
			},
			openStore: async () => ({ ok: true, store }),
		});
		await expect(opened.opened?.port.put("NAME", "value")).rejects.toThrow(
			error,
		);
		expect(marked).toBe(uncertain);
	});

	it("latches the owner session for a write that fails without an Error", async () => {
		let marked = false;
		const store: OpenedSecretStore = {
			id: "infisical",
			port: {
				...createMemorySecretsPort({ id: "memory" }),
				put: async () => {
					throw "connection lost";
				},
			},
			reference: (name) => `infisical://project/prod/hobo-cd/${name}`,
		};
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "synthetic-infisical-token");
		const opened = await ownerStore("cd", vault, {
			locator: {
				hasSessionChoice: () => true,
				assertCurrent: () => undefined,
				read: async () => ({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "project",
				}),
				write: async () => undefined,
				markUncertainWrite: () => {
					marked = true;
				},
			},
			openStore: async () => ({ ok: true, store }),
		});
		await expect(opened.opened?.port.put("NAME", "value")).rejects.toBe(
			"connection lost",
		);
		expect(marked).toBe(true);
	});
});
