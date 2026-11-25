import type { CliContext } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultYardRuntime,
	createGenerateCommand,
} from "../src/index.js";

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("createGenerateCommand", () => {
	it("generates + registers a provider from a port spec, visible in registry", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const gen = envelope(
			(await cli.run(["generate", "acme-kv", "kv", "objectStore", "--json"]))
				.stdout,
		);
		expect(gen.code).not.toBe("HOBO_CLI_STUB");
		expect(gen.ok).toBe(true);
		expect(gen.status).toBe("generated");
		expect(gen.data.provider).toBe("acme-kv");
		expect(gen.data.ports.sort()).toEqual(["kv", "objectStore"]);
		expect(gen.data.manifest.providerId).toBe("acme-kv");

		const registry = envelope((await cli.run(["registry", "--json"])).stdout);
		const generated = registry.data.providers.find(
			(p: { providerId: string }) => p.providerId === "acme-kv",
		);
		expect(generated).toBeDefined();
		expect(generated.source).toBe("installed");
		expect(generated.ports.map((p: { port: string }) => p.port).sort()).toEqual(
			["kv", "objectStore"],
		);
	});

	it("defaults to a kv port when none is given", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const gen = envelope(
			(await cli.run(["generate", "solo", "--json"])).stdout,
		);
		expect(gen.ok).toBe(true);
		expect(gen.data.ports).toEqual(["kv"]);
	});

	it("refuses to overwrite an existing provider name", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		await cli.run(["generate", "dup", "kv", "--json"]);
		const again = envelope(
			(await cli.run(["generate", "dup", "kv", "--json"])).stdout,
		);
		expect(again.ok).toBe(false);
		expect(again.code).toBe("HOBO_GENERATE_EXISTS");
	});

	it("requires a name", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const noName = envelope((await cli.run(["generate", "--json"])).stdout);
		expect(noName.ok).toBe(false);
		expect(noName.code).toBe("HOBO_GENERATE_NO_NAME");
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createGenerateCommand().run({
			context: { cwd: "/tmp", projectDir: "/tmp" } as CliContext,
			flags: { cwd: "/tmp" } as never,
			args: ["x"],
			verb: "generate",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
