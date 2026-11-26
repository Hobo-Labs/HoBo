import { describe, expect, it } from "vitest";

import {
	CONTRACT,
	proveRecordStorePlay,
} from "../src/session-replay-contracts.js";

describe("session-replay-contracts technical proof", () => {
	it("exposes stable contract ids", () => {
		expect(CONTRACT.package).toBe("@hobo/replay");
		expect(CONTRACT.schema).toBe("hobo.replay/v1");
		expect(CONTRACT.lifecycle.Started).toBe("replay.Started");
	});

	it("record → store → end under dual fixtures", async () => {
		const result = await proveRecordStorePlay();
		expect(result.ok).toBe(true);
		expect(result.chunkCount).toBeGreaterThan(0);
		expect(result.eventTypes).toContain("replay.ChunkIngested");
		expect(result.eventTypes).toContain("replay.Ended");
	});
});
