import { describe, expect, it } from "vitest";
import {
	evaluateBindingDeliveryGate,
	isForbiddenSecretEnvKey,
	looksLikeSecretEnvValue,
} from "../src/index.js";

describe("credential delivery detection", () => {
	it.each([
		"GITHUB_TOKEN",
		"PRIVATE_KEY",
		"SERVICE_PRIVATE_KEY",
	])("rejects the credential-shaped key %s", (key) => {
		expect(isForbiddenSecretEnvKey(key)).toBe(true);
		const result = evaluateBindingDeliveryGate({
			resourceEnvs: { api: { [key]: "sample-value" } },
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("sample-value");
	});

	it.each([
		"host=db.example user=operator password=sample-value",
		"password = sample-value",
		"Server=db;Pwd=sample-value",
		"https://example.test/?pwd=sample-value",
	])("rejects credential-bearing values without exposing them", (value) => {
		expect(looksLikeSecretEnvValue(value)).toBe(true);
		const result = evaluateBindingDeliveryGate({
			resourceEnvs: { api: { SERVICE_ENDPOINT: value } },
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("sample-value");
	});

	it("keeps ordinary configuration and endpoints available", () => {
		expect(isForbiddenSecretEnvKey("MAX_OUTPUT_TOKENS")).toBe(false);
		expect(looksLikeSecretEnvValue("https://example.test/status")).toBe(false);
	});
});
