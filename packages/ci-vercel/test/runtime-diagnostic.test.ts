import { describe, expect, it } from "vitest";
import { runtimeDiagnostic } from "../src/runtime-diagnostic.js";

describe("runtime diagnostic", () => {
	it("returns only the effective Sandbox settings and deployment identifier", () => {
		expect(
			runtimeDiagnostic({
				deploymentId: "dpl_ABC123",
				sandbox: {
					allowedDomains: () => [
						"github.com",
						"*.actions.githubusercontent.com",
					],
				},
			}),
		).toEqual({
			sandboxEnabled: true,
			allowedDomains: ["github.com", "*.actions.githubusercontent.com"],
			deploymentId: "dpl_ABC123",
		});
		expect(
			runtimeDiagnostic({ deploymentId: undefined, sandbox: undefined }),
		).toEqual({
			sandboxEnabled: false,
			allowedDomains: [],
			deploymentId: null,
		});
	});

	it("never returns a malformed deployment identifier", () => {
		expect(() =>
			runtimeDiagnostic({
				deploymentId: "https://secret.example/token",
				sandbox: undefined,
			}),
		).toThrow("invalid deployment ID");
	});
});
