import { describe, expect, it } from "vitest";

import { createBrowserEventStore } from "../../src/index.js";

describe("browser storage consumer boundary", () => {
	it("exposes DurableEventStore append/readAll", async () => {
		const store = await createBrowserEventStore({
			partitionId: "boundary",
			allowTransient: true,
		});
		await store.append("s", [{ type: "t.A", data: {} }], {
			expectedSeq: 0,
			actor: { kind: "system", id: "t" },
			tenant: "t",
		});
		let count = 0;
		for await (const _ of store.readAll()) count += 1;
		expect(count).toBe(1);
		store.close();
	});
});
