import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createPulumiAutomationAdapter,
	validateIacProgram,
} from "@hobo/iac-pulumi";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
	type PulumiAutomationAdapter,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

// E2E proof that the composed `hobo up`/`down` drives the REAL @hobo/iac-pulumi
// adapter via the REAL @hobo/provider-cloudflare `realize()` — no mock
// IacProvider. We inject a SPY that wraps the real adapter (so the real code path
// runs) and records the declarative `hobo.iac-program/v1` programs handed to it;
// each recorded program must pass the adapter's own `validateIacProgram`.

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

interface SpyAdapter extends PulumiAutomationAdapter {
	readonly previewed: unknown[];
	readonly applied: unknown[];
	readonly destroyed: unknown[];
}

// Wrap the REAL adapter; delegate every call to it (real code path) while
// recording the exact program each method received.
function spyOnRealAdapter(): SpyAdapter {
	// SAFETY: assertion required at this I/O or test boundary.
	const real = createPulumiAutomationAdapter() as PulumiAutomationAdapter;
	const previewed: unknown[] = [];
	const applied: unknown[] = [];
	const destroyed: unknown[] = [];
	return {
		id: real.id,
		previewed,
		applied,
		destroyed,
		async preview(program) {
			previewed.push(program);
			return real.preview(program);
		},
		async apply(program) {
			applied.push(program);
			return real.apply(program);
		},
		async destroy(program) {
			destroyed.push(program);
			return real.destroy(program);
		},
		async refresh(program) {
			return real.refresh(program);
		},
	};
}

interface Envelope {
	ok: boolean;
	status: string;
	code?: string;
	// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
	data: JsonObject;
}

function envelope(stdout: string): Envelope {
	// SAFETY: assertion required at this I/O or test boundary.
	return JSON.parse(stdout) as Envelope;
}

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

async function withProject(
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-real-iac-"));
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

describe("composed hobo up/down drives the REAL @hobo/iac-pulumi adapter", () => {
	it("up realizes each resource and applies it through the real adapter, reaching deployment.Deployed", async () => {
		await withProject(async (cwd) => {
			const adapter = spyOnRealAdapter();
			const runtime = createDefaultYardRuntime({ iacAdapter: adapter });
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const up = envelope((await cli.run(["up", "--json"], { cwd })).stdout);
			expect(up.ok).toBe(true);
			expect(up.status).toBe("deployed");
			expect([...up.data.provisioned].sort()).toEqual([
				"assets",
				"service",
				"sessions",
			]);

			// The real adapter's apply ran once per resource (3), and every program
			// handed to it is a valid `hobo.iac-program/v1` program that the
			// adapter's own validateIacProgram accepts (i.e. it came from the real
			// provider.realize(), not the kernel's shape-A execution descriptor).
			expect(adapter.applied.length).toBe(3);
			expect(adapter.previewed.length).toBeGreaterThanOrEqual(3);
			for (const program of adapter.applied) {
				expect(() => validateIacProgram(program)).not.toThrow();
				// SAFETY: assertion required at this I/O or test boundary.
				expect((program as { apiVersion: string }).apiVersion).toBe(
					"hobo.iac-program/v1",
				);
				// SAFETY: assertion required at this I/O or test boundary.
				expect((program as { kind: string }).kind).toBe("iac-program");
				// SAFETY: assertion required at this I/O or test boundary.
				expect((program as { provider: string }).provider).toBe("pulumi");
			}

			// Observable adapter effect: applied outputs (real per-resource-stack
			// bindings) flowed back and were recorded on the deployment.
			const down = envelope(
				(await cli.run(["down", "--json"], { cwd })).stdout,
			);
			expect(down.ok).toBe(true);
			expect(down.status).toBe("destroyed");
			expect([...down.data.destroyed].sort()).toEqual([
				"assets",
				"service",
				"sessions",
			]);

			// down tore each resource down through the real adapter's destroy.
			expect(adapter.destroyed.length).toBe(3);
			for (const program of adapter.destroyed) {
				expect(() => validateIacProgram(program)).not.toThrow();
			}
		});
	});
});
