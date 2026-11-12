import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
	createOnePasswordSecretsPort,
	OnePasswordError,
	onePasswordBinding,
} from "../src/index.js";
import { createFake1Password } from "./support/fake-1password.js";

const binding = onePasswordBinding({
	vaultId: "abcdefghijklmnopqrstuvwxyz",
	authMode: "desktop-app",
	accountName: "my.1password.com",
});

describe("the 1password SecretsPort", () => {
	it("creates, reads and updates one Password item per secret", async () => {
		const fake = createFake1Password(binding.vaultId);
		const port = createOnePasswordSecretsPort({ client: fake.client, binding });
		expect(port.kind).toBe("1password");
		expect(await port.put("HOBO_CI_VALKEY_URL", "synthetic-1")).toEqual({
			versionId: "1",
		});
		expect(await port.put("HOBO_CI_VALKEY_URL", "synthetic-2")).toEqual({
			versionId: "2",
		});
		const read = await port.access("HOBO_CI_VALKEY_URL");
		expect(read).toMatchObject({ status: "ok", material: "synthetic-2" });
		expect(read.status === "ok" && read.valueRef).toMatch(
			/^op:\/\/[a-z0-9]{26}\/[a-z0-9]+\/password$/u,
		);
		expect([...fake.items.values()][0]?.category).toBe("Password");
		expect(await port.listVersions("HOBO_CI_VALKEY_URL")).toEqual(["2"]);
		expect((await port.accessVersion("HOBO_CI_VALKEY_URL", "1")).status).toBe(
			"denied",
		);
	});

	it("answers not-found as a denial, and refuses names that are not keys", async () => {
		const fake = createFake1Password(binding.vaultId);
		const port = createOnePasswordSecretsPort({ client: fake.client, binding });
		expect(await port.access("MISSING")).toMatchObject({
			status: "denied",
			code: "secret-not-found",
		});
		await expect(port.put("not a key", "v")).rejects.toThrow(OnePasswordError);
	});

	it("never carries the SDK's error text, which may quote a value", async () => {
		const port = createOnePasswordSecretsPort({
			binding,
			client: {
				items: {
					list: async () => {
						throw new Error("boom synthetic-secret-value");
					},
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
			},
		});
		const result = await port.access("HOBO_CI_VALKEY_URL");
		expect(result).toMatchObject({
			status: "denied",
			code: "1password-unavailable",
		});
		expect(inspect(result)).not.toContain("synthetic-secret-value");
		// The whole message is fixed text: nothing of the SDK's survives.
		await expect(port.put("X", "v")).rejects.toThrow(
			/^1password list items failed: unavailable$/u,
		);
	});

	it("refuses a binding that is not one", () => {
		expect(() =>
			onePasswordBinding({ vaultId: "short", authMode: "service-account" }),
		).toThrow(OnePasswordError);
		expect(() =>
			onePasswordBinding({
				vaultId: "abcdefghijklmnopqrstuvwxyz",
				authMode: "desktop-app",
			}),
		).toThrow(OnePasswordError);
	});
});
