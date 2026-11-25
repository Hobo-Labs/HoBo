import type { CliContext } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultYardRuntime,
	createRegistryCommand,
} from "../src/index.js";

// `hobo registry` lists the live PlannerRegistry — the provider + capability
// catalog the Planner matches deployments against.

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("createRegistryCommand", () => {
	it("lists the registered providers and their ports with a catalog hash", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const registry = envelope((await cli.run(["registry", "--json"])).stdout);
		expect(registry.code).not.toBe("HOBO_CLI_STUB");
		expect(registry.ok).toBe(true);
		expect(registry.status).toBe("ok");
		expect(registry.data.catalogHash).toBeTruthy();
		// The default runtime registers the Cloudflare provider.
		expect(registry.data.providers.length).toBeGreaterThan(0);
		const provider = registry.data.providers[0];
		expect(provider.providerId).toBeTruthy();
		expect(provider.ports.length).toBeGreaterThan(0);
		expect(registry.data.definitionCount).toBeGreaterThan(0);
	});

	it("is deterministic: the catalog hash is stable across calls", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const a = envelope((await cli.run(["registry", "--json"])).stdout);
		const b = envelope((await cli.run(["registry", "--json"])).stdout);
		expect(a.data.catalogHash).toBe(b.data.catalogHash);
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createRegistryCommand().run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: "/tmp", projectDir: "/tmp" } as CliContext,
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { cwd: "/tmp" } as never,
			args: [],
			verb: "registry",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
