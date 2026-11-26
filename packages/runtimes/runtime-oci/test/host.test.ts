import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
} from "@hobo/contract-harness";
import { must, mustGet } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	createKubectlKubernetesClient,
	createOciRuntimeHost,
	packWasmAsOci,
	WASM_COMPONENT_MEDIA_TYPE,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../contracts",
);

describe("@hobo/runtime-oci (PACT-backed kubectl boundary)", () => {
	it("packs wasm as local OCI layout", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-oci-pack-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const wasmPath = join(hoboHome, "guest.wasm");
		await writeFile(wasmPath, Buffer.from("\0asm\x01\x00\x00\x00fake"));
		const packed = packWasmAsOci({
			hoboHome,
			resourceName: "api",
			wasmPath,
		});
		expect(packed.mediaType).toBe(WASM_COMPONENT_MEDIA_TYPE);
		expect(packed.imageRef).toContain("oci://hobo.local/api@sha256:");
		expect(packed.digest).toMatch(/^sha256:/);
	});

	it("servePrivate uses pact mock transport (no shell shim)", async () => {
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

		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-oci-serve-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const wasmPath = join(hoboHome, "guest.wasm");
		await writeFile(wasmPath, Buffer.from("\0asm\x01\x00\x00\x00api"));

		const ensure = await host.ensure({ hoboHome });
		expect(ensure.ready).toBe(true);
		expect(ensure.details?.mode).toBe("kubectl");
		expect(ensure.details?.transport).toBe("KubernetesClusterApi");

		const serve = await host.servePrivate({
			hoboHome,
			projectDir: hoboHome,
			bindleEnv: { GREETING_PREFIX: "howdy" },
			privateComponents: [
				{ resourceName: "api", projectDir: hoboHome, wasmPath },
			],
		});
		cleanups.push(() => serve.close());
		expect(serve.isolation.details?.client).toBe("kubectl");
		const res = await mustGet(
			serve.handlers,
			"api",
			"serve.handlers",
		)(new Request("http://mesh/hello?name=Oci"));
		expect(await res.json()).toEqual({
			message: "howdy, Oci",
			greetingPrefix: "howdy",
		});
	});
});
