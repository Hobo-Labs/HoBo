import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

// HOBO-720: `hobo add runner-depot` completes the M3 trio — with github,
// blacksmith and depot all registered, the Dispatcher cost-routes each
// job/build across three real execution hosts (ADR-0071).

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("hobo add runner-depot (remote-build catalog entry)", () => {
	it("installs the third execution host of the M3 trio", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		for (const provider of [
			"runner-github",
			"runner-blacksmith",
			"runner-depot",
		]) {
			const result = envelope(
				(await cli.run(["add", provider, "--json"])).stdout,
			);
			expect(result.ok).toBe(true);
			expect(result.data.approved).toBe(true);
		}

		const providers = runtime.registry.providers();
		expect(providers).toContain("@hobo/runner-github");
		expect(providers).toContain("@hobo/runner-blacksmith");
		expect(providers).toContain("@hobo/runner-depot");
	});
});
