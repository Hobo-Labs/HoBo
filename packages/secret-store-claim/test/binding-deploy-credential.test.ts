import { describe, expect, it } from "vitest";
import { secretStoreDeployCredentialProjectId } from "../src/binding.js";

describe("secretStoreDeployCredentialProjectId", () => {
	it("uses deployProjectId when set", () => {
		expect(
			secretStoreDeployCredentialProjectId({
				projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				deployProjectId: "11111111-2222-3333-4444-555555555555",
			}),
		).toBe("11111111-2222-3333-4444-555555555555");
	});

	it("falls back to projectId for attach bindings", () => {
		expect(
			secretStoreDeployCredentialProjectId({
				projectId: "d08a4752-b0e7-4784-b869-ada54f20f4e6",
				deployProjectId: "",
			}),
		).toBe("d08a4752-b0e7-4784-b869-ada54f20f4e6");
	});
});