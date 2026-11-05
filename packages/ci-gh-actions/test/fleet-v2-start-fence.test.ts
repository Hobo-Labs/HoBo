import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	hashBindingSecret,
	parseStartFenceRequest,
	runnerSlotName,
	START_FENCE_EXIT,
} from "../src/fleet-v2/start-fence.js";

describe("fleet v2 GitHub start fence", () => {
	it("uses deterministic runner slot names", () => {
		expect(runnerSlotName("slot-uuid")).toBe("hobo-slot-uuid");
	});

	it("rejects forged assignment account mismatch", () => {
		const secret = randomBytes(48).toString("hex");
		expect(() =>
			parseStartFenceRequest({
				slotId: "slot-1",
				claimId: "claim-1",
				bindingSecret: secret,
				accountId: "other-account",
				runnerName: runnerSlotName("slot-1"),
				profileId: "trusted-linux-x64",
				executionKey: {
					githubJob: {
						kind: "github-job",
						accountId: "hobo-labs",
						engineId: "gh-actions",
						installationId: "10",
						repositoryId: "101",
						runId: "900",
						jobId: "1",
						runAttempt: 1,
					},
				},
			}),
		).toThrow();
	});

	it("accepts verified assignment payload with synthetic secret", () => {
		const secret = randomBytes(48).toString("hex");
		const parsed = parseStartFenceRequest({
			slotId: "slot-1",
			claimId: "claim-1",
			bindingSecret: secret,
			accountId: "hobo-labs",
			runnerName: runnerSlotName("slot-1"),
			profileId: "trusted-linux-x64",
			executionKey: {
				githubJob: {
					kind: "github-job",
					accountId: "hobo-labs",
					engineId: "gh-actions",
					installationId: "10",
					repositoryId: "101",
					runId: "900",
					jobId: "1",
					runAttempt: 1,
				},
			},
		});
		expect(parsed.bindingSecret).toBe(secret);
		expect(hashBindingSecret(secret)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("documents fail-closed hook exit codes", () => {
		expect(START_FENCE_EXIT.authorized).toBe(0);
		expect(START_FENCE_EXIT.rejected).toBeGreaterThan(0);
	});
});
