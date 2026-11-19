import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultYardRuntime,
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

describe("hobo add lakebed (held-by-default catalog posture)", () => {
	it("first add registers held; second add records the explicit approval", async () => {
		const runtime = createDefaultYardRuntime();
		openStores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });

		const first = envelope(
			(await cli.run(["add", "lakebed", "--json"])).stdout,
		);
		expect(first.ok).toBe(true);
		expect(first.status).toBe("installed");
		expect(first.data.approved).toBe(false);

		expect(runtime.registry.held?.()).toEqual([
			{
				providerId: "@hobo/provider-lakebed",
				ports: ["compute", "database", "kv", "objectStore"],
			},
		]);

		const second = envelope(
			(await cli.run(["add", "lakebed", "--json"])).stdout,
		);
		expect(second.status).toBe("approved");
		expect(runtime.registry.held?.()).toEqual([]);
		expect(runtime.registry.providers()).toContain("@hobo/provider-lakebed");
	});
});
