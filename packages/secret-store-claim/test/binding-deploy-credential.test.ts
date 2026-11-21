import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	formatSecretStoreBinding,
	parseSecretStoreBinding,
	RELAY_SECRET_PATH,
	readSecretStoreBinding,
	readSecretStoreBindingForRepair,
	SecretStoreBindingSchema,
} from "../src/index.js";

function bindingJson(
	fields: Readonly<Record<string, string | undefined>> = {},
): string {
	return JSON.stringify({
		kind: "infisical-cloud-attach",
		endpoint: "https://app.infisical.com",
		projectId: "relay-project",
		deployProjectId: "deploy-project",
		environment: "prod",
		secretPath: "/hobo-ci-relay",
		relayIdentityId: "relay-identity",
		deployIdentityId: "writer-identity",
		deployCredentialIdentityId: "reader-identity",
		claimBundleId: "secret-store.ci-vercel.attach-1",
		claimState: "claimed",
		deployOidcSubject:
			"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main",
		...fields,
	});
}

function legacyBindingJson(): string {
	return bindingJson({
		deployProjectId: undefined,
		deployCredentialIdentityId: undefined,
		deployOidcSubject: undefined,
	});
}

describe("deploy credential identity", () => {
	it("rejects the writer identity as the deploy credential reader", () => {
		expect(() =>
			readSecretStoreBinding(
				bindingJson({ deployCredentialIdentityId: "writer-identity" }),
			),
		).toThrow("does not meet its constraints");
	});

	it("rejects the relay identity as the deploy credential reader", () => {
		expect(() =>
			readSecretStoreBinding(
				bindingJson({ deployCredentialIdentityId: "relay-identity" }),
			),
		).toThrow("does not meet its constraints");
	});

	it("fails closed on a binding recorded before the deploy credential identity existed; only the unmarked repair read accepts it", () => {
		const legacy = legacyBindingJson();
		expect(() => readSecretStoreBinding(legacy)).toThrow(
			"does not meet its constraints",
		);
		const repaired = readSecretStoreBindingForRepair(legacy);
		expect(repaired.claimState).toBe("claimed");
		expect(repaired.deployCredentialIdentityId).toBe("");
		expect("strictParse" in repaired).toBe(false);
		expect(readSecretStoreBinding(bindingJson()).strictParse).toBe(true);
	});

	it("re-serializes a repaired binding through the strict read once the reader id and subject are recorded", () => {
		const repaired = readSecretStoreBindingForRepair(legacyBindingJson());
		const rewritten = formatSecretStoreBinding(
			parseSecretStoreBinding(
				create(SecretStoreBindingSchema, {
					...repaired,
					deployProjectId: "deploy-project",
					deployCredentialIdentityId: "reader-identity",
					deployOidcSubject:
						"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main",
				}),
			),
		);
		expect(rewritten).toContain("reader-identity");
		expect(readSecretStoreBinding(rewritten).deployCredentialIdentityId).toBe(
			"reader-identity",
		);
	});

	it("fails closed on the writer reused as reader even for repair", () => {
		expect(() =>
			readSecretStoreBindingForRepair(
				bindingJson({ deployCredentialIdentityId: "writer-identity" }),
			),
		).toThrow("does not meet its constraints");
	});
});

describe("the deploy credential's project", () => {
	it("keeps the deploy credential's coordinates apart from the relay's: another project, never the relay's folder", () => {
		const binding = readSecretStoreBinding(bindingJson());
		expect(binding.deployProjectId).not.toBe(binding.projectId);
		expect(binding.secretPath).toBe(RELAY_SECRET_PATH);
		expect(RELAY_SECRET_PATH).not.toBe("/");
	});

	it("rejects a binding without a deploy project, and one that reuses the relay's project", () => {
		expect(() =>
			readSecretStoreBinding(bindingJson({ deployProjectId: undefined })),
		).toThrow("does not meet its constraints");
		expect(() =>
			readSecretStoreBinding(
				bindingJson({ deployProjectId: "relay-project" }),
			),
		).toThrow("does not meet its constraints");
	});

	it("accepts a legacy binding without a deploy project only for the unmarked repair read", () => {
		const legacy = legacyBindingJson();
		expect(readSecretStoreBindingForRepair(legacy).deployProjectId).toBe("");
		expect(() => readSecretStoreBinding(legacy)).toThrow(
			"does not meet its constraints",
		);
	});
});
