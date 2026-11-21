import { describe, expect, it } from "vitest";
import {
	RELAY_DEPLOY_CREDENTIAL_SECRET_PATH,
	RELAY_SECRET_PATH,
	readSecretStoreBinding,
	readSecretStoreBindingForRepair,
	secretStoreDeployCredentialProjectId,
	secretStoreDeployCredentialSecretPath,
} from "../src/index.js";

function bindingJson(fields: Readonly<Record<string, string>> = {}): string {
	return JSON.stringify({
		kind: "infisical-cloud-attach",
		endpoint: "https://app.infisical.com",
		projectId: "relay-project",
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

	it("fails closed on a binding recorded before the deploy credential identity existed, and only the repair read accepts it", () => {
		const legacy = JSON.stringify({
			kind: "infisical-cloud-attach",
			endpoint: "https://app.infisical.com",
			projectId: "relay-project",
			environment: "prod",
			secretPath: "/hobo-ci-relay",
			relayIdentityId: "relay-identity",
			deployIdentityId: "writer-identity",
			claimBundleId: "secret-store.ci-vercel.attach-1",
			claimState: "claimed",
		});
		expect(() => readSecretStoreBinding(legacy)).toThrow(
			"does not meet its constraints",
		);
		expect(readSecretStoreBindingForRepair(legacy).claimState).toBe("claimed");
		expect(
			readSecretStoreBindingForRepair(legacy).deployCredentialIdentityId,
		).toBe("");
	});

	it("fails closed on the writer reused as reader even for repair", () => {
		expect(() =>
			readSecretStoreBindingForRepair(
				bindingJson({ deployCredentialIdentityId: "writer-identity" }),
			),
		).toThrow("does not meet its constraints");
	});
});

describe("secretStoreDeployCredentialProjectId", () => {
	it("prefers deployProjectId when the binding has one", () => {
		expect(
			secretStoreDeployCredentialProjectId({
				projectId: "6512a1b0-c3d4-4e5f-8071-8293a4b5c6d7",
				deployProjectId: "d08a4752-b0e7-4784-b869-ada54f20f4e6",
			}),
		).toBe("d08a4752-b0e7-4784-b869-ada54f20f4e6");
	});

	it("falls back to projectId for an attach binding without deployProjectId", () => {
		expect(
			secretStoreDeployCredentialProjectId({
				projectId: "6512a1b0-c3d4-4e5f-8071-8293a4b5c6d7",
				deployProjectId: "",
			}),
		).toBe("6512a1b0-c3d4-4e5f-8071-8293a4b5c6d7");
	});
});

describe("secretStoreDeployCredentialSecretPath", () => {
	it("keeps the deploy credential at the root of its own project", () => {
		expect(
			secretStoreDeployCredentialSecretPath({
				deployProjectId: "d08a4752-b0e7-4784-b869-ada54f20f4e6",
			}),
		).toBe("/");
	});

	it("falls back to a folder that is neither the relay project's root nor inside the relay's folder", () => {
		const path = secretStoreDeployCredentialSecretPath({
			deployProjectId: "",
		});
		expect(path).toBe(RELAY_DEPLOY_CREDENTIAL_SECRET_PATH);
		expect(path).not.toBe("/");
		expect(path).not.toBe(RELAY_SECRET_PATH);
		expect(path.startsWith(`${RELAY_SECRET_PATH}/`)).toBe(false);
	});
});
