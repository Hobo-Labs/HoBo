import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
	type ProviderStub,
	verifyPact,
} from "@hobo/contract-harness";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	createKubectlKubernetesClient,
	createOciRuntimeHost,
} from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("runtime-oci-host provider verification", () => {
	it("real host satisfies composition-root pact via kubectl pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const hostPact = pacts.find((p) => p.provider.name === "RuntimeOciHost");
		const clusterPact = pacts.find(
			(p) => p.provider.name === "KubernetesClusterApi",
		);
		expect(hostPact).toBeDefined();
		expect(clusterPact).toBeDefined();

		const clusterMock = createMockProviderFromPact(must(clusterPact));
		const k8s = createKubectlKubernetesClient({
			namespace: "hobo-dev",
			transport: clusterMock,
		});
		const host = createOciRuntimeHost({
			kubernetes: k8s,
			namespace: "hobo-dev",
		});

		const provider: ProviderStub = {
			name: "RuntimeOciHost",
			async handle(request) {
				if (request.path === "/runtime-host/ensure") {
					const body = (request.body ?? {}) as { hoboHome?: string };
					const result = await host.ensure({
						hoboHome: body.hoboHome ?? "/tmp/hobo-home",
					});
					return {
						status: 200,
						body: {
							kind: result.kind,
							ready: result.ready,
							mode: result.details?.mode,
							isolateBoundary: "kubernetes_oci",
						},
					};
				}
				if (request.path === "/runtime-host/serve-private") {
					const hoboHome = await mkdtemp(join(tmpdir(), "hobo-oci-prov-"));
					try {
						const wasmPath = join(hoboHome, "guest.wasm");
						await writeFile(wasmPath, Buffer.from("\0asm\x01\x00\x00\x00api"));
						const serve = await host.servePrivate({
							hoboHome,
							projectDir: hoboHome,
							bindleEnv: { GREETING_PREFIX: "howdy" },
							privateComponents: [
								{
									resourceName: "api",
									projectDir: hoboHome,
									wasmPath,
								},
							],
						});
						const isolation = {
							kind: serve.kind,
							isolateBoundary: serve.isolation.isolateBoundary,
							privateSandboxes: serve.isolation.privateSandboxes,
							client: serve.isolation.details?.client,
						};
						await serve.close();
						return { status: 200, body: isolation };
					} finally {
						await rm(hoboHome, { recursive: true, force: true });
					}
				}
				return { status: 404, body: { error: "unknown path" } };
			},
		};

		const report = await verifyPact(must(hostPact), provider);
		expect(report.ok, JSON.stringify(report.failures)).toBe(true);
	});
});
