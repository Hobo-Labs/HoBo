import * as sdk from "@1password/sdk";
import { createTrustedVault } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { onePasswordStoreAuth, openSecretStore } from "../src/secret-stores.js";
import { ONE_PASSWORD_TEST_TOKEN } from "./support/onepassword-service-account.js";

const VAULT = "a".repeat(26);
const TOKEN = ONE_PASSWORD_TEST_TOKEN;
const NOW = Date.parse("2026-01-03T00:00:00.000Z");
const EXPIRES_AT = new Date(NOW + 60_000).toISOString();
const ACCOUNT = "owner@example.test";

describe("onePasswordStoreAuth", () => {
	it("keeps an attested service-account lease ahead of a desktop account name", () => {
		expect(
			onePasswordStoreAuth({
				accountName: ACCOUNT,
				connectHost: false,
				attestedServiceAccount: true,
			}),
		).toEqual({ authMode: "service-account", accountName: undefined });
	});

	it("uses the desktop app only when that is the sole sign-in", () => {
		expect(
			onePasswordStoreAuth({
				accountName: ACCOUNT,
				connectHost: false,
				attestedServiceAccount: false,
			}),
		).toEqual({ authMode: "desktop-app", accountName: ACCOUNT });
		expect(
			onePasswordStoreAuth({
				accountName: ACCOUNT,
				connectHost: true,
				attestedServiceAccount: false,
			}),
		).toEqual({ authMode: "service-account", accountName: undefined });
		expect(
			onePasswordStoreAuth({
				accountName: "",
				connectHost: false,
				attestedServiceAccount: false,
			}),
		).toEqual({ authMode: "service-account", accountName: undefined });
	});
});

type RecordedOnePasswordSignIn = {
	auth: unknown;
	desktop: string[];
	loaded: number;
};

describe("openSecretStore 1Password credentials", () => {
	function recordingSdk() {
		const seen: RecordedOnePasswordSignIn = {
			auth: undefined,
			desktop: [],
			loaded: 0,
		};
		class DesktopAuth {
			readonly accountName: string;
			constructor(accountName: string) {
				this.accountName = accountName;
				seen.desktop.push(accountName);
			}
		}
		return {
			seen,
			async load() {
				seen.loaded += 1;
				// SAFETY: ItemCategory and ItemFieldType stay the real SDK enums; only sign-in is replaced.
				return {
					...sdk,
					DesktopAuth,
					async createClient(config: { readonly auth: unknown }) {
						seen.auth = config.auth;
						return {
							items: {
								list: async () => [],
								get: async () => {
									throw new Error("unused");
								},
								create: async () => {
									throw new Error("unused");
								},
								put: async () => {
									throw new Error("unused");
								},
							},
						};
					},
				} as typeof sdk;
			},
		};
	}

	it("opens the SDK with the attested service-account token when a desktop account is also configured", async () => {
		const signIn = createTrustedVault();
		signIn.put("OP_SERVICE_ACCOUNT_TOKEN", TOKEN);
		const recorder = recordingSdk();
		const bindings: {
			authMode?: string;
			accountName?: string;
		}[] = [];
		const opened = await openSecretStore(
			"1password",
			{
				OP_VAULT_ID: VAULT,
				OP_ACCOUNT: ACCOUNT,
				OP_SERVICE_ACCOUNT_EXPIRES_AT: EXPIRES_AT,
			},
			signIn,
			{
				validateOnePasswordServiceAccount: async () => true,
				now: () => NOW,
				loadOnePasswordSdk: () => recorder.load(),
				observeOnePasswordAuth: (auth) => {
					bindings.push(auth);
				},
			},
		);
		expect(opened.ok).toBe(true);
		expect(recorder.seen.loaded).toBe(1);
		expect(recorder.seen.desktop).toEqual([]);
		expect(recorder.seen.auth).toBe(TOKEN);
		expect(bindings).toEqual([{ vaultId: VAULT, authMode: "service-account" }]);
		expect(JSON.stringify(opened)).not.toContain(TOKEN);
		signIn.clear();
	});

	it("uses DesktopAuth when the desktop account is the only sign-in", async () => {
		const signIn = createTrustedVault();
		const recorder = recordingSdk();
		const bindings: { authMode?: string; accountName?: string }[] = [];
		const opened = await openSecretStore(
			"1password",
			{ OP_VAULT_ID: VAULT, OP_ACCOUNT: ACCOUNT },
			signIn,
			{
				now: () => NOW,
				loadOnePasswordSdk: () => recorder.load(),
				observeOnePasswordAuth: (auth) => {
					bindings.push(auth);
				},
			},
		);
		expect(opened.ok).toBe(true);
		expect(recorder.seen.desktop).toEqual([ACCOUNT]);
		expect(recorder.seen.auth).toEqual({ accountName: ACCOUNT });
		expect(bindings).toEqual([
			{ vaultId: VAULT, authMode: "desktop-app", accountName: ACCOUNT },
		]);
		signIn.clear();
	});

	it("does not treat a desktop account name as the Connect credential", async () => {
		const signIn = createTrustedVault();
		signIn.put("OP_CONNECT_TOKEN", "handed-over-connect-token");
		const recorder = recordingSdk();
		const bindings: { authMode?: string; accountName?: string }[] = [];
		const opened = await openSecretStore(
			"1password",
			{
				OP_VAULT_ID: VAULT,
				OP_ACCOUNT: ACCOUNT,
				OP_CONNECT_HOST: "https://connect.example",
			},
			signIn,
			{
				now: () => NOW,
				loadOnePasswordSdk: () => recorder.load(),
				observeOnePasswordAuth: (auth) => {
					bindings.push(auth);
				},
			},
		);
		expect(opened.ok).toBe(true);
		expect(recorder.seen.loaded).toBe(0);
		expect(recorder.seen.desktop).toEqual([]);
		expect(bindings).toEqual([{ vaultId: VAULT, authMode: "service-account" }]);
		signIn.clear();
	});

	it("does not open the SDK with DesktopAuth when the retained service account is refused", async () => {
		const signIn = createTrustedVault();
		signIn.put("OP_SERVICE_ACCOUNT_TOKEN", TOKEN);
		const recorder = recordingSdk();
		const opened = await openSecretStore(
			"1password",
			{
				OP_VAULT_ID: VAULT,
				OP_ACCOUNT: ACCOUNT,
				OP_SERVICE_ACCOUNT_EXPIRES_AT: "2000-01-01T00:00:00.000Z",
			},
			signIn,
			{
				now: () => NOW,
				loadOnePasswordSdk: () => recorder.load(),
				observeOnePasswordAuth: () => {
					throw new Error("binding should not be recorded");
				},
			},
		);
		expect(opened.ok).toBe(false);
		expect(recorder.seen.loaded).toBe(0);
		expect(JSON.stringify(opened)).not.toContain(TOKEN);
		signIn.clear();
	});
});
