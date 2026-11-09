import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type GithubAssignmentLookup,
	authorizeStartFence,
	hashBindingSecret,
	runnerSlotName,
	START_FENCE_EXIT,
} from "../src/fleet-v2/start-fence.js";

const secret = randomBytes(48).toString("hex");

const executionKey = {
	githubJob: {
		kind: "github-job" as const,
		accountId: "hobo-labs",
		engineId: "gh-actions",
		installationId: "10",
		repositoryId: "101",
		runId: "900",
		jobId: "1",
		runAttempt: 1,
	},
};

const body = {
	slotId: "slot-1",
	claimId: "claim-1",
	bindingSecret: secret,
	accountId: "hobo-labs",
	runnerName: runnerSlotName("slot-1"),
	profileId: "trusted-linux-x64",
	executionKey,
};

function lookupReturning(
	value: { accountId: string } | undefined,
): GithubAssignmentLookup {
	return {
		async lookupAssignment(runnerName) {
			return value === undefined
				? undefined
				: { runnerName, accountId: value.accountId, executionKey };
		},
	};
}

describe("fleet v2 GitHub start fence", () => {
	it("uses deterministic runner slot names", () => {
		expect(runnerSlotName("slot-uuid")).toBe("hobo-slot-uuid");
	});

	it("rejects forged assignment account mismatch", async () => {
		const result = await authorizeStartFence(
			{ ...body, accountId: "other-account" },
			lookupReturning({ accountId: "hobo-labs" }),
		);
		expect(result.ok).toBe(false);
	});

	it("fails closed when GitHub reports no assignment", async () => {
		const result = await authorizeStartFence(body, lookupReturning(undefined));
		expect(result.ok).toBe(false);
	});

	it("accepts only an assignment the lookup confirms", async () => {
		const result = await authorizeStartFence(
			body,
			lookupReturning({ accountId: "hobo-labs" }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bindRequest.accountId).toBe("hobo-labs");
			expect(result.bindRequest.bindingSecret).toBe(secret);
		}
		expect(hashBindingSecret(secret)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects mistyped fields instead of coercing them", async () => {
		const mistyped = {
			...body,
			executionKey: {
				githubJob: { ...executionKey.githubJob, runAttempt: "1" },
			},
		};
		const result = await authorizeStartFence(
			mistyped,
			lookupReturning({ accountId: "hobo-labs" }),
		);
		expect(result.ok).toBe(false);
		const missing = { ...body, accountId: undefined };
		const missingResult = await authorizeStartFence(
			missing,
			lookupReturning({ accountId: "hobo-labs" }),
		);
		expect(missingResult.ok).toBe(false);
	});

	it("documents fail-closed hook exit codes", () => {
		expect(START_FENCE_EXIT.authorized).toBe(0);
		expect(START_FENCE_EXIT.rejected).toBeGreaterThan(0);
	});
});
