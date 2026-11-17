import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	ExecutionClaimSchema,
	parseExecutionKey,
	RunnerSlotSchema,
	type StrictFleetStore,
} from "@hobo/ci/fleet-v2";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { createStartFenceHandler } from "../src/fleet-v2/start-handler.js";

const secret = "x".repeat(64);
const executionKey = {
	githubJob: {
		kind: "github-job",
		accountId: "account",
		engineId: "gh-actions",
		installationId: "10",
		repositoryId: "101",
		runId: "9",
		jobId: "1",
		runAttempt: 1,
	},
};
const body = {
	slotId: "slot-1",
	claimId: "claim-1",
	accountId: "account",
	profileId: "profile",
	runnerName: "hobo-slot-1",
	bindingSecret: secret,
	executionKey,
};
const slot = create(RunnerSlotSchema, {
	id: "slot-1",
	accountId: "account",
	profileId: "profile",
	runnerName: "hobo-slot-1",
	bindingSecretHash: createHash("sha256").update(secret).digest("hex"),
	state: "registered",
});
const claim = create(ExecutionClaimSchema, {
	id: "claim-1",
	runnerSlotId: "slot-1",
	profileId: "profile",
	state: "start-authorized",
	key: parseExecutionKey(JSON.stringify(executionKey)),
});
const assignment = {
	runnerName: body.runnerName,
	accountId: body.accountId,
	executionKey,
};
function request(value: typeof body) {
	return new Request("http://localhost/v2/fleet/start-fence", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	});
}
function fixture() {
	const runnerSlot = vi.fn(async () => slot);
	const bindStart = vi.fn(
		async (_input: Parameters<StrictFleetStore["bindStart"]>[0]) => ({
			claim,
			idempotent: false,
		}),
	);
	const lookupAssignment = vi.fn(async () => assignment);
	const lookupForSlot = vi.fn(async () => ({ lookupAssignment }));
	const executionClaimById = vi.fn(async () => claim);
	return {
		runnerSlot,
		bindStart,
		lookupAssignment,
		lookupForSlot,
		executionClaimById,
		handle: createStartFenceHandler({
			store: { runnerSlot, bindStart, executionClaimById },
			lookupForSlot,
		}),
	};
}
it("returns a matching receipt only after binding and a fresh assignment recheck", async () => {
	const f = fixture();
	const response = await f.handle(request(body));
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({
		ok: true,
		slotId: body.slotId,
		claimId: body.claimId,
		accountId: body.accountId,
		profileId: body.profileId,
		runnerName: body.runnerName,
		executionKey,
	});
	expect(f.bindStart).toHaveBeenCalledOnce();
	expect(f.lookupAssignment).toHaveBeenCalledTimes(2);
	expect(f.executionClaimById).toHaveBeenCalledWith(body.claimId);
});
it("rejects an invalid slot secret before querying GitHub", async () => {
	const f = fixture();
	const response = await f.handle(
		request({ ...body, bindingSecret: "z".repeat(64) }),
	);
	expect(response.status).toBe(403);
	expect(f.lookupForSlot).not.toHaveBeenCalled();
	expect(f.bindStart).not.toHaveBeenCalled();
});
it("rejects a malformed body before querying the store", async () => {
	const f = fixture();
	const response = await f.handle(
		new Request("http://localhost/v2/fleet/start-fence", {
			method: "POST",
			body: JSON.stringify({ ...body, claimId: 1 }),
		}),
	);
	expect(response.status).toBe(400);
	expect(f.runnerSlot).not.toHaveBeenCalled();
});
it("never returns a receipt when GitHub rejects the initial assignment", async () => {
	const f = fixture();
	f.lookupAssignment.mockResolvedValueOnce(undefined);
	const response = await f.handle(request(body));
	expect(response.status).toBe(403);
	expect(f.bindStart).not.toHaveBeenCalled();
});
it("does not issue a receipt when binding fails or is ambiguous", async () => {
	const f = fixture();
	f.bindStart.mockRejectedValueOnce(new Error("lost response"));
	const response = await f.handle(request(body));
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ ok: false });
});
it("refuses a mismatched or terminal stored claim", async () => {
	const f = fixture();
	f.bindStart.mockResolvedValueOnce({
		claim: create(ExecutionClaimSchema, { ...claim, state: "completed" }),
		idempotent: true,
	});
	const response = await f.handle(request(body));
	expect(response.status).toBe(503);
});
it("keeps a committed claim without issuing a receipt if assignment changes afterward", async () => {
	const f = fixture();
	f.lookupAssignment.mockResolvedValueOnce(assignment).mockResolvedValueOnce({
		...assignment,
		executionKey: { githubJob: { ...executionKey.githubJob, jobId: "2" } },
	});
	const response = await f.handle(request(body));
	expect(response.status).toBe(503);
	expect(f.bindStart).toHaveBeenCalledOnce();
	expect(await response.json()).toEqual({ ok: false });
});
it("withholds a receipt when the claim becomes terminal during the GitHub recheck", async () => {
	const f = fixture();
	f.executionClaimById.mockResolvedValueOnce(
		create(ExecutionClaimSchema, { ...claim, state: "completed" }),
	);
	const response = await f.handle(request(body));
	expect(response.status).toBe(503);
	expect(f.bindStart).toHaveBeenCalledOnce();
	expect(f.lookupAssignment).toHaveBeenCalledTimes(2);
	expect(await response.json()).toEqual({ ok: false });
});
it("rejects an oversized request before querying the store", async () => {
	const f = fixture();
	const response = await f.handle(
		request({ ...body, bindingSecret: "x".repeat(65536) }),
	);
	expect(response.status).toBe(413);
	expect(f.runnerSlot).not.toHaveBeenCalled();
});
it("rejects generated incorrect binding secrets before GitHub or store binding", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.string({ minLength: 32, maxLength: 80 }).filter((s) => s !== secret),
			async (value) => {
				const f = fixture();
				const response = await f.handle(
					request({ ...body, bindingSecret: value }),
				);
				expect(response.status).toBe(403);
				expect(f.lookupForSlot).not.toHaveBeenCalled();
				expect(f.bindStart).not.toHaveBeenCalled();
			},
		),
		{ seed: 614478, numRuns: 100 },
	);
});
