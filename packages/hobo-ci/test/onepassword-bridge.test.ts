import * as sdk from "@1password/sdk";
import {
	createOnePasswordSecretsPort,
	onePasswordBinding,
} from "@hobo/adapter-1password";
import { describe, expect, it } from "vitest";
import { openSecretStore, sdkPort } from "../src/secret-stores.js";

const VAULT = "a".repeat(26);
const NAME = "HOBO_CI_GITHUB_APP_PRIVATE_KEY";

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
		for (const env of [
			{ OP_VAULT_ID: VAULT, OP_SERVICE_ACCOUNT_TOKEN: "fixture" },
			{ OP_VAULT_ID: VAULT, OP_ACCOUNT: "owner@example.test" },
		]) {
			const opened = await openSecretStore("1password", env, {
				onePasswordClient: async () => fx.client,
			});
			if (!opened.ok) throw new Error("store not opened");
			expect(opened.store.reference(NAME)).toBe(
				`op://${VAULT}/${NAME}/password`,
			);
		}
	});
});
