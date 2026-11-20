import * as sdk from "@1password/sdk";
import {
	createOnePasswordSecretsPort,
	onePasswordBinding,
} from "@hobo/adapter-1password";
import { createTrustedVault } from "@hobo/core";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { ONE_PASSWORD_SERVICE_ACCOUNT_REUSE_MS } from "../src/onepassword-access.js";
import { ownerStore } from "../src/owner-store.js";
import { openSecretStore, sdkPort } from "../src/secret-stores.js";
import { ONE_PASSWORD_TEST_TOKEN } from "./support/onepassword-service-account.js";

const VAULT = "a".repeat(26);
const NAME = "HOBO_CI_GITHUB_APP_PRIVATE_KEY";
const TOKEN = ONE_PASSWORD_TEST_TOKEN;
const NOW = Date.parse("2026-01-03T00:00:00.000Z");
const EXPIRES_AT = new Date(NOW + 60_000).toISOString();

function sdkFixture(changeOnSecondRead = false, duplicatePassword = false) {
	let current: sdk.Item = {
		id: "b".repeat(26),
		title: NAME,
		category: sdk.ItemCategory.Password,
		vaultId: VAULT,
		fields: [
			{
				id: "password",
				title: "password",
				fieldType: sdk.ItemFieldType.Concealed,
				value: "original-value",
			},
			{
				id: "key",
				title: "key",
				fieldType: sdk.ItemFieldType.SshKey,
				value: "unrelated-value",
				sectionId: "other",
				details: { type: "SshKey" },
			},
		],
		sections: [{ id: "other", title: "Other" }],
		notes: "keep these notes",
		tags: ["keep-tag"],
		websites: [],
		version: 1,
		files: [],
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-02T00:00:00Z"),
	};
	if (duplicatePassword)
		current = {
			...current,
			fields: [
				...current.fields,
				{
					id: "password",
					title: "password",
					fieldType: sdk.ItemFieldType.Concealed,
					value: "another-secret",
					sectionId: "other",
				},
			],
		};
	let reads = 0;
	const writes: sdk.Item[] = [];
	const client = sdkPort(sdk, {
		items: {
			list: async () => [{ ...current, state: sdk.ItemState.Active }],
			get: async () => {
				reads++;
				if (changeOnSecondRead && reads === 2)
					current = { ...current, version: current.version + 1 };
				return structuredClone(current);
			},
			create: async () => {
				throw new Error("unexpected create");
			},
			put: async (item) => {
				writes.push(structuredClone(item));
				current = { ...item, version: item.version + 1 };
				return structuredClone(current);
			},
		},
	});
	return { client, writes, current: () => current };
}

describe("1Password SDK bridge", () => {
	it.each([
		"ci",
		"cd",
	] as const)("opens the %s owner store using a privately held service account", async (family) => {
		const fx = sdkFixture();
		const vault = createTrustedVault();
		const validate = vi.fn(async () => true);
		vault.put("OP_SERVICE_ACCOUNT_TOKEN", TOKEN);
		const owner = await ownerStore(family, vault, {
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "1password",
					OP_VAULT_ID: VAULT,
					OP_SERVICE_ACCOUNT_EXPIRES_AT: EXPIRES_AT,
				}),
				write: async () => undefined,
			},
			validateOnePasswordServiceAccount: validate,
			now: () => NOW,
			onePasswordClient: async (_coordinates, holder) => {
				expect(holder.reveal("OP_SERVICE_ACCOUNT_TOKEN")).toBe(TOKEN);
				return fx.client;
			},
		});
		expect(owner.missing).toEqual([]);
		expect(validate).toHaveBeenCalledWith(TOKEN, VAULT);
		expect(await owner.opened?.port.access(NAME)).toMatchObject({
			status: "ok",
			material: "original-value",
		});
		expect(JSON.stringify(owner)).not.toContain(TOKEN);
		vault.clear();
	});

	it("does not treat an empty service-account credential as a sign-in", async () => {
		const vault = createTrustedVault();
		vault.put("OP_SERVICE_ACCOUNT_TOKEN", "");
		let attempted = false;
		const owner = await ownerStore("cd", vault, {
			locator: {
				read: async () => ({
					HOBO_SECRET_STORE: "1password",
					OP_VAULT_ID: VAULT,
				}),
				write: async () => undefined,
			},
			onePasswordClient: async () => {
				attempted = true;
				return sdkFixture().client;
			},
		});
		expect(owner.opened).toBeUndefined();
		expect(owner.missing.map((field) => field.name)).toContain("OP_ACCOUNT");
		expect(attempted).toBe(false);
		vault.clear();
	});

	it("refuses a valid retained token when no re-attestation validator is wired", async () => {
		const prior = getGlobalDispatcher();
		setGlobalDispatcher(
			new Agent({
				connect: (_options, callback) =>
					callback(new Error("offline fixture"), null),
			}),
		);
		try {
			const signIn = createTrustedVault();
			signIn.put("OP_SERVICE_ACCOUNT_TOKEN", TOKEN);
			const client = vi.fn(async () => sdkFixture().client);
			const opened = await openSecretStore(
				"1password",
				{ OP_VAULT_ID: VAULT, OP_SERVICE_ACCOUNT_EXPIRES_AT: EXPIRES_AT },
				signIn,
				{ now: () => NOW, onePasswordClient: client },
			);
			expect(opened.ok).toBe(false);
			expect(JSON.stringify(opened)).not.toContain(TOKEN);
			expect(client).not.toHaveBeenCalled();
			signIn.clear();
		} finally {
			setGlobalDispatcher(prior);
		}
	}, 30_000);

	it.each([
		{
			name: "an expired reuse lease",
			token: TOKEN,
			expiresAt: "2000-01-01T00:00:00.000Z",
			valid: true,
			validated: false,
		},
		{
			name: "a missing reuse lease",
			token: TOKEN,
			expiresAt: undefined,
			valid: true,
			validated: false,
		},
		{
			name: "a reuse lease beyond the maximum lifetime",
			token: TOKEN,
			expiresAt: new Date(
				NOW + ONE_PASSWORD_SERVICE_ACCOUNT_REUSE_MS + 1,
			).toISOString(),
			valid: true,
			validated: false,
		},
		{
			name: "an invalid token",
			token: "not-a-service-account",
			expiresAt: EXPIRES_AT,
			valid: true,
			validated: false,
		},
		{
			name: "failed vault-scope re-attestation",
			token: TOKEN,
			expiresAt: EXPIRES_AT,
			valid: false,
			validated: true,
		},
		{
			name: "throwing vault-scope re-attestation",
			token: TOKEN,
			expiresAt: EXPIRES_AT,
			valid: "throw",
			validated: true,
		},
	])("refuses $name before opening the SDK client when a desktop account is also configured", async (entry) => {
		const signIn = createTrustedVault();
		signIn.put("OP_SERVICE_ACCOUNT_TOKEN", entry.token);
		const validate = vi.fn(async () => {
			if (entry.valid === "throw")
				throw new Error("private validation failure");
			return entry.valid;
		});
		const client = vi.fn(async () => sdkFixture().client);
		const opened = await openSecretStore(
			"1password",
			{
				OP_VAULT_ID: VAULT,
				OP_ACCOUNT: "owner@example.test",
				...(entry.expiresAt !== undefined
					? { OP_SERVICE_ACCOUNT_EXPIRES_AT: entry.expiresAt }
					: undefined),
			},
			signIn,
			{
				validateOnePasswordServiceAccount: validate,
				now: () => NOW,
				onePasswordClient: client,
			},
		);
		expect(opened.ok).toBe(false);
		expect(JSON.stringify(opened)).not.toContain(entry.token);
		expect(client).not.toHaveBeenCalled();
		if (entry.validated) expect(validate).toHaveBeenCalledWith(TOKEN, VAULT);
		else expect(validate).not.toHaveBeenCalled();
		signIn.clear();
	});

	it("updates an existing secret while preserving the full SDK item", async () => {
		const fx = sdkFixture();
		const port = createOnePasswordSecretsPort({
			client: fx.client,
			binding: onePasswordBinding({
				vaultId: VAULT,
				authMode: "service-account",
			}),
		});
		await expect(port.put(NAME, "new-value")).resolves.toEqual({
			versionId: "2",
		});
		expect(fx.writes).toHaveLength(1);
		expect(fx.writes[0]).toMatchObject({
			notes: "keep these notes",
			tags: ["keep-tag"],
			sections: [{ id: "other", title: "Other" }],
			fields: [
				{ id: "password", value: "new-value" },
				{ id: "key", value: "unrelated-value", details: { type: "SshKey" } },
			],
		});
		expect(await port.access(NAME)).toMatchObject({
			status: "ok",
			material: "new-value",
		});
	});

	it("refuses to overwrite an item changed after the adapter read it", async () => {
		const fx = sdkFixture(true);
		const port = createOnePasswordSecretsPort({
			client: fx.client,
			binding: onePasswordBinding({
				vaultId: VAULT,
				authMode: "service-account",
			}),
		});
		await expect(port.put(NAME, "new-value")).rejects.toThrow();
		expect(fx.writes).toEqual([]);
		expect(fx.current().fields[0]?.value).toBe("original-value");
	});

	it("refuses an item with ambiguous password fields", async () => {
		const fx = sdkFixture(false, true);
		const port = createOnePasswordSecretsPort({
			client: fx.client,
			binding: onePasswordBinding({
				vaultId: VAULT,
				authMode: "service-account",
			}),
		});
		await expect(port.put(NAME, "new-value")).rejects.toThrow();
		expect(fx.writes).toEqual([]);
	});

	it("returns a reference to the actual 1Password password field", async () => {
		const fx = sdkFixture();
		for (const entry of [
			{
				coordinates: {
					OP_VAULT_ID: VAULT,
					OP_SERVICE_ACCOUNT_EXPIRES_AT: EXPIRES_AT,
				},
				token: TOKEN,
			},
			{
				coordinates: { OP_VAULT_ID: VAULT, OP_ACCOUNT: "owner@example.test" },
				token: undefined,
			},
		]) {
			const signIn = createTrustedVault();
			if (entry.token) signIn.put("OP_SERVICE_ACCOUNT_TOKEN", entry.token);
			const opened = await openSecretStore(
				"1password",
				entry.coordinates,
				signIn,
				{
					validateOnePasswordServiceAccount: async () => true,
					now: () => NOW,
					onePasswordClient: async (coordinates, credentialHolder) => {
						expect(coordinates).toEqual(entry.coordinates);
						expect(credentialHolder.reveal("OP_SERVICE_ACCOUNT_TOKEN")).toBe(
							entry.token,
						);
						return fx.client;
					},
				},
			);
			if (!opened.ok) throw new Error("store not opened");
			expect(opened.store.reference(NAME)).toBe(
				`op://${VAULT}/${NAME}/password`,
			);
			signIn.clear();
		}
	});
});
