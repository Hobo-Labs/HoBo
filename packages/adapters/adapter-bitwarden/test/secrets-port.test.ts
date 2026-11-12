import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
	BitwardenError,
	bitwardenBinding,
	createBitwardenSecretsPort,
} from "../src/index.js";
import { createFakeBitwarden } from "./support/fake-bitwarden.js";

const binding = bitwardenBinding({
	organizationId: "11111111-1111-4111-8111-111111111111",
	projectId: "22222222-2222-4222-8222-222222222222",
});

describe("the bitwarden SecretsPort", () => {
	it("creates, reads and updates one secret per key in the bound project", async () => {
		const fake = createFakeBitwarden();
		const port = createBitwardenSecretsPort({ client: fake.client, binding });
		expect(port.kind).toBe("bitwarden");
		await port.put("HOBO_CI_VALKEY_URL", "synthetic-1");
		await port.put("HOBO_CI_VALKEY_URL", "synthetic-2");
		expect(fake.secrets.size).toBe(1);
		const read = await port.access("HOBO_CI_VALKEY_URL");
		expect(read).toMatchObject({ status: "ok", material: "synthetic-2" });
		expect(binding.apiUrl).toBe("https://api.bitwarden.com");
	});

	it("ignores the same key in another project", async () => {
		const fake = createFakeBitwarden();
		fake.seed({
			id: "99999999-9999-4999-8999-999999999999",
			key: "HOBO_CI_VALKEY_URL",
			value: "other-project",
			note: "",
			organizationId: "11111111-1111-4111-8111-111111111111",
			projectId: "99999999-9999-4999-8999-999999999990",
			revisionDate: "2026-11-12T00:00:00.000Z",
		});
		const port = createBitwardenSecretsPort({ client: fake.client, binding });
		expect(await port.access("HOBO_CI_VALKEY_URL")).toMatchObject({
			status: "denied",
			code: "secret-not-found",
		});
	});

	it("never carries the SDK's error text, which may quote a value", async () => {
		const port = createBitwardenSecretsPort({
			binding,
			client: {
				secrets: () => ({
					list: async () => {
						throw new Error("boom synthetic-secret-value");
					},
					get: async () => {
						throw new Error("unused");
					},
					create: async () => {
						throw new Error("unused");
					},
					update: async () => {
						throw new Error("unused");
					},
				}),
			},
		});
		const result = await port.access("HOBO_CI_VALKEY_URL");
		expect(result).toMatchObject({
			status: "denied",
			code: "bitwarden-unavailable",
		});
		expect(inspect(result)).not.toContain("synthetic-secret-value");
	});

	it("refuses a binding that is not one", () => {
		expect(() =>
			bitwardenBinding({
				organizationId: "nope",
				projectId: "22222222-2222-4222-8222-222222222222",
			}),
		).toThrow(BitwardenError);
		expect(() =>
			bitwardenBinding({
				organizationId: "11111111-1111-4111-8111-111111111111",
				projectId: "22222222-2222-4222-8222-222222222222",
				apiUrl: "http://api.bitwarden.com",
			}),
		).toThrow(BitwardenError);
	});
});
