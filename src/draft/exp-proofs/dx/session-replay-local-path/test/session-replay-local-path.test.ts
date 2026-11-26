import { describe, expect, it } from "vitest";

import { proveLocalReplayPath } from "../src/session-replay-local-path.js";

describe("session-replay local DX path", () => {
	it("records, masks, summarizes, and builds evidence under dual fixtures", async () => {
		const proof = await proveLocalReplayPath();
		expect(proof.ok).toBe(true);
		expect(proof.killSwitchWorks).toBe(true);
		expect(proof.autowireLocalDefault).toBe(true);
		expect(proof.evidenceSchema).toBe("hobo.replay-evidence/v1");
		expect(proof.openUiKind).toBe("hobo.replay.player");
		expect(proof.summary).toContain("err-dx-1");
	});
});
