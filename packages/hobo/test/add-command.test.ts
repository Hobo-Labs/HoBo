import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CliContext } from "@hobo/cli";
import type { RegistrableProvider } from "@hobo/cloud";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	bootstrapDefaultProviders,
	createAddCommand,
	createComposedHoboCli,
	createDefaultYardRuntime,
	installableProviders,
	registerInstallable,
} from "../src/index.js";
import { createProviderFromPorts } from "../src/local-provider.js";

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("createAddCommand", () => {
	it("installs the local provider and registry then lists it", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const before = envelope((await cli.run(["registry", "--json"])).stdout);
		expect(
			before.data.providers.some(
				(p: { providerId: string }) => p.providerId === "local",
			),
		).toBe(false);

		const add = envelope((await cli.run(["add", "local", "--json"])).stdout);
		expect(add.code).not.toBe("HOBO_CLI_STUB");
		expect(add.ok).toBe(true);
		expect(add.status).toBe("installed");
		expect(add.data.provider).toBe("local");
		expect(add.data.ports.sort()).toEqual(["kv", "objectStore"]);

		const after = envelope((await cli.run(["registry", "--json"])).stdout);
		const local = after.data.providers.find(
			(p: { providerId: string }) => p.providerId === "local",
		);
		expect(local).toBeDefined();
		expect(local.source).toBe("installed");
		expect(local.ports.map((p: { port: string }) => p.port).sort()).toEqual([
			"kv",
			"objectStore",
		]);
	});

	it("is idempotent when the provider is already installed", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		await cli.run(["add", "local", "--json"]);
		const again = envelope((await cli.run(["add", "local", "--json"])).stdout);
		expect(again.ok).toBe(true);
		expect(again.status).toBe("already_installed");
	});

	it("rejects an unknown provider and lists what is available", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const bad = envelope((await cli.run(["add", "nope", "--json"])).stdout);
		expect(bad.ok).toBe(false);
		expect(bad.code).toBe("HOBO_ADD_UNKNOWN");
		expect(bad.data.available).toContain("local");
	});

	it("requires a provider argument", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const noArg = envelope((await cli.run(["add", "--json"])).stdout);
		expect(noArg.ok).toBe(false);
		expect(noArg.code).toBe("HOBO_ADD_NO_PROVIDER");
	});

	it("extends the installable catalog via registerInstallable", () => {
		registerInstallable("pg-local", () =>
			createProviderFromPorts("pg-local", ["database"]),
		);
		expect(installableProviders()).toContain("pg-local");
		expect(installableProviders()).toContain("local");
	});

	it("hobo add then hobo plan matches the installed provider with no restart", async () => {
		registerInstallable("pg-local", () =>
			createProviderFromPorts("pg-local", ["database"]),
		);
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const dir = await mkdtemp(path.join(tmpdir(), "hobo-add-plan-"));
		await writeFile(
			path.join(dir, "hobo.bindle.json"),
			`${JSON.stringify(
				{
					schema: "hobo.manifest/v1",
					componentHost: { kind: "wasmtime", version: "1.0.0" },
					resources: {
						service: {
							type: "component.v1",
							image: "oci://registry.example.com/hello@sha256:abc123",
							runtime: "wasm",
							exports: ["wasi:http/incoming-handler"],
							bind: ["ledger"],
						},
						ledger: { type: "data.v1", port: "hobo:database" },
					},
				},
				null,
				2,
			)}\n`,
		);

		try {
			const before = envelope(
				(await cli.run(["plan", "--json"], { cwd: dir })).stdout,
			);
			expect(before.ok).toBe(false);
			expect(before.data.remediations[0].code).toBe(
				"capability.port-unavailable",
			);

			const held = envelope(
				(await cli.run(["add", "pg-local", "--hold", "--json"], { cwd: dir }))
					.stdout,
			);
			expect(held.ok).toBe(true);
			expect(held.data.approved).toBe(false);

			const heldPlan = envelope(
				(await cli.run(["plan", "--json"], { cwd: dir })).stdout,
			);
			expect(heldPlan.ok).toBe(false);
			expect(heldPlan.data.remediations[0].code).toBe(
				"capability.provider-not-approved",
			);
			expect(heldPlan.data.remediations[0].suggestedProvider).toBe("pg-local");

			const approved = envelope(
				(await cli.run(["add", "pg-local", "--json"], { cwd: dir })).stdout,
			);
			expect(approved.status).toBe("approved");

			const plan = envelope(
				(await cli.run(["plan", "--json"], { cwd: dir })).stdout,
			);
			expect(plan.ok).toBe(true);
			const ledger = plan.data.resources.find(
				(r: { name: string }) => r.name === "ledger",
			);
			expect(ledger.provider).toBe("pg-local");

			const registry = envelope(
				(await cli.run(["registry", "--json"], { cwd: dir })).stdout,
			);
			const row = registry.data.providers.find(
				(p: { providerId: string }) => p.providerId === "pg-local",
			);
			expect(row.source).toBe("installed");
			expect(row.approved).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("bootstrapDefaultProviders records register+approve facts idempotently", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);

		const defaults: RegistrableProvider[] = [
			createProviderFromPorts("default-kv", ["kv"]),
		];
		const first = await bootstrapDefaultProviders(runtime, defaults);
		expect(first).toEqual(["default-kv"]);

		const second = await bootstrapDefaultProviders(runtime, defaults);
		expect(second).toEqual([]);

		expect(runtime.registry.held?.()).toEqual([]);
		expect(runtime.registry.providers()).toContain("default-kv");
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createAddCommand().run({
			context: { cwd: "/tmp", projectDir: "/tmp" } as CliContext,
			flags: { cwd: "/tmp" } as never,
			args: ["local"],
			verb: "add",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
