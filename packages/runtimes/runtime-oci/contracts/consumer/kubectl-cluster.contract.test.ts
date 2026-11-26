import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	createMockProviderFromPact,
	loadPactDirectory,
} from "@hobo/contract-harness";
import { must, mustGet } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	createKubectlKubernetesClient,
	createOciRuntimeHost,
} from "../../src/index.js";
import { packWasmAsOci } from "../../src/oci-pack.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("kubectl-cluster consumer contract (PACT mock)", () => {
	it("RuntimeOciHost drives KubernetesClusterApi through pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find((p) => p.provider.name === "KubernetesClusterApi");
		expect(pact).toBeDefined();

		const mock = createMockProviderFromPact(must(pact));
		const k8s = createKubectlKubernetesClient({
			namespace: "hobo-dev",
			transport: mock,
		});

		const probe = await k8s.probe();
		expect(probe.ready).toBe(true);
		expect(probe.clusterReachable).toBe(true);
		expect(probe.clientVersion).toBe("v1.28.0");

		await k8s.apply([
			{ kind: "Deployment", metadata: { name: "api" } },
			{ kind: "Service", metadata: { name: "api" } },
		]);
		await k8s.waitReady("api");
		const pf = await k8s.portForward("api", 8080);
		expect(pf.loopbackUrl).toBe("http://127.0.0.1:18080");

		const proxied = await k8s.httpProxy({
			service: "api",
			method: "GET",
			path: "/hello?name=Oci",
		});
		expect(proxied.status).toBe(200);
		expect(proxied.json).toEqual({
			message: "howdy, Oci",
			greetingPrefix: "howdy",
		});

		await k8s.delete("api");

		const inventory = await checkPactInventory(contractsDir);
		expect(inventory.ok).toBe(true);
	});

	it("oci host ensure + servePrivate mesh hop via pact-backed client", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find((p) => p.provider.name === "KubernetesClusterApi");
		expect(pact).toBeDefined();
		const mock = createMockProviderFromPact(must(pact));
		const k8s = createKubectlKubernetesClient({
			namespace: "hobo-dev",
			transport: mock,
		});
		const host = createOciRuntimeHost({
			kubernetes: k8s,
			namespace: "hobo-dev",
		});

		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-oci-pact-"));
		try {
			const wasmPath = join(hoboHome, "guest.wasm");
			await writeFile(wasmPath, Buffer.from("\0asm\x01\x00\x00\x00api"));
			// prove pack still works alongside pact transport
			const packed = packWasmAsOci({
				hoboHome,
				resourceName: "api",
				wasmPath,
			});
			expect(packed.digest).toMatch(/^sha256:/);

			const ensure = await host.ensure({ hoboHome });
			expect(ensure.ready).toBe(true);
			expect(ensure.details?.transport).toBe("KubernetesClusterApi");

			const serve = await host.servePrivate({
				hoboHome,
				projectDir: hoboHome,
				bindleEnv: { GREETING_PREFIX: "howdy" },
				privateComponents: [
					{ resourceName: "api", projectDir: hoboHome, wasmPath },
				],
			});
			const body = await (
				await mustGet(
					serve.handlers,
					"api",
					"serve.handlers",
				)(new Request("http://mesh/hello?name=Oci"))
			).json();
			expect(body).toEqual({
				message: "howdy, Oci",
				greetingPrefix: "howdy",
			});
			expect(serve.isolation.details?.transport).toBe("KubernetesClusterApi");
			await serve.close();
		} finally {
			await rm(hoboHome, { recursive: true, force: true });
		}
	});
});
