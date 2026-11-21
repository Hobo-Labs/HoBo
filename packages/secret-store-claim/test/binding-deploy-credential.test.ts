import { describe, expect, it } from "vitest";
import {
	RELAY_DEPLOY_CREDENTIAL_SECRET_PATH,
	secretStoreDeployCredentialProjectId,
	secretStoreDeployCredentialSecretPath,
} from "../src/index.js";

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
		expect(path.startsWith(`${"/hobo-ci-relay"}/`)).toBe(false);
	});
});
