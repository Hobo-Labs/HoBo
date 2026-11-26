import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

// HOBO-719: `hobo add runner-blacksmith` registers the Blacksmith fast-runner
// execution-host adapter alongside runner-github so the Dispatcher can
// cost-route the same job shape across both (ADR-0071).

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("hobo add runner-blacksmith (fast-runner catalog entry)", () => {
	it("installs both execution-host ports next to runner-github", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const github = envelope(
			(await cli.run(["add", "runner-github", "--json"])).stdout,
		);
		expect(github.ok).toBe(true);

		const blacksmith = envelope(
			(await cli.run(["add", "runner-blacksmith", "--json"])).stdout,
		);
		expect(blacksmith.ok).toBe(true);
		expect(blacksmith.status).toBe("installed");
		expect(blacksmith.data.approved).toBe(true);
		expect(blacksmith.data.ports).toEqual([
			"hobo:build-machine",
			"hobo:runner",
		]);

		expect(runtime.registry.providers()).toContain("@hobo/runner-blacksmith");
		expect(runtime.registry.providers()).toContain("@hobo/runner-github");
	});
});
