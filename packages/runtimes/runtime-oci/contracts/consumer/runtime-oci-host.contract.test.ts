import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
} from "@hobo/contract-harness";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * Composition-root consumer expectations for the oci Camp host boundary.
 * Uses the PACT mock — no kubectl process, no shell shim.
 */
describe("runtime-oci-host consumer contract", () => {
	it("composition root can drive RuntimeOciHost through pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find((p) => p.provider.name === "RuntimeOciHost");
		expect(pact).toBeDefined();

		const mock = createMockProviderFromPact(must(pact));

		const ensure = await mock.handle({
			method: "POST",
			path: "/runtime-host/ensure",
			body: { kind: "oci", hoboHome: "/tmp/hobo-home" },
		});
		expect(ensure.status).toBe(200);
		expect(ensure.body).toMatchObject({
			kind: "oci",
			ready: true,
			mode: "kubectl",
			isolateBoundary: "kubernetes_oci",
		});

		const serve = await mock.handle({
			method: "POST",
			path: "/runtime-host/serve-private",
			body: { kind: "oci", resourceName: "api", hasWasmPath: true },
		});
		expect(serve.status).toBe(200);
		expect(serve.body).toMatchObject({
			kind: "oci",
			isolateBoundary: "kubernetes_oci",
			privateSandboxes: 1,
			client: "kubectl",
		});
	});
});
