import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
} from "@hobo/contract-harness";
import { must, mustGet } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";
import {
	COMPONENT_HOST_KINDS,
	ensureAllRuntimeHosts,
	getRuntimeHost,
	initBareMetalYard,
	normalizeComponentHostKind,
	serveProjectOnHost,
} from "../src/index.js";

const helloBindleDir = fileURLToPath(
	new URL("../../../examples/hello-bindle", import.meta.url),
);

const ociContractsDir = fileURLToPath(
	new URL("../../runtimes/runtime-oci/contracts", import.meta.url),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

describe("host runtime packages setup", () => {
	it("normalizes legacy aliases", () => {
		expect(normalizeComponentHostKind("isolated-wasm")).toBe("wasm");
		expect(normalizeComponentHostKind("bare-metal")).toBe("local");
		expect(normalizeComponentHostKind("runtime-local")).toBe("local");
		expect(COMPONENT_HOST_KINDS).toEqual([
			"local",
			"wasm",
			"oci",
			"cloud-native",
		]);
	});

	it("ensureAllRuntimeHosts marks each kind ready", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-hosts-ensure-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const results = await ensureAllRuntimeHosts({
			hoboHome,
			env: { ...process.env, HOBO_HOME: hoboHome },
		});
		expect(results.map((r) => r.kind).sort()).toEqual(
			["cloud-native", "local", "oci", "wasm"].sort(),
		);
		// oci ensure is ready when kubectl client probes (cluster optional).
		for (const result of results) {
			if (result.kind === "oci" && !result.ready) {
				// Without kubectl binary, oci may report not ready — still a valid host.
				expect(result.notes.join(" ")).toMatch(/kubectl|cluster|oci/i);
				continue;
			}
			expect(result.ready, result.kind).toBe(true);
		}
	}, 180_000);

	it.each([
		...COMPONENT_HOST_KINDS,
	])("yard init --host %s writes config", async (kind) => {
		const hoboHome = await mkdtemp(join(tmpdir(), `hobo-init-${kind}-`));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const { config } = initBareMetalYard({
			hoboHome,
			componentHost: kind,
		});
		expect(config.componentHost).toBe(kind);
		const host = getRuntimeHost(kind);
		expect(host.kind).toBe(kind);
		const ensure = await host.ensure({
			hoboHome,
			env: { ...process.env, HOBO_HOME: hoboHome },
		});
		if (kind === "oci" && !ensure.ready) {
			expect(ensure.notes.join(" ")).toMatch(/kubectl|cluster|oci/i);
		} else {
			expect(ensure.ready).toBe(true);
		}
	}, 180_000);

	it("cloud-native host serves hello-bindle with howdy env", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-parity-cn-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome, componentHost: "cloud-native" });
		const port = 26000 + Math.floor(Math.random() * 500);
		const serve = await serveProjectOnHost({
			projectDir: helloBindleDir,
			hoboHome,
			port,
			componentHost: "cloud-native",
		});
		cleanups.push(() => serve.close());
		expect(serve.componentHost).toBe("cloud-native");
		expect(serve.bindleEnv).toEqual({
			GREETING_PREFIX: "howdy",
			APP_TITLE: "howdy",
		});
		const html = await (await fetch(`${serve.primaryUrl}/?name=Host`)).text();
		expect(html).toContain("howdy, Host");
		expect(serve.isolation?.isolateBoundary).toMatch(/cloud_native/);
	}, 180_000);

	it("oci host mesh hop uses kubectl PACT mock (no shell shim)", async () => {
		const { createKubectlKubernetesClient, createOciRuntimeHost } =
			await import("@hobo/runtime-oci");
		const pacts = await loadPactDirectory(join(ociContractsDir, "pacts"));
		const pact = pacts.find((p) => p.provider.name === "KubernetesClusterApi");
		expect(pact).toBeDefined();
		const mock = createMockProviderFromPact(must(pact, "pact"));
		const k8s = createKubectlKubernetesClient({
			namespace: "hobo-dev",
			transport: mock,
		});
		const host = createOciRuntimeHost({
			kubernetes: k8s,
			namespace: "hobo-dev",
		});
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-oci-pact-parity-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const wasmPath = join(hoboHome, "guest.wasm");
		await writeFile(wasmPath, Buffer.from("\0asm\x01\x00\x00\x00api"));

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
		cleanups.push(() => serve.close());
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
	}, 60_000);

	it("hobo yard ensure reports host matrix", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-cli-ensure-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const cli = createComposedHoboCli();
		const result = await cli.run(
			["yard", "ensure", "--home", hoboHome, "--json"],
			{ cwd: hoboHome },
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			code: string;
			data: { hosts: Array<{ kind: string; ready: boolean }> };
		};
		// ok may be false if kubectl missing for oci — still report four hosts.
		expect(envelope.data.hosts).toHaveLength(4);
		expect(envelope.data.hosts.map((h) => h.kind).sort()).toEqual(
			["cloud-native", "local", "oci", "wasm"].sort(),
		);
	}, 180_000);
});
