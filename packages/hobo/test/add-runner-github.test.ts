import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

// HOBO-718: `hobo add runner-github` registers the GitHub Actions
// execution-host adapter — BOTH `hobo:runner` and `hobo:build-machine` ports
// from one Capability Manifest snapshot — and approves it for Dispatcher
// routing (HOBO-710 registry model).

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("hobo add runner-github (execution-host catalog entry)", () => {
	it("installs and approves both execution-host ports in one add", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const result = envelope(
			(await cli.run(["add", "runner-github", "--json"])).stdout,
		);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("installed");
		expect(result.data.approved).toBe(true);
		expect(result.data.ports).toEqual(["hobo:build-machine", "hobo:runner"]);

		expect(runtime.registry.providers()).toContain("@hobo/runner-github");
		expect(runtime.registry.held?.()).toEqual([]);

		const again = envelope(
			(await cli.run(["add", "runner-github", "--json"])).stdout,
		);
		expect(again.status).toBe("already_installed");
	});
});
