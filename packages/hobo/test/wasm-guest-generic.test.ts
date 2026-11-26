import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { must } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	bundleAppModuleAsWasiHttpGuest,
	preparePrivateWasmComponent,
	resolvePrivateWasmGuest,
} from "../src/wasm-sandbox.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

function fixtureProject(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-wasm-fixture-"));
	const hoboHome = mkdtempSync(join(tmpdir(), "hobo-home-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	cleanups.push(() => rmSync(hoboHome, { recursive: true, force: true }));
	for (const [rel, body] of Object.entries(files)) {
		const path = join(dir, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body, "utf8");
	}
	return { dir, hoboHome };
}

describe("generic private wasm resolution (any resource name)", () => {
	it("resolves src/<resourceName>.ts for arbitrary resources", () => {
		const { dir } = fixtureProject({
			"src/orders.ts": `export const app = { fetch: async () => new Response("ok") };\n`,
			"src/billing.ts": `export default { fetch: async () => new Response("bill") };\n`,
		});
		expect(
			resolvePrivateWasmGuest({ projectDir: dir, resourceName: "orders" })
				.appModulePath,
		).toMatch(/orders\.ts$/);
		expect(
			resolvePrivateWasmGuest({ projectDir: dir, resourceName: "billing" })
				.appModulePath,
		).toMatch(/billing\.ts$/);
		expect(
			resolvePrivateWasmGuest({ projectDir: dir, resourceName: "missing" })
				.appModulePath,
		).toBeNull();
	});

	it("honors modulePath override for non-default layouts", () => {
		const { dir } = fixtureProject({
			"src/services/inventory.ts": `export const handler = async () => new Response("inv");\n`,
		});
		const resolved = resolvePrivateWasmGuest({
			projectDir: dir,
			resourceName: "inventory",
			modulePath: "src/services/inventory.ts",
		});
		expect(resolved.appModulePath).toMatch(/services[/\\]inventory\.ts$/);
	});

	it("bundles modules that export app, default, handler, or resource name", async () => {
		const { dir } = fixtureProject({
			"src/orders.ts": `
export const app = {
  fetch(request) {
    const url = new URL(request.url);
    return new Response(JSON.stringify({
      resource: "orders",
      path: url.pathname,
      token: globalThis.process?.env?.API_TOKEN ?? null,
    }), { headers: { "content-type": "application/json" } });
  }
};
`,
			"src/catalog.ts": `
export default async function handler(request) {
  return new Response(JSON.stringify({ resource: "catalog", method: request.method }), {
    headers: { "content-type": "application/json" },
  });
}
`,
			"src/payments.ts": `
export const payments = {
  fetch() { return new Response(JSON.stringify({ resource: "payments" })); }
};
`,
		});

		const { readFileSync } = await import("node:fs");
		for (const name of ["orders", "catalog", "payments"] as const) {
			const out = join(dir, `out-${name}.mjs`);
			const resolved = resolvePrivateWasmGuest({
				projectDir: dir,
				resourceName: name,
			});
			expect(resolved.appModulePath).not.toBeNull();
			await bundleAppModuleAsWasiHttpGuest({
				projectDir: dir,
				resourceName: name,
				appModulePath: must(resolved.appModulePath),
				outPath: out,
			});
			// Guest is wasi:http fetch-event only (not Node-importable).
			const text = readFileSync(out, "utf8");
			expect(text).toContain("addEventListener");
			expect(text).toContain("x-hobo-bindle-env");
			expect(text).toContain(name);
		}
	});

	it("componentizes and serves an arbitrary private resource via wasmtime", async () => {
		const { dir, hoboHome } = fixtureProject({
			"src/orders.ts": `
export const app = {
  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "none";
    const tenant = globalThis.process?.env?.TENANT_ID || "anon";
    return new Response(JSON.stringify({
      resource: "orders",
      id,
      tenant,
    }), { headers: { "content-type": "application/json" } });
  }
};
`,
			"package.json": `{"type":"module","name":"fixture-orders"}`,
		});

		const prepared = await preparePrivateWasmComponent({
			projectDir: dir,
			resourceName: "orders",
			hoboHome,
		});
		expect(prepared.wasmPath.endsWith(".wasm")).toBe(true);

		const { bootWasmtimeSandbox } = await import("../src/wasm-sandbox.js");
		const { ensureWasmtimeBinary } = await import("../src/wasm-sandbox.js");
		const wt = await ensureWasmtimeBinary({ hoboHome });
		const sandbox = await bootWasmtimeSandbox({
			resourceName: "orders",
			wasmPath: prepared.wasmPath,
			wasmtimeBin: wt.binPath,
		});
		cleanups.push(() => {
			void sandbox.terminate();
		});

		// Simulate camp mesh env injection.
		const response = await sandbox.invoke(
			new Request("http://component.local/items?id=42", {
				headers: {
					"x-hobo-bindle-env": JSON.stringify({ TENANT_ID: "acme" }),
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			resource: "orders",
			id: "42",
			tenant: "acme",
		});
		await sandbox.terminate();
	}, 180_000);
});
