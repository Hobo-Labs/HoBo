import { createTrustedVault, type TrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { loadOwnerDeployCredentials } from "../src/owner-deploy-credentials.js";

describe("owner deploy credentials", () => {
	it("uses the selected store and clears only its temporary copy of the owner session", async () => {
		const session = createTrustedVault();
		session.put("BWS_ACCESS_TOKEN", "synthetic-sign-in");
		session.put("BW_CLIENTID", "synthetic-client");
		session.put("BW_CLIENTSECRET", "synthetic-secret");
		session.put("BITWARDEN_ORG_KEY", "synthetic-key");
		session.put("UNRELATED_SECRET", "do-not-copy");
		const credentials = createTrustedVault();
		const port = createMemorySecretsPort({ id: "memory" });
		await port.put("HOBO_CD_VERCEL_TOKEN", "synthetic-deploy-token");
		await port.put("HOBO_CD_VERCEL_TEAM_ID", "team_test");
		let temporary: TrustedVault | undefined;
		const opened = await loadOwnerDeployCredentials({
			cwd: "/tmp",
			env: {},
			credentials,
			ownerSession: session,
			open: async (vault) => {
				temporary = vault;
				expect(vault.reveal("BWS_ACCESS_TOKEN")).toBe("synthetic-sign-in");
				expect(vault.reveal("BW_CLIENTID")).toBe("synthetic-client");
				expect(vault.reveal("BW_CLIENTSECRET")).toBe("synthetic-secret");
				expect(vault.reveal("BITWARDEN_ORG_KEY")).toBe("synthetic-key");
				expect(vault.has("UNRELATED_SECRET")).toBe(false);
				return {
					chosen: true,
					opened: {
						id: "bitwarden",
						port,
						reference: () => {
							throw new Error("private coordinates must not be read");
						},
					},
				};
			},
		});
		expect(opened).toBe(true);
		expect(credentials.reveal("VERCEL_TOKEN")).toBe("synthetic-deploy-token");
		expect(credentials.reveal("VERCEL_TEAM_ID")).toBe("team_test");
		expect(temporary?.names()).toEqual([]);
		expect(session.reveal("BWS_ACCESS_TOKEN")).toBe("synthetic-sign-in");
		session.clear();
		credentials.clear();
	});

	it("does not use an unchosen store or reveal a provider failure", async () => {
		const credentials = createTrustedVault();
		const port = createMemorySecretsPort({ id: "memory" });
		await port.put("HOBO_CD_VERCEL_TOKEN", "synthetic-deploy-token");
		expect(
			await loadOwnerDeployCredentials({
				cwd: "/tmp",
				env: {},
				credentials,
				open: async () => ({
					chosen: false,
					opened: { id: "1password", port, reference: () => "private" },
				}),
			}),
		).toBe(false);
		expect(credentials.has("VERCEL_TOKEN")).toBe(false);
		expect(
			await loadOwnerDeployCredentials({
				cwd: "/tmp",
				env: {},
				credentials,
				open: async () => {
					throw new Error("private-store-coordinate");
				},
			}),
		).toBe(false);
	});

	it("opens a headless owner-selected store through the real store interface", async () => {
		const credentials = createTrustedVault();
		const ownerSession = createTrustedVault();
		ownerSession.put("BWS_ACCESS_TOKEN", "synthetic-store-sign-in");
		const port = createMemorySecretsPort({ id: "memory" });
		await port.put("HOBO_CD_VERCEL_TOKEN", "synthetic-deploy-token");
		let selected = "";
		const loaded = await loadOwnerDeployCredentials({
			cwd: "/tmp",
			env: { HOBO_SECRET_STORE: "bitwarden" },
			credentials,
			ownerSession,
			ownerSettings: { read: async () => ({}), write: async () => {} },
			openStore: async (id, _coordinates, signIn) => {
				selected = id;
				expect(signIn.reveal("BWS_ACCESS_TOKEN")).toBe(
					"synthetic-store-sign-in",
				);
				return {
					ok: true,
					store: { id, port, reference: () => "private-store-coordinate" },
				};
			},
		});
		expect(loaded).toBe(true);
		expect(selected).toBe("bitwarden");
		expect(credentials.reveal("VERCEL_TOKEN")).toBe("synthetic-deploy-token");
		ownerSession.clear();
		credentials.clear();
	});

	it("opens an owner-selected workload store without a retained sign-in", async () => {
		const credentials = createTrustedVault();
		const port = createMemorySecretsPort({ id: "memory" });
		await port.put("HOBO_CD_VERCEL_TOKEN", "synthetic-deploy-token");
		let selected = "";
		const loaded = await loadOwnerDeployCredentials({
			cwd: "/tmp",
			env: {
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "fixture-owner-project",
				INFISICAL_IDENTITY_ID: "fixture-workload-identity",
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example.test/request",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-workload-token",
			},
			credentials,
			ownerSettings: { read: async () => ({}), write: async () => {} },
			openStore: async (id) => {
				selected = id;
				return {
					ok: true,
					store: { id, port, reference: () => "private-store-coordinate" },
				};
			},
		});
		expect(loaded).toBe(true);
		expect(selected).toBe("infisical");
		expect(credentials.reveal("VERCEL_TOKEN")).toBe("synthetic-deploy-token");
		credentials.clear();
	});

	it.each([
		{
			store: "bitwarden",
			signIn: "BWS_ACCESS_TOKEN",
			settings: { HOBO_SECRET_STORE: "bitwarden" },
		},
		{
			store: "infisical",
			signIn: "INFISICAL_TOKEN",
			settings: {
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "selected-project",
			},
		},
	])("honors a session-selected $store over inherited coordinates", async ({
		store,
		signIn,
		settings,
	}) => {
		const credentials = createTrustedVault();
		const session = createTrustedVault();
		session.put(signIn, "synthetic-session-sign-in");
		const port = createMemorySecretsPort({ id: "memory" });
		await port.put("HOBO_CD_VERCEL_TOKEN", "synthetic-deploy-token");
		const ownerSettings = {
			hasSessionChoice: () => true,
			read: async () => settings,
			write: async () => {},
		};
		let opened = false;
		expect(
			await loadOwnerDeployCredentials({
				cwd: "/tmp",
				env: {
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "inherited-project",
					INFISICAL_IDENTITY_ID: "inherited-identity",
					BWS_PROJECT_ID: "inherited-bitwarden-project",
				},
				credentials,
				ownerSession: session,
				ownerSettings,
				openStore: async (id, coordinates) => {
					opened = true;
					expect(id).toBe(store);
					expect(coordinates.INFISICAL_IDENTITY_ID).toBeUndefined();
					expect(coordinates.BWS_PROJECT_ID).toBeUndefined();
					if (store === "infisical")
						expect(coordinates.INFISICAL_PROJECT_ID).toBe("selected-project");
					return {
						ok: true,
						store: { id, port, reference: () => "private-coordinate" },
					};
				},
			}),
		).toBe(true);
		expect(opened).toBe(true);
		credentials.clear();
		session.clear();
	});
});
