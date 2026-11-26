import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHoboCli } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

// End-to-end proof that the composition root replaces @hobo/cli's shell stubs.
// The bare @hobo/cli binary calls createHoboCli() un-injected, so the deploy
// verbs fall back to HOBO_CLI_STUB / status "not_implemented". The composed CLI
// injects the DEFAULT runtimes, so collect/plan/up/down/dev run the real
// in-process flow. LOCAL/MOCKED lane: runtime-local event store, in-process
// executor over a mock IaC backend, provider registry from
// @hobo/provider-cloudflare — no real cloud calls.

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions", "assets"],
		},
		sessions: { type: "data.v1", port: "kv" },
		assets: { type: "data.v1", port: "objectStore" },
	},
};

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

async function withProject(
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-app-e2e-"));
	await writeFile(
		path.join(dir, "hobo.bindle.json"),
		`${JSON.stringify(HELLO_BINDLE, null, 2)}\n`,
	);
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

interface Envelope {
	ok: boolean;
	verb: string;
	status: string;
	code?: string;
	// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
	data: JsonObject;
}

function envelope(stdout: string): Envelope {
	// SAFETY: assertion required at this I/O or test boundary.
	return JSON.parse(stdout) as Envelope;
}

function assertNotStub(e: Envelope): void {
	expect(e.status).not.toBe("not_implemented");
	expect(e.code).not.toBe("HOBO_CLI_STUB");
}

describe("composed hobo CLI runs the default local/mocked runtime end to end", () => {
	it("login -> collect -> plan -> up -> down never fall back to the shell stub", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			// login works un-injected (kept as @hobo/cli's default).
			const login = envelope(
				(await cli.run(["login", "--json"], { cwd })).stdout,
			);
			expect(login.ok).toBe(true);
			expect(login.status).toBe("ok");

			// collect emits the manifest IR (not a stub).
			const collect = envelope(
				(await cli.run(["collect", "--json"], { cwd })).stdout,
			);
			assertNotStub(collect);
			expect(collect.status).toBe("ok");
			expect(collect.data.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(collect.data.resources.length).toBeGreaterThan(0);

			// plan renders the content-addressed DeploymentPlan (not a stub).
			const plan = envelope(
				(await cli.run(["plan", "--json"], { cwd })).stdout,
			);
			assertNotStub(plan);
			expect(plan.ok).toBe(true);
			expect(plan.status).toBe("ok");
			expect(plan.data.planHash).toMatch(/^sha256:/);
			expect(plan.data.resources.length).toBe(3);

			// up drives the in-process Yard to deployment.Deployed (not a stub).
			const up = envelope((await cli.run(["up", "--json"], { cwd })).stdout);
			assertNotStub(up);
			expect(up.ok).toBe(true);
			expect(up.status).toBe("deployed");
			expect([...up.data.provisioned].sort()).toEqual([
				"assets",
				"service",
				"sessions",
			]);

			// down tears everything back down to destroyed on the SAME store.
			const down = envelope(
				(await cli.run(["down", "--json"], { cwd })).stdout,
			);
			assertNotStub(down);
			expect(down.ok).toBe(true);
			expect(down.status).toBe("destroyed");
			expect([...down.data.destroyed].sort()).toEqual([
				"assets",
				"service",
				"sessions",
			]);
		});
	});

	it("hobo dev serves the hello-bindle offline via the default DevRuntime (not a stub)", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			// Pin DevRuntime so this regression stays on the one-shot probe path
			// (no project bindle source → bare-metal serve falls back).
			const cli = createComposedHoboCli({
				yardRuntime: runtime,
				devRuntime: (
					await import("../src/compose.js")
				).createDefaultDevRuntime(),
			});

			const dev = envelope((await cli.run(["dev", "--json"], { cwd })).stdout);
			assertNotStub(dev);
			expect(dev.ok).toBe(true);
			expect(dev.status).toBe("serving");
			expect(dev.data.runtime).toBe("runtime-local");
			expect(dev.data.offline).toBe(true);
			expect(dev.data.served.status).toBe(200);
			expect(dev.data.served.body).toBe("hello world");
		});
	});

	it("the bare @hobo/cli binary still stubs the deploy verbs (the gap this app closes)", async () => {
		await withProject(async (cwd) => {
			const bare = createHoboCli();
			for (const verb of ["collect", "plan", "up", "down", "dev"]) {
				const e = envelope((await bare.run([verb, "--json"], { cwd })).stdout);
				expect(e.status).toBe("not_implemented");
				expect(e.code).toBe("HOBO_CLI_STUB");
			}
		});
	});
});
