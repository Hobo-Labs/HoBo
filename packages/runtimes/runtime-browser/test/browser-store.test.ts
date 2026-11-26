import { describe, expect, it } from "vitest";

import {
	createBrowserEventStore,
	detectBrowserPersistence,
} from "../src/index.js";

describe("runtime-browser persistence policy", () => {
	it("detects unavailable OPFS without pretending durable success", () => {
		const result = detectBrowserPersistence({ allowTransient: false });
		// Node test env has no OPFS
		expect(["unavailable", "opfs-sahpool", "transient-memory"]).toContain(
			result.mode,
		);
		if (result.mode === "unavailable") {
			expect(result.reason).toMatch(/OPFS/i);
		}
	});

	it("opens transient store when allowed", async () => {
		const store = await createBrowserEventStore({
			partitionId: "test-partition",
			allowTransient: true,
		});
		const result = await store.append(
			"browser:1",
			[{ type: "browser.Ready", data: {} }],
			{
				expectedSeq: 0,
				actor: { kind: "system", id: "browser" },
				tenant: "t",
			},
		);
		expect(result.appended).toHaveLength(1);
		expect(result.firstPosition).toBe(1n);

		const positions: bigint[] = [];
		for await (const pe of store.readAll()) {
			positions.push(pe.position);
		}
		expect(positions).toEqual([1n]);
		store.close();
	});

	it("fails closed when durable required and OPFS missing in Node", async () => {
		await expect(
			createBrowserEventStore({
				partitionId: "must-be-durable",
				allowTransient: false,
			}),
		).rejects.toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
	});
});
