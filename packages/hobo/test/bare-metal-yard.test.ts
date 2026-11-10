import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBindleDefinition } from "@hobo/cli";
import { must } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";
import {
	composeBareMetalTopology,
	INTERNAL_MESH_HOST,
	initBareMetalYard,
	loadBareMetalYardConfig,
	openBareMetalYard,
	serveProjectOnBareMetalYard,
} from "../src/index.js";

const helloBindleDir = fileURLToPath(
	new URL("../../../examples/hello-bindle", import.meta.url),
);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

describe("bare-metal yard e2e", () => {
	it("hobo yard init writes the default bare-metal config", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-home-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));

		const cli = createComposedHoboCli();
		const init = await cli.run(
			["yard", "init", "--home", hoboHome, "--port", "4100", "--json"],
			{ cwd: hoboHome },
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const envelope = JSON.parse(init.stdout) as {
			ok: boolean;
			code: string;
			data: { config: { name: string; defaultPort: number; kind: string } };
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.code).toBe("HOBO_YARD_INIT");
		expect(envelope.data.config.kind).toBe("bare-metal");
		expect(envelope.data.config.name).toBe("local");
		expect(envelope.data.config.defaultPort).toBe(4100);
		// Broker-runtime prefers wasm when tooling can be equipped.
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(envelope.data.config as { componentHost?: string }).componentHost,
		).toMatch(/^(local|wasm|oci|cloud-native)$/);

		const loaded = loadBareMetalYardConfig(hoboHome);
		expect(loaded?.providerId).toBe("local");
		expect(loaded?.defaultPort).toBe(4100);
	});

	it("composes a real Camp/Yard from the hello-bindle definition", async () => {
		const definition = await loadBindleDefinition(helloBindleDir);
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe("hello-bindle");

		const dataDir = await mkdtemp(join(tmpdir(), "hobo-yard-data-"));
		cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

		const topology = composeBareMetalTopology(must(definition), {
			dataDir,
		});
		expect(topology.kind).toBe("yard");
		expect(topology.providerId).toBe("local");
		expect(topology.camps).toHaveLength(1);
		// Camp no longer owns the Bindle; it inherits provider from the Yard.
		expect(topology.camps[0]?.derivedProviderId).toBe("local");
		expect(topology.camps[0]?.labels.bindle).toBe("hello-bindle");
		// SAFETY: assertion required at this I/O or test boundary.
		expect((topology.camps[0] as { bindle?: unknown }).bindle).toBeUndefined();
	});

	it("exposes only the web endpoint; api stays on the private mesh", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-home-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome });

		const basePort = 18000 + Math.floor(Math.random() * 1000);
		const serve = await serveProjectOnBareMetalYard({
			projectDir: helloBindleDir,
			hoboHome,
			port: basePort,
		});
		cleanups.push(() => serve.close());

		expect(serve.bindleName).toBe("hello-bindle");
		expect(serve.yard.providerId).toBe("local");

		// Exactly one public surface.
		expect(serve.exposedEndpoints).toHaveLength(1);
		expect(serve.exposedEndpoints[0]?.resourceName).toBe("web");
		expect(serve.exposedEndpoints[0]?.external).toBe(true);
		expect(serve.exposedEndpoints[0]?.port).toBe(basePort);
		expect(serve.primaryUrl).toBe(`http://127.0.0.1:${basePort}`);

		// API is private mesh — no TCP port.
		const api = serve.endpoints.find((e) => e.resourceName === "api");
		expect(api?.external).toBe(false);
		expect(api?.port).toBeNull();
		expect(api?.url).toBe(`http://hello-bindle.${INTERNAL_MESH_HOST}/api`);
		expect(serve.serviceDiscovery.services__api__http__0).toBe(
			`http://hello-bindle.${INTERNAL_MESH_HOST}/api`,
		);

		// Public TCP must not answer on basePort+1 (legacy dual-port posture).
		await expect(
			fetch(`http://127.0.0.1:${basePort + 1}/hello?name=Yard`, {
				signal: AbortSignal.timeout(500),
			}),
		).rejects.toThrow();

		// Bindle injects camp env — proves api + web are actually running under HoBo.
		expect(serve.bindleEnv).toEqual({
			GREETING_PREFIX: "howdy",
			APP_TITLE: "howdy",
		});

		// Web (public) calls private api via mesh; both surfaces use injected "howdy".
		const web = await fetch(`${serve.primaryUrl}/?name=Yard`);
		expect(web.status).toBe(200);
		const html = await web.text();
		expect(html).toContain('data-testid="app-title">howdy</h1>');
		expect(html).toContain('data-testid="greeting">howdy, Yard</p>');

		// Private mesh URL works through camp-routed fetch; no public TCP for api.
		const mesh = await fetch(
			`${serve.serviceDiscovery.services__api__http__0}/hello?name=Mesh`,
		);
		expect(await mesh.json()).toEqual({
			message: "howdy, Mesh",
			greetingPrefix: "howdy",
		});
	});

	it("hobo dev --once runs the bare-metal serve path for hello-bindle", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-home-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		initBareMetalYard({ hoboHome });

		const cli = createComposedHoboCli();
		const previous = process.env.HOBO_HOME;
		process.env.HOBO_HOME = hoboHome;
		try {
			const result = await cli.run(
				["dev", "--once", "--port", "0", "--cwd", helloBindleDir, "--json"],
				{ cwd: helloBindleDir },
			);
			// SAFETY: assertion required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				code: string;
				data: {
					mode: string;
					bindleName: string;
					serviceDiscovery: Record<string, string>;
					exposedEndpoints?: Array<{ resourceName: string; external: boolean }>;
					endpoints: Array<{
						resourceName: string;
						external: boolean;
						port: number | null;
					}>;
					served: { status: number; body: string };
				};
			};
			expect(envelope.code).not.toBe("HOBO_CLI_STUB");
			expect(envelope.data.mode).toBe("local-yard");
			expect(envelope.data.bindleName).toBe("hello-bindle");
			expect(envelope.data.serviceDiscovery.services__api__http__0).toBe(
				`http://hello-bindle.${INTERNAL_MESH_HOST}/api`,
			);
			expect(envelope.data.exposedEndpoints).toEqual([
				expect.objectContaining({ resourceName: "web", external: true }),
			]);
			expect(envelope.data.endpoints[0]?.port).not.toBe(0);
			const apiEp = envelope.data.endpoints.find(
				(e) => e.resourceName === "api",
			);
			expect(apiEp?.external).toBe(false);
			expect(apiEp?.port).toBeNull();
			expect(envelope.data.served.status).toBe(200);
			expect(envelope.data.served.body).toContain("howdy");
			expect(envelope.data.served.body).toContain("howdy, world");
			expect(envelope.ok).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.HOBO_HOME;
			else process.env.HOBO_HOME = previous;
		}
	});

	it("openBareMetalYard auto-inits when missing", () => {
		const hoboHome = join(tmpdir(), `hobo-auto-${Date.now()}`);
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const yard = openBareMetalYard({ hoboHome });
		cleanups.push(() => yard.close());
		expect(yard.config.kind).toBe("bare-metal");
		expect(loadBareMetalYardConfig(hoboHome)?.name).toBe("local");
	});
});
